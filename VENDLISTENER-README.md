# VendListener - how to implement it, and how to fix the usual mistakes

hardware-lib 8.2.11, 28 October 2026. The payment hook is three callbacks. This document is the complete,
copy-ready implementation plus the fix for every mistake we have seen in the field. Companion files:
`IMPLEMENTATION-README.md` (the whole app), `API-REFERENCE.md`, `DUPLICATE-LOGS-README.md`.

## 1. The contract in one table

| callback | fires when | reason in `lastVendFailureReason` | money action |
|---|---|---|---|
| `onVendRequest(amount, minorUnits, itemNumber)` | the customer picked an item; the machine waits for your answer | - | authorize `minorUnits`, then `approveVend()` or `cancelVend()` |
| `onVendSuccess(itemNumber)` | the machine confirmed the product came out | - | capture |
| `onVendFailure()` | **the machine cancelled**: VEND CANCEL 13 01, READER CANCEL 14 02, or an RS232 rule with `event: vendCancel`. Customer pressed cancel, or the selection timed out | CANCELLED_BY_VMC | void the hold; reverse if you had already approved |
| `onVendFailure()` | VEND FAILURE after your approval: product not dispensed | FAILED | reverse |
| `onVendFailure()` | the machine closed the session with the vend still open, no success / failure / cancel | SESSION_ENDED | reverse if approved, else void |
| `onVendFailure()` | bus RESET or `stop()` with the vend open | RESET | reverse if approved, else void |
| `onVendFailure()` | your own `cancelVend()` (8.2.5: delivered again) | CANCELLED_BY_APP | nothing at the gateway, you already declined; reset the UI |
| `onVendFailure()` | an operator cancelled from the dashboard or a remote command (8.2.5) | CANCELLED_BY_OPERATOR | void the hold; reverse if you had approved; reset the UI |

Every VEND REQUEST gives exactly one `onVendSuccess` or one `onVendFailure`, whoever ended it. Since 8.2.5 that
includes your own `cancelVend()` and a dashboard cancel; the reason tells you which. `CANCEL-FLOW-README.md` has the
three cancel sources side by side.

## 2. The implementation, Kotlin

One object for the whole process, registered once at boot (`HardwareLib.vendListener = PaymentFlow`). Every
callback returns immediately; the gateway work runs on a coroutine (since 8.2.6 the callbacks are delivered in order on
one thread, so a blocking handler would hold back its own outcome). A small `Sale` record holds what we know about
the vend that is open right now, so the failure handler can decide between void and reverse without guessing.

```kotlin
object PaymentFlow : HardwareLib.VendListener {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Any()

    /** The vend that is open now. null = nothing open. */
    private class Sale(val minorUnits: Int, val item: Int) {
        var hold: GatewayHold? = null      // authorization result, once we have it
        var approved = false               // did we call approveVend() and did it arm
        var closed = false                 // success or failure already handled
    }
    @Volatile private var sale: Sale? = null

    // ---------------------------------------------------------------- 1. request
    override fun onVendRequest(amount: Double, minorUnits: Int, itemNumber: Int) {
        val s = Sale(minorUnits, itemNumber)
        synchronized(lock) { sale = s }          // a new request replaces any stale record
        ui.showPaying(amount)
        scope.launch {
            val hold = try { gateway.authorize(minorUnits) } catch (t: Throwable) { null }
            synchronized(lock) {
                if (sale !== s || s.closed) {            // the machine ended this vend while we were at the gateway
                    hold?.let { gateway.voidHold(it) }   // onVendFailure already ran (or will) - just release the money
                    return@launch
                }
                s.hold = hold
                if (hold == null) {
                    s.closed = true
                    sale = null
                    HardwareLib.cancelVend()              // onVendFailure comes back with CANCELLED_BY_APP (8.2.5) - nothing left to do there
                    ui.resetToIdle()
                    return@launch
                }
                s.approved = HardwareLib.approveVend()    // false = the machine cancelled / timed out first
                if (!s.approved) {
                    gateway.voidHold(hold)                // the machine will never dispense; onVendFailure handles the UI
                }
            }
        }
    }

    // ---------------------------------------------------------------- 2. success
    override fun onVendSuccess(itemNumber: Int) {
        val s = synchronized(lock) { sale?.also { it.closed = true; sale = null } } ?: return
        scope.launch {
            s.hold?.let { gateway.capture(it) }          // approved and dispensed: take the money
            ui.showThanks()
        }
    }

    // ---------------------------------------------------------------- 3. every machine-side failure
    override fun onVendFailure(reason: HardwareLib.VendFailureReason) {   // 8.2.6: the reason comes with the callback
        val s = synchronized(lock) { sale?.also { it.closed = true; sale = null } }
        scope.launch {
            val hold = s?.hold
            when (reason) {
                HardwareLib.VendFailureReason.CANCELLED_BY_VMC,         // the MACHINE cancelled (VEND CANCEL / READER CANCEL / RS232 CANCEL)
                HardwareLib.VendFailureReason.CANCELLED_BY_OPERATOR ->  // the DASHBOARD cancelled (8.2.5): we did not decide this
                    if (hold != null) { if (s.approved) gateway.reverse(hold) else gateway.voidHold(hold) }
                HardwareLib.VendFailureReason.CANCELLED_BY_APP -> {}    // our own cancelVend(): the decline was handled where we called it
                HardwareLib.VendFailureReason.FAILED ->                 // VEND FAILURE after approval: product not dispensed
                    hold?.let { gateway.reverse(it) }
                HardwareLib.VendFailureReason.SESSION_ENDED,            // session closed with the vend open: result unknown
                HardwareLib.VendFailureReason.RESET ->                  // RESET / stop() with the vend open: result unknown
                    if (hold != null) { if (s.approved) gateway.reverse(hold) else gateway.voidHold(hold) }
                null -> hold?.let { gateway.voidHold(it) }
            }
            ui.resetToIdle()
            log("vend failed: $reason approved=${s?.approved} hold=${hold != null}")
        }
    }
}
```

What each piece protects against:

- **`sale !== s` check after the gateway returns.** The machine can cancel while the card is being read. By the
  time `authorize` returns, `onVendFailure` may already have run. Without the check the app would approve a dead vend
  (the library refuses, `approveVend` returns false) and then forget to void the hold.
- **`approved` flag.** The only way to know whether to reverse or void. The library does not know what the gateway
  did; the app does.
- **`closed` flag.** Makes success and failure idempotent. If a gateway callback and a bus callback race, the money
  operation runs once.
- **Taking the reason as the parameter (8.2.6).** It is captured when the vend was closed; the global slot can be overwritten by the next failure, the parameter cannot.
- **`else` branch.** A future reason value lands on void, never on nothing.

## 3. The implementation, Java

Since 8.2.6 the interface methods are real default methods, so a Java implementer overrides only what it uses. Same
logic, same flags:

```java
public final class PaymentFlow implements HardwareLib.VendListener {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private volatile Sale sale;

    @Override public void onVendRequest(double amount, int minorUnits, int itemNumber) {
        final Sale s = new Sale(minorUnits, itemNumber);
        sale = s;
        ui.showPaying(amount);
        io.execute(() -> {
            GatewayHold hold = gateway.authorize(minorUnits);
            synchronized (this) {
                if (sale != s || s.closed) { if (hold != null) gateway.voidHold(hold); return; }
                s.hold = hold;
                if (hold == null) { s.closed = true; sale = null; HardwareLib.INSTANCE.cancelVend(); ui.resetToIdle(); return; }
                s.approved = HardwareLib.INSTANCE.approveVend();
                if (!s.approved) gateway.voidHold(hold);
            }
        });
    }

    @Override public void onVendSuccess(int itemNumber) {
        Sale s; synchronized (this) { s = sale; if (s == null) return; s.closed = true; sale = null; }
        io.execute(() -> { if (s.hold != null) gateway.capture(s.hold); ui.showThanks(); });
    }

    @Override public void onVendFailure(HardwareLib.VendFailureReason reason) {   // 8.2.6: only this override is needed
        Sale s; synchronized (this) { s = sale; if (s != null) { s.closed = true; sale = null; } }
        io.execute(() -> {
            GatewayHold hold = s == null ? null : s.hold;
            if (hold != null) {
                if (reason == HardwareLib.VendFailureReason.CANCELLED_BY_VMC
                        || reason == HardwareLib.VendFailureReason.CANCELLED_BY_OPERATOR) { // the machine or the dashboard cancelled
                    if (s.approved) gateway.reverse(hold); else gateway.voidHold(hold);
                } else if (reason == HardwareLib.VendFailureReason.CANCELLED_BY_APP) {   // our own cancelVend(): already handled
                    // nothing at the gateway
                } else if (reason == HardwareLib.VendFailureReason.FAILED) {            // product not dispensed
                    gateway.reverse(hold);
                } else if (reason == HardwareLib.VendFailureReason.SESSION_ENDED
                        || reason == HardwareLib.VendFailureReason.RESET) {              // result unknown
                    if (s.approved) gateway.reverse(hold); else gateway.voidHold(hold);
                } else {                                                                 // unknown reason
                    gateway.voidHold(hold);
                }
            }
            ui.resetToIdle();
        });
    }
}
```

## 4. React Native

Same three events; the reason arrives in the payload. Keep the same `sale` record in JavaScript.

```ts
Mdb.onVendRequest(async ({ amount, minorUnits, itemNumber }) => {
  const s = (sale = { minorUnits, hold: null, approved: false, closed: false });
  const hold = await gateway.authorize(minorUnits).catch(() => null);
  if (sale !== s || s.closed) { if (hold) await gateway.voidHold(hold); return; }
  s.hold = hold;
  if (!hold) { s.closed = true; sale = null; await Mdb.cancelVend(); ui.reset(); return; }   // onVendFailure CANCELLED_BY_APP follows (8.2.5)
  s.approved = await Mdb.approveVend();
  if (!s.approved) await gateway.voidHold(hold);
});
Mdb.onVendSuccess(async () => { const s = sale; if (!s) return; s.closed = true; sale = null; if (s.hold) await gateway.capture(s.hold); ui.thanks(); });
Mdb.onVendFailure(async ({ reason }) => {
  const s = sale; if (s) { s.closed = true; sale = null; }
  if (s?.hold) {
    if (reason === 'CANCELLED_BY_VMC' || reason === 'CANCELLED_BY_OPERATOR') { if (s.approved) await gateway.reverse(s.hold); else await gateway.voidHold(s.hold); } // machine or dashboard cancelled
    else if (reason === 'CANCELLED_BY_APP') { /* our own cancelVend(): already handled */ }
    else if (reason === 'FAILED') await gateway.reverse(s.hold);                                                              // product not dispensed
    else if (reason === 'SESSION_ENDED' || reason === 'RESET') { if (s.approved) await gateway.reverse(s.hold); else await gateway.voidHold(s.hold); }
    else await gateway.voidHold(s.hold);                                                                                       // unknown reason
  }
  ui.reset();
});
```

## 5. The mistakes, and the fix for each

| symptom in the field | what the code did | fix |
|---|---|---|
| customer charged, no product, no refund, on machines that just close the session | reversed only on FAILED | reverse on FAILED, SESSION_ENDED and RESET when approved (section 2) |
| hold left on the card after a customer cancel | nothing in onVendFailure for CANCELLED_BY_VMC | void on every other reason |
| app's own decline shows a "vend failed" screen | treated CANCELLED_BY_APP like a machine cancel | branch on the reason: CANCELLED_BY_APP needs no gateway action and no error screen, only the UI reset (8.2.5) |
| operator cancels from the dashboard, payment screen stays open | the app ignored CANCELLED_BY_APP, and before 8.2.5 the dashboard cancel was silent | 8.2.5 delivers CANCELLED_BY_OPERATOR; void the hold and reset the UI on it |
| `approveVend IGNORED - no VEND REQUEST pending`, money captured anyway | ignored the Boolean | if `approveVend()` returns false the machine will not dispense: void, never capture |
| vend approved after the machine had cancelled, hold never voided | gateway result applied to a stale request | the `sale !== s` check after `authorize` |
| logs and callbacks freeze during card read | gateway called inside the callback | every callback returns at once; work on your own thread (the library warns after 3 s) |
| onVendRequest fires N times per selection on the device screen | listener assigned in an Activity, or the same lambda added per screen | one assignment at boot in Application; `remove...Listener` with the same reference if a screen must listen |
| wrong reason read, or always RESET | read `lastVendFailureReason` later, after another failure | override `onVendFailure(reason)` and use the parameter (8.2.6) |
| payment screen stays open after a fast machine cancel | the gateway was called inside `onVendRequest`; before 8.2.6 the failure callback could finish first | 8.2.6 orders the callbacks; still move the gateway call off the callback thread |
| payment screen stays open after a reset mid-vend | no RESET branch | RESET is a failure like any other: void or reverse, reset the UI |
| `amount` sent to the gateway, off by rounding | used the Double | send `minorUnits`, the exact integer; `amount` is display only |
| RS232 machine: PRODUCTION_FAIL after payment, no refund | matched the rule name in `exchangeListener` instead of the listener | give the rule `"event":"vendFailure"`; it arrives as onVendFailure with FAILED |
| health check waits forever for ENABLED, app never reaches the listener at all | listener registered after the only state event | 8.2.1+: state is replayed on registration and re-sent every 5 s under direct vend; nothing to change |

## 6. What the library guarantees, so you do not have to

- Exactly one success or failure per request, delivered on ONE ordered callback thread (8.2.6), never on the bus
  thread: for a vend the request handler has returned before its outcome arrives. A handler that blocks delays
  that outcome, which is why every callback must return immediately.
- `approveVend()` cannot charge the next customer: it only arms when a request is pending, is refused while a cancel
  reply or a session end is armed (8.2.8), and is dropped by the cancel-reply POLL, VEND FAILURE, SESSION COMPLETE,
  END SESSION and by the next VEND REQUEST (8.2.8 - before that a same-session request could inherit it).
- Events are spaced (8.2.11): two callbacks never reach you closer together than the vend event gap (default 500 ms,
  `setVendEventGap:MS`, 0 = off), so a screen drawn for one event is on screen before the next one arrives.
- One open vend at a time (8.2.9): if the machine starts a new vend while the previous one is still open, the old one
  is closed first with `onVendFailure(CANCELLED_BY_VMC)`, then `onVendRequest` fires for the new one - and a cancel
  reply or END SESSION still armed for the old vend is dropped instead of answering the new one.
- A late VEND SUCCESS / FAILURE / SESSION COMPLETE after a reader restart is answered in every state; a stray
  SESSION COMPLETE never leaves the machine hanging.
- Settings that change the flow (direct vend, force session end, cancel mode, session mode) never change the
  three callbacks or their order.

## 7. Counters - is the listener alive, and where do vends end?

Since 8.2.2 the library counts every vend event since app start. From the dashboard send `vendStats` (the **Vend**
button) and read one line:

```
[vend stats] requests=41 successes=37 failures=4 (CANCELLED_BY_VMC=3 SESSION_ENDED=1) · app cancels=2 · approve ignored=0
             · STUCK callbacks=0 · threw=0 · no listener=0 · listener registered · vend open=false · since 86400 s
```

How to read it against the mistakes in section 5:

| counter | healthy | what a bad value means |
|---|---|---|
| `requests` = `successes` + `failures` + `app cancels` | yes | a vend is open right now (`vend open=true`), or an event was dropped |
| `STUCK callbacks` | 0 | a callback blocked for more than 3 s; `last onVendRequest` = the gateway is called inside the callback (section 5, row "freeze") |
| `approve ignored` | 0 | the gateway answers slower than the machine's selection timeout; the hold must be voided every time |
| `no listener` | 0 | `HardwareLib.vendListener` was never set, or set after the first request |
| `SESSION_ENDED` rising | - | this machine closes sessions without a result; the handler must reverse on it (section 5, row 1) |
| `CANCELLED_BY_VMC` high | - | customers cancel or the selection times out while the card is read; look at gateway latency |
| `listener NOT REGISTERED` | never | the app skipped the assignment at boot |

In code: `HardwareLib.vendStatsJson()`, `vendRequestCount`, `vendSuccessCount`, `vendFailureCount`,
`vendFailuresByReason`, `vendCallbackStuckCount`.

## 8. Bench test, no machine needed

`HardwareLib.simulateExchange(hex)` pushes a frame through the log and exchange pipeline only (decode, codebook,
listeners, dashboard). It does NOT run the MDB state machine, so it never fires the VendListener. Use it to prove
the plumbing (`simulateExchange:10 10` shows code 111 on the dashboard), not the handler.

To exercise the handler itself without a machine, use the RS232 path. `Rs232Lib.simulateFrame(hex)` runs the rule
matcher, and a rule's `event` calls the SAME VendListener the MDB engine uses, with the same reasons. Load this
one-off table (the port does not have to be open; replies are only logged):

```
{"setRs232Rules":[
 {"name":"T_REQUEST","rx":"A0 01 *","tx":"","amountStart":4,"amountEnd":-1,"event":"vendRequest"},
 {"name":"T_OK",     "rx":"A0 03 00 02 4F 4B A5","tx":"","event":"vendSuccess"},
 {"name":"T_FAIL",   "rx":"A0 03 00 02 4E 4F A0","tx":"","event":"vendFailure"},
 {"name":"T_CANCEL", "rx":"A0 08 00 02 43 41 A8","tx":"","event":"vendCancel"}
]}
```

Then, one line at a time from the dashboard passthrough bar, watching the app log:

| send | listener gets | reason | money action expected |
|---|---|---|---|
| `rs232Simulate:A0 01 00 03 37 30 30 95` | onVendRequest(7.00, 700, -1) | - | authorize |
| `rs232Simulate:A0 03 00 02 4F 4B A5` | onVendSuccess | - | capture |
| request again, then `rs232Simulate:A0 03 00 02 4E 4F A0` | onVendFailure | FAILED | reverse |
| request again, then `rs232Simulate:A0 08 00 02 43 41 A8` | onVendFailure | CANCELLED_BY_VMC | void |
| request again, then another request | onVendFailure for the first | SESSION_ENDED | reverse if approved, else void |
| request again, then `close` (HardwareLib.stop) | onVendFailure | RESET | reverse if approved, else void |
| request again, then app `cancelVend()` | onVendFailure | CANCELLED_BY_APP | nothing at the gateway, UI reset |
| request again, then dashboard Vend Cancel | onVendFailure | CANCELLED_BY_OPERATOR | void (reverse if approved) |

`vendStats` afterwards must show requests=6, successes=1, failures=4 with one of each reason, app cancels=1,
STUCK callbacks=0. On MDB the engine fires the identical callbacks from the bus, so a handler that passes this table
is correct for both protocols. The first real sale on a CM30 remains the final test; nothing since 8.1.0 has run on
one.
