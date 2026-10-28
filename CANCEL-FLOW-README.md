# Vend cancel - who can cancel, what the app hears, what goes on the bus

hardware-lib 8.2.12, 28 October 2026. The complete reference for every way a vend or a session can be cancelled, from
the machine, from the Android app and from the dashboard, and what the VendListener receives in each case. This
replaces the 8.2.2 rule that the app's own cancel was silent. Companion files: `VENDLISTENER-README.md` (the handler),
`SESSION-ENDED-README.md`, `API-REFERENCE.md`.

## 1. The rule since 8.2.5

**Every cancel reaches the app through `onVendFailure`, exactly once, and `lastVendFailureReason` says who cancelled.**

| who cancelled | how | reason the app reads | wire reply the reader sends |
|---|---|---|---|
| the machine | VEND CANCEL `13 01`, READER CANCEL `14 02`, or an RS232 rule with `event: vendCancel` | **CANCELLED_BY_VMC** | per the cancel mode: VEND DENIED, or SESSION CANCEL REQUEST on the next POLL |
| the Android app | `HardwareLib.cancelVend()` / `cancelVend(response)`, or `setAutoSession` from app code while a session is live | **CANCELLED_BY_APP** | the response you chose, or the standing cancel mode, on the next POLL |
| an operator | dashboard **Vend Cancel** button, the remote commands `cancelVend`, `cancelVend:sessionCancel`, `cancelVend:vendDenied`, or `setSessionMode` while a session is live | **CANCELLED_BY_OPERATOR** (new in 8.2.5) | same as the app's |

The other failure reasons are unchanged: FAILED (VEND FAILURE after approval), SESSION_ENDED (session closed with the
vend open), RESET (bus RESET or `stop()`).

Why the app is told about its own cancel again: between 8.2.2 and 8.2.4 the app's `cancelVend()` closed the vend
silently, so a cancel pressed on the dashboard by an operator was invisible to the app too, and its payment screen
stayed open. One rule for all three sources is simpler and safer: the app has one place that closes a vend, and the
reason tells it whether it needs to do anything about the money.

## 2. The sequence, each source

### Machine cancel (CANCELLED_BY_VMC)

| step | VMC sends | reader answers | library | app |
|---|---|---|---|---|
| 1 | VEND REQUEST | ACK | vend open | onVendRequest |
| 2 | VEND CANCEL `13 01` | ACK | vend closed, cancel reply armed | **onVendFailure**, CANCELLED_BY_VMC |
| 3 | POLL | VEND DENIED or SESSION CANCEL REQUEST (cancel mode) | | |
| 4 | SESSION COMPLETE | ACK, END SESSION on the next POLL | ENABLED | |

READER CANCEL `14 02` is the same with CAN as the immediate answer. With Cancel Retry on, an unanswered SESSION CANCEL
REQUEST is re-sent after 1000 ms.

### App cancel (CANCELLED_BY_APP)

| step | VMC sends | reader answers | library | app |
|---|---|---|---|---|
| 1 | VEND REQUEST | ACK | vend open | onVendRequest, gateway declines |
| 2 | | | app calls `cancelVend()`: vend closed, reply armed | **onVendFailure**, CANCELLED_BY_APP, fires at once |
| 3 | POLL | VEND DENIED or SESSION CANCEL REQUEST | | |
| 4 | SESSION COMPLETE | ACK, END SESSION on the next POLL | ENABLED | |

The callback fires when the cancel is armed, not when the reply goes out, so the app can reset its screen immediately.
`cancelVend()` returns `false` and fires nothing when no session is live.

### Operator cancel (CANCELLED_BY_OPERATOR)

Identical to the app cancel on the bus. The only difference is the reason, so the app knows it did not decide this:
a hold placed for the customer must be voided, and a payment screen must be closed, by the app, now.

Log lines, in order: `[operator] cancelVend armed - VEND DENIED goes out on the next POLL`, then
`[mdb] vend failed: CANCELLED_BY_OPERATOR - onVendFailure fires`, then `[remote] vend cancel requested - will send ...`.

### Cancel before any VEND REQUEST

If the session is open but the customer has not selected yet, `cancelVend()` from the app or the dashboard cancels
the session on the wire and **no callback fires**, because there is no vend to fail. Nothing was authorized, nothing
to clean up.

## 3. What the handler does with each reason

```kotlin
override fun onVendFailure(reason: HardwareLib.VendFailureReason) {   // 8.2.6: the reason comes with the callback
    scope.launch {
        when (reason) {
            HardwareLib.VendFailureReason.CANCELLED_BY_VMC,      // the machine cancelled
            HardwareLib.VendFailureReason.CANCELLED_BY_OPERATOR  // the dashboard cancelled
                -> if (approved) gateway.reverse() else gateway.voidHold()
            HardwareLib.VendFailureReason.CANCELLED_BY_APP       // our own cancelVend(): the decline is already handled
                -> { /* nothing to do at the gateway */ }
            HardwareLib.VendFailureReason.FAILED                 // product not dispensed
                -> gateway.reverse()
            HardwareLib.VendFailureReason.SESSION_ENDED,         // result unknown
            HardwareLib.VendFailureReason.RESET
                -> if (approved) gateway.reverse() else gateway.voidHold()
            null -> gateway.voidHold()
        }
        ui.resetToIdle()                                        // every reason ends here
    }
}
```

Two points that follow from the table:

- **CANCELLED_BY_APP needs no gateway action** if the app voided the hold before calling `cancelVend()`, which is the
  normal order (decline, void, cancel). It still needs the UI reset, and that is why the callback exists.
- **CANCELLED_BY_OPERATOR must void.** The operator pressed cancel while the customer may have had a hold placed. The
  app did not decide, so it has not voided anything yet.

Java and React Native: same branches, the React Native event carries the reason as the string
`'CANCELLED_BY_OPERATOR'`.

## 3a. Cancel grace (8.2.7)

A failure that arrives within 200 ms of its `onVendRequest` is delivered 500 ms later (350 ms before 8.2.10), so a request handler that
posts its screen to the UI thread has drawn it before the failure clears it. Order is kept (a new request flushes a
held failure first), the bus replies are not delayed, all reasons are covered. `setCancelGrace:WINDOW,DELAY`,
`setCancelGrace:off`; `vendStats` `failureDelayed`.

## 3a-ii. Vend event gap (8.2.11)

Besides the grace, every pair of `VendListener` callbacks is spaced by at least the vend event gap (default 500 ms,
`setVendEventGap:MS`, 0 = off): a failure, success or new request that would follow the previous callback sooner waits
for the remainder, in order. Configure it from the dashboard (Event gap field), Kotlin (`setVendEventGap`) or React
Native (`Mdb.setVendEventGap`). `vendStats` `eventsSpaced`.

## 3b. The late approval (8.2.8)

The payment that finishes a moment after the cancel is the dangerous one. Before 8.2.8 `approveVend()` only checked
that a request had arrived, so it armed VEND APPROVED for the cancelled vend; the cancel-reply POLL cleared the request
but not the approval, and the next VEND REQUEST of the same session (Jofemar / Vision, a VMC that ignores SESSION
CANCEL REQUEST) was approved with nobody paying. Now `approveVend()` returns **false** while a cancel reply or a session
end is armed, every machine-side end of a vend (VEND CANCEL, READER CANCEL, VEND FAILURE, SESSION COMPLETE, END SESSION)
and the cancel-reply POLL wipe the approve flag, and a new request never inherits one. The handler rule stays: when
`approveVend()` returns false, void the hold or reverse the capture. `vendStats` `approveAfterCancel` counts it.

## 3c. A new VEND REQUEST clears the old vend (8.2.9)

Whatever the previous vend left armed dies when the machine asks again: a stale approval, a cancel reply that had
not gone out yet (it would have denied the NEW vend), an END SESSION armed by SESSION COMPLETE (the machine kept the
session), and the previous vend itself if it was still open (`onVendFailure(CANCELLED_BY_VMC)` first, then the new
`onVendRequest`). `vendStats` `requestSupersededFlags` counts the drops.

## 4. Counters

`vendStats` (dashboard **Vend** button) shows the three sources apart:

| key | counts |
|---|---|
| `vendFailuresByReason.CANCELLED_BY_VMC` | machine cancels delivered to the app |
| `appCancels`, `vendFailuresByReason.CANCELLED_BY_APP` | the app's own `cancelVend()` that closed an open vend |
| `operatorCancels`, `vendFailuresByReason.CANCELLED_BY_OPERATOR` | dashboard / remote cancels that closed an open vend |
| `sessionCancelRetries`, `sessionCancelGaveUp` | SESSION CANCEL REQUESTs the machine ignored and the retry re-sent |

## 5. What changed in the library (8.2.5)

- `cancelVend(response)` now takes an internal reason: CANCELLED_BY_APP from the public call, CANCELLED_BY_OPERATOR
  from `handleCommand` (dashboard and backend commands) and from a session-mode switch issued remotely.
- Both paths call the same `abortOpenVend(reason)` the machine paths use, so the callback, the counters and the log
  line are identical in shape.
- New enum value `VendFailureReason.CANCELLED_BY_OPERATOR`. A Java `switch` without a `default` must add the case;
  the sample handlers have it.
- `[remote]` reply lines, such as the answer to `help`, `getSettings` acknowledgements and the `vendStats` summary,
  are no longer muted by the MQTT Logs switch. An operator command always answers. These lines travel on the `ops`
  channel since mqtt-lib 2.8.0, so the backend sees no change.
- Nothing else in the vend flow moved. The three-callback listener stays as it is.

## 6. Verify on the device

| action | expect in the app | expect in the log |
|---|---|---|
| machine VEND CANCEL after a request | onVendFailure, CANCELLED_BY_VMC | `[mdb] vend failed: CANCELLED_BY_VMC - onVendFailure fires` |
| app `cancelVend()` after a request | onVendFailure, CANCELLED_BY_APP | `[app] cancelVend armed ...` then `[mdb] vend failed: CANCELLED_BY_APP ...` |
| dashboard Vend Cancel after a request | onVendFailure, CANCELLED_BY_OPERATOR | `[operator] cancelVend armed ...` then `[mdb] vend failed: CANCELLED_BY_OPERATOR ...` |
| dashboard Vend Cancel, no request yet | nothing | `[operator] cancelVend armed ...` only |
| `vendStats` | | `appCancels=.. operatorCancels=..` and the reasons in `vendFailuresByReason` |

Not yet run on a real CM30. Compiled and API-checked.

## 7. Why `help` sometimes answered nothing (fixed in 8.2.5)

Until 8.2.4 every plain line from hardware-lib, including the answers to operator commands such as `help`, was gated
by the MQTT Logs switch. With Logs off the device executed the command and published nothing. With Logs on but an
old dashboard (before v8.2.2) the answer went to the `ops` channel the old dashboard does not read. 8.2.5 removes the
first cause: `[remote]` lines always go out. For the second, run dashboard v8.2.2 or newer; it has the **Vend** button
in the header.
