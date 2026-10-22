# VendListener - how to implement it, and how to fix the usual mistakes

hardware-lib 8.2.2, 22 October 2026. The payment hook is three callbacks. This document is the complete,
copy-ready implementation plus the fix for every mistake we have seen in the field. Companion files:
`IMPLEMENTATION-README.md` (the whole app), `API-REFERENCE.md`, `DUPLICATE-LOGS-README.md`.

## 1. The contract in one table

| callback | fires when | reason in `lastVendFailureReason` | money action |
|---|---|---|---|
| `onVendRequest(amount, minorUnits, itemNumber)` | the customer picked an item; the machine waits for your answer | - | authorize `minorUnits`, then `approveVend()` or `cancelVend()` |
| `onVendSuccess(itemNumber)` | the machine confirmed the product came out | - | capture |
| `onVendFailure()` | the machine cancelled (VEND CANCEL / READER CANCEL / RS232 CANCEL) | CANCELLED_BY_VMC | void the hold (reverse if you had approved) |
| `onVendFailure()` | VEND FAILURE after your approval: product not dispensed | FAILED | reverse |
| `onVendFailure()` | the machine closed the session with the vend still open, no success / failure / cancel | SESSION_ENDED | reverse if approved, else void |
| `onVendFailure()` | bus RESET or `stop()` with the vend open | RESET | reverse if approved, else void |
| nothing | your own `cancelVend()` (8.2.2) | CANCELLED_BY_APP is recorded, no callback | you already handled it |

Every VEND REQUEST the machine ends gives exactly one `onVendSuccess` or one `onVendFailure`. Your own cancel is
the only silent end, because you caused it.

## 2. The implementation, Kotlin

One object for the whole process, registered once at boot (`HardwareLib.vendListener = PaymentFlow`). Every
callback returns immediately; the gateway work runs on a coroutine. A small `Sale` record holds what we know about
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
                    HardwareLib.cancelVend()              // silent: no onVendFailure comes back (8.2.2)
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
    override fun onVendFailure() {
        val reason = HardwareLib.lastVendFailureReason   // read HERE, it is one global slot
        val s = synchronized(lock) { sale?.also { it.closed = true; sale = null } }
        scope.launch {
            val hold = s?.hold
            when (reason) {
                HardwareLib.VendFailureReason.FAILED,
                HardwareLib.VendFailureReason.SESSION_ENDED,
                HardwareLib.VendFailureReason.RESET ->
                    if (hold != null) { if (s.approved) gateway.reverse(hold) else gateway.voidHold(hold) }
                else ->                                   // CANCELLED_BY_VMC (and anything unknown)
                    hold?.let { gateway.voidHold(it) }
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
- **Reading the reason first thing.** The next failure overwrites the slot.
- **`else` branch.** A future reason value lands on void, never on nothing.

## 3. The implementation, Java

The interface has default no-op methods in Kotlin, but Java implementers must override all three. Same logic,
same flags:

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

    @Override public void onVendFailure() {
        HardwareLib.VendFailureReason reason = HardwareLib.INSTANCE.getLastVendFailureReason();
        Sale s; synchronized (this) { s = sale; if (s != null) { s.closed = true; sale = null; } }
        io.execute(() -> {
            GatewayHold hold = s == null ? null : s.hold;
            boolean dispenseUnknown = reason == HardwareLib.VendFailureReason.FAILED
                || reason == HardwareLib.VendFailureReason.SESSION_ENDED
                || reason == HardwareLib.VendFailureReason.RESET;
            if (hold != null) { if (dispenseUnknown && s.approved) gateway.reverse(hold); else gateway.voidHold(hold); }
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
  if (!hold) { s.closed = true; sale = null; await Mdb.cancelVend(); ui.reset(); return; }   // silent (8.2.2)
  s.approved = await Mdb.approveVend();
  if (!s.approved) await gateway.voidHold(hold);
});
Mdb.onVendSuccess(async () => { const s = sale; if (!s) return; s.closed = true; sale = null; if (s.hold) await gateway.capture(s.hold); ui.thanks(); });
Mdb.onVendFailure(async ({ reason }) => {
  const s = sale; if (s) { s.closed = true; sale = null; }
  const dispenseUnknown = reason === 'FAILED' || reason === 'SESSION_ENDED' || reason === 'RESET';
  if (s?.hold) { if (dispenseUnknown && s.approved) await gateway.reverse(s.hold); else await gateway.voidHold(s.hold); }
  ui.reset();
});
```

## 5. The mistakes, and the fix for each

| symptom in the field | what the code did | fix |
|---|---|---|
| customer charged, no product, no refund, on machines that just close the session | reversed only on FAILED | reverse on FAILED, SESSION_ENDED and RESET when approved (section 2) |
| hold left on the card after a customer cancel | nothing in onVendFailure for CANCELLED_BY_VMC | void on every other reason |
| app's own decline shows a "vend failed" screen | handled CANCELLED_BY_APP in onVendFailure | since 8.2.2 there is no callback; handle the decline where `cancelVend()` is called |
| `approveVend IGNORED - no VEND REQUEST pending`, money captured anyway | ignored the Boolean | if `approveVend()` returns false the machine will not dispense: void, never capture |
| vend approved after the machine had cancelled, hold never voided | gateway result applied to a stale request | the `sale !== s` check after `authorize` |
| logs and callbacks freeze during card read | gateway called inside the callback | every callback returns at once; work on your own thread (the library warns after 3 s) |
| onVendRequest fires N times per selection on the device screen | listener assigned in an Activity, or the same lambda added per screen | one assignment at boot in Application; `remove...Listener` with the same reference if a screen must listen |
| wrong reason read, or always RESET | read `lastVendFailureReason` later, after another failure | read it as the first line of onVendFailure |
| payment screen stays open after a reset mid-vend | no RESET branch | RESET is a failure like any other: void or reverse, reset the UI |
| `amount` sent to the gateway, off by rounding | used the Double | send `minorUnits`, the exact integer; `amount` is display only |
| RS232 machine: PRODUCTION_FAIL after payment, no refund | matched the rule name in `exchangeListener` instead of the listener | give the rule `"event":"vendFailure"`; it arrives as onVendFailure with FAILED |
| health check waits forever for ENABLED, app never reaches the listener at all | listener registered after the only state event | 8.2.1+: state is replayed on registration and re-sent every 5 s under direct vend; nothing to change |

## 6. What the library guarantees, so you do not have to

- Exactly one success or failure per machine-ended request, delivered on a callback thread, never on the bus
  thread, even while your request handler is blocked.
- `approveVend()` cannot charge the next customer: it only arms when a request is pending and is dropped when the
  session ends.
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

From the dashboard passthrough bar, with the demo app or your app on the device, `open` first, then one line at a
time. Each `simulateExchange` runs the frame through the real engine. Watch the app's log for the callbacks.

```
simulateExchange:10 10                 -> RESET, state INACTIVE
setDirectVend:on                       -> so a VEND REQUEST is accepted without the handshake
simulateExchange:13 00 02 BC 00 00 D1  -> VEND REQUEST 7.00 item 0: expect onVendRequest(7.0, 700, 0)
vendApprove                            -> expect "[app] approveVend armed"
simulateExchange:13 02 00 00 15        -> VEND SUCCESS: expect onVendSuccess
```

Repeat with `13 01 14` instead of VEND SUCCESS for CANCELLED_BY_VMC, `13 03 16` for FAILED, `13 04 17` followed by a
POLL for SESSION_ENDED, and `10 10` for RESET. Each must produce exactly one onVendFailure with that reason and the
money action from section 1. The last byte of every frame is the MDB checksum (sum of the bytes, low 8 bits).

Not yet run on a real CM30: the first field sale is the real test.
