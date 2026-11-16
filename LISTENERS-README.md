# VendListener and the other listeners - how they work inside hardware-lib

hardware-lib 8.2.15, 16 November 2026. This is the **mechanics** document: how a bus frame becomes a callback, which
flags decide it, what `approveVend()` and `cancelVend()` really do, why a callback is sometimes delayed, what is
guaranteed, and how every other listener (log, exchange, state, status, control, RS232 events, log sink, MQTT) is
fed. `VENDLISTENER-README.md` is the copy-ready **implementation** (Kotlin, Java, React Native) and the list of
field mistakes; `MDB-README.md` is the whole-library overview; `CANCEL-FLOW-README.md` and
`SESSION-ENDED-README.md` go deeper on two of the failure paths.

---

## 1. The listeners at a glance

| listener | payload | fires | thread | registered late? |
|---|---|---|---|---|
| `vendListener` (`VendListener`) | `onVendRequest(amount, minorUnits, item)`, `onVendSuccess(item)`, `onVendFailure(reason)` | per vend | the vend delivery thread, one, ordered | no replay: a request already delivered is gone; set it at boot |
| `logListener` / `addLogListener` | `(line, showOnScreen)` | every log line | offload thread | no replay |
| `exchangeListener` / `addExchangeListener` | `MdbExchangeEvent` (code 110-136, rx hex, tx name, params, message, sessionId, timestamp) | every bus exchange, including suppressed ones | offload thread | no replay |
| `stateListener` / `addStateListener` | `"INACTIVE_STATE"` … `"VEND_STATE"` | on every transition, plus the current state once at registration (8.2.1); re-sent every 5 s while direct vend fakes ENABLED | offload thread (replay on the caller's thread) | yes |
| `statusListener` | JSON `{"state","recentActivity"[,"busState","directVend"]}` | on transitions, when bus activity appears or disappears (5 s), on start/stop, once at registration | offload thread | yes |
| `readyListener` / `addReadyListener` (8.2.15) | `(ready: Boolean, json)` - MDB reader ENABLED / VEND or RS232 machine heard; `json` = `machineReadyJson()` | once at registration with the CURRENT value, then only when readiness flips | the thread that saw the change (replay on the caller's thread) | yes - this is its purpose |
| `controlListener` / `addControlListener` | `(tag, payload)`: `SETTINGS_JSON`, `CONFIG_JSON`, `VMC_STATUS`, `VEND_STATS`, `LOG` | on change / on request; `VMC_STATUS` + `SETTINGS_JSON` once at registration | offload thread | yes |
| `addRs232EventListener` | `(eventName, params)` coded RS232 exchange | per serial frame matched | Rs232Lib reader thread | no |
| `attachLogSink(sink)` | every line (when MQTT logging is on) and `TAG:payload` for every control line | convenience over the two above | as above | - |
| `attachRabbahMqtt()` | wires log + control + exchange + RS232 listeners to mqtt-lib and feeds mqtt-lib commands into `handleCommand` | once, idempotent; mqtt-lib calls it on connect | - | - |

The `var` slots hold one listener each; assigning again replaces silently. The `add…` lists hold any number and
never deduplicate, so register once per process and remove with the same reference. A listener that throws is
caught and skipped, never fatal to the others.

## 2. The VendListener contract

```kotlin
interface VendListener {
    fun onVendRequest(amount: Double, minorUnits: Int, itemNumber: Int) {}
    fun onVendSuccess(itemNumber: Int) {}
    fun onVendFailure() {}                                        // legacy, no reason
    fun onVendFailure(reason: VendFailureReason) { onVendFailure() }   // 8.2.6: override this one
}
```

- `onVendRequest` is the question: the customer selected an item at this price. The app answers later with
  `approveVend()` or `cancelVend()`; the bus keeps being ACKed meanwhile (the MDB "answer on a later POLL" pattern,
  and the machine's max response time is 232 s).
- `onVendSuccess` is the only "money is earned" event: the machine confirmed the product came out.
- `onVendFailure(reason)` is every other end of a vend. One of six reasons:

| reason | who ended it | wire event |
|---|---|---|
| `CANCELLED_BY_VMC` | the machine | VEND CANCEL `13 01`, READER CANCEL `14 02`, a new VEND REQUEST while one was open, RS232 rule `vendCancel` |
| `CANCELLED_BY_APP` | the app's own `cancelVend()` | SESSION CANCEL REQUEST or VEND DENIED on the next POLL |
| `CANCELLED_BY_OPERATOR` | dashboard / remote `cancelVend` | same |
| `FAILED` | the machine after approval | VEND FAILURE `13 03`, RS232 rule `vendFailure` |
| `SESSION_ENDED` | the machine closed the session with the vend open | END SESSION went out on a POLL (after SESSION COMPLETE or READER DISABLE) |
| `RESET` | the bus or the app | RESET `10`, or `HardwareLib.stop()` |

**The invariant:** every `onVendRequest` is followed by exactly one `onVendSuccess` or one `onVendFailure`, never
both, never neither, in that order. Sections 4 to 6 show how the code enforces it.

## 3. From bus frame to callback

```
 bus thread                         |  notifyVend()                      |  vend delivery thread (one, FIFO)
 ---------------------------------- | ---------------------------------- | ----------------------------------
 frame arrives from the vendor port |                                    |
 decide + send the reply (ACK ...)  |                                    |
 set / clear the vend flags         |                                    |
 notifyVend("onVendRequest") -----> | count it, flush a held failure     |
                                    | (onVendFailure only) cancel grace? |
                                    |   yes: hold it `delayMs`, return   |
                                    |   no:  deliverVend() ------------> | wait for the vend event gap
                                    |                                    | start the 3 s watchdog
 back to the next frame             |                                    | call the listener (try/catch)
                                    |                                    | cancel the watchdog
```

1. **Bus thread.** Reads one frame, picks the reply, writes it, updates the flags (section 4), and calls
   `notifyVend` with the callback name and a lambda. Nothing on this thread waits for the app.
2. **`notifyVend`.** Increments the counter (`vendRequests` / `vendSuccesses` / `vendFailures`). For a request or
   a success it first **flushes** any failure still being held by the cancel grace, so a held failure can never
   land after the next request or after a success. If no listener is set, `noListener` is counted and the event
   is dropped. For a failure that arrives inside the cancel grace window it schedules the delivery `delayMs`
   later (section 6.1). Otherwise it calls `deliverVend`.
3. **`deliverVend`.** Submits to `vendCallbackExecutor`, a single thread. Inside: sleep until the vend event gap
   since the previous callback *started* has passed (section 6.2), record the start time, arm a watchdog that logs
   `WARNING: VendListener.X has been running for 3000 ms (stuck #n)` and counts `callbackStuck` if the callback is
   still inside after 3 s, run the lambda, catch any Throwable (`callbackThrew`), cancel the watchdog.

Because there is exactly one delivery thread and events enter it in the order the bus produced them, the app sees
request, then outcome, for every vend, and never two callbacks at once.

## 4. The flags

All private to `HardwareLib`, all touched on the bus thread except where noted.

| flag | meaning | set by | cleared by |
|---|---|---|---|
| `vendRequestReceived` | a VEND REQUEST is pending an answer; `approveVend()` only arms when true | VEND REQUEST (in session or direct vend) | the POLL that sends VEND APPROVED or the cancel reply; VEND SUCCESS; VEND FAILURE; SESSION COMPLETE; READER DISABLE; END SESSION; RESET |
| `vendApprovePending` | VEND APPROVED goes out on the next POLL | `approveVend()` (app thread) | the POLL that sends it; every cancel path; VEND SUCCESS / FAILURE; SESSION COMPLETE; READER DISABLE; END SESSION; a new VEND REQUEST; RESET |
| `sessionCancelPending` + `pendingCancelResponse` | SESSION CANCEL REQUEST or VEND DENIED goes out on the next POLL | VEND CANCEL, READER CANCEL, `cancelVend()`, Force End after VEND SUCCESS | the POLL that sends it; END SESSION; a new VEND REQUEST; RESET |
| `endSessionPending` | END SESSION goes out on the next POLL | SESSION COMPLETE, READER DISABLE in session, stray SESSION COMPLETE outside a session | the POLL that sends it; a new VEND REQUEST; RESET |
| `vendOpenFlag` (AtomicBoolean) | a request was delivered and has not yet had its success or failure | VEND REQUEST delivered (MDB or RS232) | `compareAndSet(true,false)` in exactly one place: VEND SUCCESS delivery, or `abortOpenVend(reason)` |
| `priceHigh` / `priceLow` | the requested price for VEND APPROVED | VEND REQUEST | with `vendRequestReceived` |
| `lastVendFailureReason` | the last reason, readable from the app | `abortOpenVend` | never (one global slot; prefer the parameter) |
| `heldFailureAction` / `heldFailure` | a failure waiting out the cancel grace | `notifyVend` | the scheduled delivery, or a flush by the next request / success |
| `lastRequestAtMs`, `lastCallbackStartMs` | timing anchors for the grace and the gap | `notifyVend`, `deliverVend` | - |

`vendOpenFlag` is the heart of the invariant: whoever wins the compare-and-set delivers the one outcome; everybody
else is a no-op. `abortOpenVend(reason)` is the single function every non-success exit calls; if the flag is already
false it returns without doing anything.

## 5. Every path to each callback

### 5.1 `onVendRequest`

| trigger | condition | wire reply | what else happens |
|---|---|---|---|
| VEND REQUEST `13 00` in VEND_STATE | price not `00 00` when skip-zero is on | ACK | `clearPreviousVend` (section 5.4), then flags set, callback queued with `priceToAmount(raw)`, `priceToMinorUnits(raw)`, item |
| VEND REQUEST in INACTIVE / DISABLED / ENABLED | direct vend ON, or (ENABLED only) Always Idle bit set in the Level 3 Peripheral ID | ACK, state -> VEND_STATE | same |
| VEND REQUEST priced `00 00` | skip-zero ON | ACK only | nothing: no callback, no flags, `zeroVendSkipped` |
| RS232 rule with `"event":"vendRequest"` | the rule extracted a price (else logged, no callback) | the rule's tx | a previous open vend is closed first with CANCELLED_BY_VMC; `onVendRequest(price/100.0, price, -1)` |

### 5.2 `onVendSuccess`

| trigger | condition | wire reply | what else happens |
|---|---|---|---|
| VEND SUCCESS `13 02` in VEND_STATE | `vendOpenFlag` was true | ACK | approve + request flags cleared; Force End ON arms SESSION CANCEL REQUEST |
| VEND SUCCESS with the vend already closed | flag false (cancel or failure came first) | ACK | `successIgnored`, logged, **no callback** (8.2.12) |
| VEND SUCCESS outside VEND_STATE | - | ACK | logged as stray, no callback |
| RS232 rule `"event":"vendSuccess"` | a vend is open | - | `onVendSuccess(-1)` |

### 5.3 `onVendFailure(reason)` - the eleven callers of `abortOpenVend`

| where | reason | wire | flags |
|---|---|---|---|
| VEND CANCEL `13 01` in VEND_STATE | CANCELLED_BY_VMC | ACK now; cancel-mode reply on the next POLL | approve cleared, cancel armed |
| READER CANCEL `14 02` in VEND_STATE | CANCELLED_BY_VMC | CAN now; cancel-mode reply on the next POLL | same |
| a new VEND REQUEST while a vend is open (`clearPreviousVend`) | CANCELLED_BY_VMC | ACK to the new request | all old flags dropped, `requestSupersededFlags` |
| RS232 `vendRequest` while a vend is open | CANCELLED_BY_VMC | - | - |
| RS232 `vendCancel` | CANCELLED_BY_VMC | - | - |
| VEND FAILURE `13 03` in VEND_STATE | FAILED | ACK | approve + request cleared |
| RS232 `vendFailure` | FAILED | - | - |
| `cancelVend()` from app code | CANCELLED_BY_APP | cancel-mode reply on the next POLL | approve cleared, cancel armed |
| `cancelVend` / `cancelVend:…` from dashboard or backend | CANCELLED_BY_OPERATOR | same | same |
| the POLL that sends END SESSION with the vend still open | SESSION_ENDED | END SESSION, state -> ENABLED | every flag cleared |
| RESET `10` from any state, or `stop()` | RESET | ACK (RESET) / port closed | every flag cleared, state INACTIVE |

A VEND CANCEL, VEND FAILURE or SESSION COMPLETE arriving outside VEND_STATE (a machine finishing a session after the
reader restarted) is ACKed and logged as stray; the reader has no vend open, so no callback.

### 5.4 A new request wipes the old vend (8.2.9)

`clearPreviousVend("VEND REQUEST")` runs before the new request is armed:

1. a vend still open -> `abortOpenVend(CANCELLED_BY_VMC)` (the machine abandoned it by starting another), so the
   app gets the old failure **before** the new request, in order on the one thread;
2. an approval nothing consumed -> dropped (it must not approve the new item at the old price);
3. a cancel reply still armed -> dropped (it must not deny the new vend);
4. a pending END SESSION -> dropped (the machine kept the session).

Each drop is logged and counted in `requestSupersededFlags`.

## 6. The timing rules

### 6.1 Cancel grace (8.2.7, defaults 200 / 500 ms since 8.2.10)

Problem: a customer who presses cancel within a few hundred milliseconds of selecting produces `onVendRequest` and
`onVendFailure` so close together that the app's UI thread draws the request *after* the failure already reset the
screen, leaving a stuck "paying" screen.

Rule, in `notifyVend`: if the callback is `onVendFailure` and it comes less than `cancelGraceWindowMs` after the last
`onVendRequest`, it is **held** and delivered `cancelGraceDelayMs` later (`failureDelayed` counted, one log line).
The hold is released early, in order, when the next `onVendRequest` or `onVendSuccess` arrives (`flushHeldFailure`),
so a held failure never lands after a later event. The hand-over and the enqueue happen under one lock (8.2.12) so a
request flushing at the same instant cannot slip its own callback in first. The wire side is not delayed at all:
the cancel reply still goes out on the next POLL.

Off with `setCancelGrace(0, 0)` or `setCancelGrace:off`; each value 0-5000 ms.

### 6.2 Vend event gap (8.2.11, default 500 ms)

In `deliverVend`, before the listener is called: wait until at least `vendEventGapMs` have passed since the previous
callback **started**. One thread, FIFO, so the wait spaces every pair of events and keeps the order. A screen drawn
for one event is on screen for at least the gap before the next event. `eventsSpaced` counts the waits.

Off with `setVendEventGap(0)` / `setVendEventGap:off`; 0-5000 ms.

### 6.3 Watchdog (3 s)

The listener must return at once and do gateway work on its own thread. A callback still running after 3 s is
logged as stuck and counted (`callbackStuck`, `lastStuckCallback`, `lastStuckAgoSec`). Nothing is killed, but every
later callback waits behind it, so a stuck request handler delays its own outcome.

### 6.4 Sequence examples

Normal vend (times are relative; gap 500 ms, grace 200/500):

```
t=0      13 00 price   -> ACK          onVendRequest queued, delivered immediately
t=2.1 s  app approveVend()             VEND APPROVED armed
t=2.2 s  POLL          -> VEND APPROVED
t=4.0 s  13 02 item    -> ACK          onVendSuccess delivered (gap long since satisfied)
t=4.1 s  13 04         -> ACK          END SESSION armed
t=4.2 s  POLL          -> END SESSION  state ENABLED
```

Fast cancel (the field case that produced 8.2.7 and 8.2.11):

```
t=0        13 00        -> ACK          onVendRequest delivered
t=0.12 s   13 01        -> ACK          abortOpenVend(CANCELLED_BY_VMC): 120 ms < 200 ms window -> HELD
t=0.20 s   POLL         -> SESSION CANCEL REQUEST   (wire side not delayed)
t=0.62 s                                onVendFailure delivered (120 + 500 ms); gap already satisfied
```

Late approval after a machine cancel (B11, 8.2.8):

```
13 00 -> ACK            onVendRequest
13 01 -> ACK            onVendFailure(CANCELLED_BY_VMC); cancel reply armed, approve cleared
app approveVend()       returns FALSE: "a cancel reply is already armed" (approveAfterCancel)
POLL  -> SESSION CANCEL REQUEST   request + approve flags cleared: nothing survives into the next vend
```

Second selection while the first is open (8.2.9):

```
13 00 item A -> ACK     onVendRequest(A)
13 00 item B -> ACK     onVendFailure(CANCELLED_BY_VMC) for A, then onVendRequest(B), 500 ms apart
```

Success after the machine already cancelled (8.2.12):

```
13 00 -> ACK            onVendRequest
13 01 -> ACK            onVendFailure(CANCELLED_BY_VMC); vendOpenFlag false
13 02 -> ACK            successIgnored: NO onVendSuccess (the app already voided)
```

## 7. `approveVend()` and `cancelVend()` inside

### 7.1 `approveVend()`

```
if (!vendRequestReceived)               -> false, approveIgnored   ("no VEND REQUEST pending")
if (sessionCancelPending || endSessionPending) -> false, approveAfterCancel ("the vend is over - void / reverse")
vendApprovePending = true               -> true, "VEND APPROVED goes out on the next POLL"
```

It never queues for a future request, so it can never auto-approve the next customer. A `false` means the machine
will not dispense: the app must void the hold, never capture.

### 7.2 `cancelVend()` / `cancelVend(response)`

```
if (mdbState != VEND_STATE)             -> false ("no session live")
pendingCancelResponse = response (or the standing cancel mode)
sessionCancelPending = true; vendApprovePending = false
if (vendOpen) abortOpenVend(CANCELLED_BY_APP)          // CANCELLED_BY_OPERATOR from the dashboard
-> true
```

Works before a request too (abort a session before the customer picks), in which case nothing is open and no
callback fires. The two responses: SESSION CANCEL REQUEST (machine answers SESSION COMPLETE, reader then sends END
SESSION, session over) or VEND DENIED (session stays open, machine may request again).

### 7.3 What the next POLL carries in VEND_STATE, in priority order

1. `endSessionPending` -> **END SESSION**: state -> ENABLED, every flag cleared, auto mode re-arms BEGIN SESSION after
   the cooldown, `abortOpenVend(SESSION_ENDED)` if a vend was still open.
2. `sessionCancelPending` -> **SESSION CANCEL REQUEST** (and the retry timer is armed) or **VEND DENIED**; request +
   approve flags cleared.
3. `vendApprovePending && vendRequestReceived` -> **VEND APPROVED** at `priceHigh priceLow`; flags cleared.
4. a session-cancel retry is due -> SESSION CANCEL REQUEST again (up to the count).
5. otherwise **ACK** (idle).

So an approval and a cancel armed in the same POLL interval always resolve to the cancel.

## 8. What the library guarantees

- Exactly one success or failure per request, in order, on one thread, never on the bus thread.
- `approveVend()` cannot charge the next customer: it arms only for a pending request, is refused once a cancel or
  session end is armed, and is dropped by the cancel-reply POLL, VEND FAILURE, SESSION COMPLETE, READER DISABLE, END
  SESSION, RESET and the next VEND REQUEST.
- No `onVendSuccess` for a vend that already got `onVendFailure`.
- One open vend at a time: a new request closes the previous one first.
- A failure within the grace window is delayed, never dropped, and never delivered after a later request or
  success.
- Two callbacks are never closer than the event gap.
- Settings that change the wire flow (session mode, cancel mode, direct vend, force end, retry, level) never change
  the three callbacks or their order.
- The bus reply never waits for the app: ACKs go out while the app thinks.

## 9. Counters that watch all of this (`vendStats`)

| counter | mechanism in this document |
|---|---|
| `vendRequests`, `vendSuccesses`, `vendFailures`, `vendFailuresByReason` | section 3 step 2 |
| `appCancels`, `operatorCancels` | section 7.2 |
| `approveIgnored`, `approveAfterCancel` | section 7.1 |
| `requestSupersededFlags` | section 5.4 |
| `successIgnored` | section 5.2 |
| `failureDelayed` | section 6.1 |
| `eventsSpaced` | section 6.2 |
| `callbackStuck`, `lastStuckCallback`, `lastStuckAgoSec`, `callbackThrew`, `noListener` | section 3 step 3 |
| `vendOpen`, `listenerRegistered`, `lastRequestAgoSec`, `lastFailureReason` | the current picture |

Remote `vendStats` answers `VEND_STATS:{...}` and a one-line summary; the dashboard has the **Vend** button.

## 10. The other listeners, in detail

### 10.1 Log lines - `logListener`, `addLogListener`

Every `report(line, showOnScreen)` in the library fans out to the single slot and the list, on the offload thread.
`showOnScreen=false` marks per-POLL noise (idle ACKs, unhandled frames when visibility is on): never append those to
a growing text view. Prefixes: `[mdb]`, `[app]`, `[remote]`, `[rs232]`, `[pulse]`. MQTT logging (`setMqttLogging`)
does not affect local listeners, only what leaves the device.

### 10.2 Exchanges - `exchangeListener`, `addExchangeListener`

After the reply bytes have gone out, the bus thread queues `queueExchange(cmd, sent)`; the offload thread classifies
the frame into one `MdbCmd` (codes 110-136, append-only), fills the template message, and delivers one
`MdbExchangeEvent`. Fields: `cmd`, `code`, `logEventName` (e.g. `MDB_VEND_REQUEST`), `rxHex`, `txName`, `params`
(price, item, level where applicable), `message`, `sessionId`, `publishRemote`, `showOnScreen`, `timestampMs`.
Suppressed exchanges (idle POLL, unhandled with visibility off) still reach this feed with `showOnScreen=false`; honour
`publishRemote` / `showOnScreen` if you forward them. Through `attachRabbahMqtt` each event becomes one coded
RABBAH_LOG item on the `logs` topic.

### 10.3 State - `stateListener`, `addStateListener`

Edge-triggered: the plain state name on every real transition. The **reported** state is delivered: with direct
vend ON, INACTIVE and DISABLED are reported as `ENABLED_STATE` so an app that waits for "ready" does not wait forever
on a machine that never sends READER ENABLE. Since 8.2.1 a listener gets the current state once at registration, on
the caller's thread, and while direct vend fakes ENABLED the state is re-sent every 5 s to local listeners (never
over MQTT).

### 10.3.1 Machine ready - `readyListener`, `addReadyListener`, `isMachineReady`, `machineReadyJson()` (8.2.15)

The question the state listener answers indirectly, answered directly and **idempotently**: "can the machine sell
through this reader right now?". It exists because of one field report: the machine finished its handshake before
the Android app registered anything, and the app never learned it was ready. The state listener replays on
registration (8.2.1), but that replay goes to whichever native listener exists at that moment; an app whose own
code (or JS side) subscribes later still saw nothing until the next transition, which on a quiet machine never
comes.

| member | what it gives |
|---|---|
| `isMachineReady: Boolean` | `isMdbReady \|\| Rs232Lib.isMachineReady` - read any time, before or after the handshake |
| `isMdbReady: Boolean` | the reader is running and the **reported** state is `ENABLED_STATE` or `VEND_STATE` (direct vend ON counts, exactly as `currentState` says). False before `start()`, after `stop()`, while INACTIVE / DISABLED |
| `isMdbHandshakeDone: Boolean` | the VMC completed SETUP since `start()` (real bus state left INACTIVE). Stays true through READER DISABLE; false after RESET or `stop()` |
| `Rs232Lib.isMachineReady: Boolean` | the port is open **and** the machine has been heard on this connection: a frame matched a rule tagged `"event":"connect"`, or - when no rule in the table carries that tag - any rule at all. Drops on `close()`, when the reader dies, and after `readyTimeoutMs` without a matched frame (`setReadyTimeout(ms)`, remote `rs232ReadyTimeout:MS`, 0 = off, persisted) |
| `machineReadyJson(): String` | the snapshot: `{"ready", "mdb": {"ready","running","handshake","state","busState","directVend","recentActivity","level"}, "rs232": {"ready","open","connected","lastRule","lastRxAgeMs","rules","connectRules","readyTimeoutMs"}, "at"}` |
| `readyListener` / `addReadyListener((ready, json))`, `removeReadyListener` | **replayed once at registration** with the current value, then fires only when the (mdb, rs232) readiness pair changes - never on heartbeats, never on idle POLLs, not on BEGIN / END SESSION (VEND_STATE is still ready). Runs on the thread that saw the change (offload thread for MDB, RS232 reader thread for serial) |
| control line `MACHINE_READY:{json}` | shipped on every change, once to a late control listener (next to `VMC_STATUS` and `SETTINGS_JSON`), and on the remote command `getMachineReady` |

What flips it, MDB side: READER ENABLE -> true; READER DISABLE, RESET, `stop()` -> false; direct vend switched on
while the bus is INACTIVE / DISABLED -> true (the reported state becomes ENABLED). What flips it, RS232 side: the
first connect-tagged (or first matched) frame after `open()` -> true; `close()`, reader failure, ready timeout ->
false. A `[ready] machine READY - mdb ENABLED_STATE (mdb=true rs232=false)` log line accompanies every change.

Rule of thumb for the app: call `addReadyListener` (or React Native `onMachineReady`) once at boot and drive the
"ready" screen from it; never wait for a transition. If you only want to poll, `isMachineReady` is the same truth.

### 10.4 Status - `statusListener`

JSON `{"state": reported, "recentActivity": bool}` plus `"busState"` and `"directVend": true` when the reported state
is synthetic. Event-driven only: on every transition, when bus traffic appears or has been silent for 5 s, on
start/stop, and once at registration. It is the same payload as the `VMC_STATUS:` control line the dashboard uses
for its state badge and "bus alive" dot.

### 10.5 Control plane - `controlListener`, `addControlListener`

`(tag, payload)` pairs: `SETTINGS_JSON` (after `init`, after every setter, on `getSettings`), `CONFIG_JSON` (on
`getConfig`, after a payload change), `VMC_STATUS`, `VEND_STATS` (on `vendStats`), `MACHINE_READY` (8.2.15: on every
readiness change and on `getMachineReady`), and `LOG` (plain lines, already gated by `setMqttLogging`). A late
registration gets `VMC_STATUS`, `SETTINGS_JSON` and `MACHINE_READY` at once. A transport bridge forwards `LOG` as the
bare line and everything else as `TAG:payload`.

### 10.6 RS232 events - `addRs232EventListener`

One `(eventName, params)` per matched serial frame, names 1:1 with mqtt-lib's `Rs232LogEvent`. While a listener is
registered, `Rs232Lib` keeps its plain `[rs232]` line local so the wire never carries the same exchange twice. A rule
with an `event` (`vendRequest`, `vendSuccess`, `vendFailure`, `vendCancel`) additionally drives the **same**
`VendListener` through `rs232VendEvent` (section 5), with the same `vendOpenFlag` and the same reasons.

### 10.7 `attachLogSink(sink)`

For an app with its own transport: registers a log listener that forwards every line when MQTT logging is on (and
drops `[rs232]` twins when RS232 events are coded) plus a control listener that forwards every non-`LOG` tag as
`TAG:payload`. Pair it with `handleCommand(text)` fed from the app's command channel and a dashboard can see and
control the whole library.

### 10.8 `attachRabbahMqtt()` / `detachRabbahMqtt()`

Reflection-only wiring to mqtt-lib (hardware-lib has no compile-time dependency on it). Attach registers: a command
listener (`handleCommand` for every text on the `cmd` and `passthrough` topics; unknown commands fall through to the
app's own listeners), an exchange forwarder (coded items, `RabbahLog.log`, session id propagation), an RS232 event
forwarder (`RabbahLog.rs232`), a log listener (lines when MQTT logging is on, `[remote]` answers always) and a control
listener (`TAG:payload` to the `ops` topic). Detach removes exactly those and nothing the app registered itself.
mqtt-lib calls attach on its first connect when `autoAttachHardware` is on (default); remote `attachHardware` /
`detachHardware` do the same.

### 10.9 Remote control - `handleCommand(text)`

Not a listener but the inbound half of the same surface: any transport hands the text in, the library answers with
`[remote]` lines and control tags on the feeds above. Returns true when the command was consumed. The full command
list is in `MDB-README.md` section 8.

## 11. React Native

`react-native-mdb` registers one `VendListener` in `MdbRnModule` and re-emits each callback as a JS event on the
React Native bridge: `MdbVendRequest` `{amount, minorUnits, itemNumber}`, `MdbVendSuccess` `{itemNumber}`,
`MdbVendFailure` `{reason}`. The ordering and spacing guarantees hold up to the native side; JS receives them in the
same order through the event emitter. The other feeds map to `MdbStateChanged`, `MdbStatus`, `MdbLog`,
`MdbExchange`, `MdbRemoteCommand`. `approveVend()` / `cancelVend()` / `cancelVendWith(mode)` return the same Boolean
as promises. Settings for the timing rules: `setVendEventGap(ms)`, `getVendEventGap()`, `setCancelGrace(window,
delay)`, `getCancelGrace()` (1.4.3), `getMachineReady()` / `onMachineReady` / `onStateChanged` (1.5.0).

1.5.0 (hardware-lib 8.2.15): `getMachineReady()` resolves the readiness snapshot as an object, `onMachineReady(fn)`
delivers it **once right after subscribing** and then on every change, and `onStateChanged(fn)` likewise replays the
current state. The native module re-emits the current value to every new JS subscriber (RN calls the module's
`addListener(eventName)` for each subscription), so the order "machine handshake first, JS subscribes later" no longer
loses the answer. The pulse `isMachineReady()` is unrelated: that is the digital-in ready-feedback gate.

## 12. Testing the mechanics without a machine

- **`simulateExchange(hex)`** runs classify -> template -> log / exchange / control listeners only. It does **not**
  run the state machine, so it never fires the VendListener. Use it to prove the plumbing to the dashboard.
- **RS232 rules with `event`** drive the real VendListener through the same `vendOpenFlag` and `notifyVend` path;
  `VENDLISTENER-README.md` section 8 has a ready rule table and the expected reason for each line.
- **The JVM bus-trace harness** (`source/MdbSlaveApp/hardware-lib/bus-trace/`) runs the real `HardwareLib` against
  a fake vendor port and asserts replies, callbacks, order, timing and counters for every scenario in this document:
  S1-S8 (team's B11 cases), S9-S15 (cancel grace, superseded flags), S16-S18 (event gap timing), S19-S24 (8.2.12
  fixes), S25-S27 (warm resume), S28 (cash sale), S29-S31 (machine ready: life cycle, late listener replay, RS232 connect logic). 31 of 31 pass on 8.2.15.
- Nothing from 8.1.0 onward has yet run on a real CM30.

## 13. Version history of the mechanics

| version | change |
|---|---|
| 7.24.0 | callbacks moved off the bus thread to their own thread |
| 8.0.0 | `onVendFailure` becomes the one non-success callback; `VendFailureReason`; `abortOpenVend` exactly-once |
| 8.1.0 | RS232 rule events drive the same VendListener |
| 8.2.2 | `vendStats` counters, 3 s watchdog |
| 8.2.5 | every cancel (app, operator) delivered with its reason |
| 8.2.6 | one ordered delivery thread; `onVendFailure(reason)` overload |
| 8.2.7 | cancel grace (200 / 350) |
| 8.2.8 | `approveVend()` refused once a cancel or session end is armed; flags wiped by the wire reply |
| 8.2.9 | a new VEND REQUEST clears every flag of the previous vend |
| 8.2.10 | cancel grace delay 500 |
| 8.2.11 | vend event gap |
| 8.2.12 | `vendOpenFlag` CAS, VEND SUCCESS gated, held-failure hand-over under lock, one bus loop |
| 8.2.13 | warm resume (no listener change) |
| 8.2.14 | CASH SALE ACKed (no listener change) |
| 8.2.15 | machine ready: `readyListener` / `addReadyListener` with replay, `isMachineReady`, `isMdbReady`, `isMdbHandshakeDone`, `machineReadyJson()`, control line `MACHINE_READY`, remote `getMachineReady`; `Rs232Lib.isMachineReady`, rule event `connect`, `setReadyTimeout`; React Native 1.5.0 re-emits ready / state to late JS subscribers |
