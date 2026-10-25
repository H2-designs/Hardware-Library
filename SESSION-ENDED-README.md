# SESSION_ENDED - the vend the machine never finished

hardware-lib 8.2.4, 24 October 2026. One failure reason explained on its own, because it is the one that costs money
when the app gets it wrong. Companion files: `VENDLISTENER-README.md` (the full handler), `IMPLEMENTATION-README.md`.

## 1. The scenario

The customer picks an item. The machine sends VEND REQUEST. The app authorizes the card and approves, or is still
at the gateway. Then the machine closes the session without ever saying how the vend ended: no VEND SUCCESS, no
VEND FAILURE, no VEND CANCEL. It just sends SESSION COMPLETE.

Machines do this when the customer walks away, when their own selection timer runs out, or when the dispense fails
in a way their firmware does not report. From the bus it looks like a normal session close. From the app it looks
like a vend that never got an answer.

## 2. What happens on the bus

| step | VMC sends | reader answers | library |
|---|---|---|---|
| 1 | VEND REQUEST `13 00 price item` | ACK | vend open; **onVendRequest** to the app |
| 2 | POLL ... | ACK, or VEND APPROVED once the app called `approveVend()` | waiting for the machine's result |
| 3 | SESSION COMPLETE `13 04` | ACK | END SESSION armed for the next POLL; the vend is still marked open |
| 4 | POLL | END SESSION | the session is now really over, so the open vend is closed here |

At step 4 the library fires **onVendFailure** once, with `HardwareLib.lastVendFailureReason` = SESSION_ENDED.

Log lines you will see, in this order:

```
VEND REQUEST rx=13 00 02 BC 00 00 tx=ACK
[app] approveVend armed - VEND APPROVED goes out on the next POLL        (if the app approved)
POLL tx=VEND APPROVED
VEND SESSION COMPLETE rx=13 04 tx=ACK
[mdb] vend failed: SESSION_ENDED - onVendFailure fires
POLL tx=END SESSION
```

## 3. Why it fires at END SESSION and not at SESSION COMPLETE

Between steps 3 and 4 the machine could still send VEND SUCCESS or VEND FAILURE. Both are answered in every state
since 8.2.1, and either would close the vend with its own reason. END SESSION going out is the last moment at which
the vend can be declared dead with certainty, so that is where the callback sits. The delay is one POLL, 50 to
100 ms, nothing the customer notices.

## 4. What the app must do in that callback

- If you had already called `approveVend()`, money is held or captured for a product you cannot prove came out.
  **Reverse it.**
- If you had not approved yet, the gateway may still hold the amount. **Void it.**
- Either way close the payment screen. Nothing else will arrive for this vend.

This is why the handler must reverse on SESSION_ENDED and not only on FAILED. The machine never said "failed". It
just left. The same applies to RESET, the other reason where the dispense result is unknown.

```kotlin
override fun onVendFailure() {
    val reason = HardwareLib.lastVendFailureReason      // first line, one global slot
    when (reason) {
        HardwareLib.VendFailureReason.CANCELLED_BY_VMC -> if (approved) gateway.reverse() else gateway.voidHold()  // the machine cancelled
        HardwareLib.VendFailureReason.FAILED -> gateway.reverse()                                                 // product not dispensed
        HardwareLib.VendFailureReason.SESSION_ENDED,
        HardwareLib.VendFailureReason.RESET -> if (approved) gateway.reverse() else gateway.voidHold()            // result unknown
        HardwareLib.VendFailureReason.CANCELLED_BY_APP, null -> gateway.voidHold()                               // not delivered since 8.2.2
    }
    ui.resetToIdle()
}
```

The full handler with the sale record that tracks `approved` is in `VENDLISTENER-README.md`, section 2.

## 5. Two related cases, so they are not confused with this one

- **Session ended before any VEND REQUEST.** The customer never picked anything. No vend was open, so nothing fires;
  the session just closes. Auto session mode opens the next one after the cooldown.
- **The machine never sends SESSION COMPLETE at all after a successful sale.** The opposite problem: VEND SUCCESS
  arrived, onVendSuccess fired, the money is captured, but the session stays open and the next customer cannot
  start. The **Force Session End** setting (`setForceSessionEnd:on`) exists for that machine. It does not apply
  here, and it changes nothing about SESSION_ENDED.

## 6. How often it happens, and on which machine

`vendStats` (dashboard **Vend** button) counts it: `vendFailuresByReason.SESSION_ENDED`. A machine where that counter
rises is one that closes sessions without a result. Keep the handler above and the money is always returned; the
counter tells you which machines to look at with the vendor.

## 7. Bench test, no machine

`simulateExchange` only drives the log pipeline, not the state machine, so it cannot produce this case. The RS232
path can, with the same VendListener and the same reason: a second vend request while the first is still open
closes the first with SESSION_ENDED. Load a one-rule table and send two requests:

```
{"setRs232Rules":[{"name":"T_REQUEST","rx":"A0 01 *","tx":"","amountStart":4,"amountEnd":-1,"event":"vendRequest"}]}
rs232Simulate:A0 01 00 03 37 30 30 95      -> onVendRequest(7.00)   (approve it in the app if you want the reverse path)
rs232Simulate:A0 01 00 03 37 30 30 95      -> onVendFailure with SESSION_ENDED for the first, then onVendRequest for the second
vendStats                                   -> failures=1 (SESSION_ENDED=1)
```

The app must show one onVendFailure with reason SESSION_ENDED and, if it had approved, one reversal at the gateway.
The full table for every reason is in `VENDLISTENER-README.md`, section 8.

## 8. In one sentence

SESSION_ENDED means the machine closed the session while a vend was still open; the library tells you once, at END
SESSION, and the app must give the money back as if the dispense had failed.
