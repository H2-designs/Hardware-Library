# AAR update — mqtt-lib 2.8.0 + hardware-lib 8.2.7

Companion files: CANCEL-FLOW-README.md (who can cancel, what the app hears, what goes on the bus), IMPLEMENTATION-README.md (the end-to-end guide for the Android app: startup, VendListener with the reversal rule, approve/cancel, health check, settings, RS232, pulse, verify), API-REFERENCE.md (every public function of HardwareLib / Rs232Lib / PulseLib, by protocol), PULSE-README.md (pulse integration guide), DUPLICATE-LOGS-README.md (why log lines were duplicated and how 8.2.1 / 2.7.1 stops it), samples/ (PulsePaymentSample.kt, Rs232SampleActivity.kt, MdbMqttBridge.kt), RELEASE-NOTES-8.2.0.md.

## What to do (2 steps, no code changes)

1. Replace BOTH AARs in your app's `libs/`:
   - `mqtt-lib-2.8.0.aar` (replaces 2.6.0 / 2.7.x)
   - `hardware-lib-8.2.7.aar` (replace whatever version you bundle now)

   ```gradle
   implementation files('libs/mqtt-lib-2.8.0.aar')
   implementation files('libs/hardware-lib-8.2.7.aar')
   implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
   ```

2. Build and deploy. That's it — **do NOT write any wiring code, do NOT edit proguard.**
   These AARs (8.2.1 / 2.7.1) carry their R8 keep rules INSIDE (consumerProguardFiles),
   so minified builds can no longer strip them.
   Verify the APK BEFORE deploying: Android Studio > Build > Analyze APK > search
   `com.rabbah.mdb` — HardwareLib must be present in the dex.

> Replace BOTH files every time. A build that swaps one AAR and keeps the other old one shows
> "hardware-lib absent" on the device (R8 renames the unprotected old file).

## What changed in this library - hardware-lib 8.2.1 + mqtt-lib 2.7.1 (vs the fleet's 8.0.0 / 2.6.0)

All additive: no breaking change, an app built on 8.0.0 / 2.6.0 compiles and behaves the same. The next
section lists the code the Android app may add to USE the new parts.

### 8.2.7 - cancel grace: a failure right after the request is delivered 350 ms later (27 October 2026)

Field case, continued from 8.2.6: with ordered callbacks the stuck screen still appeared. `onVendRequest` returns at
once and posts the screen to the UI thread; VEND CANCEL came 57 ms later, `onVendFailure` reset a screen that was not
drawn yet, then the UI drew "tap your card" and nothing cleared it. Now: if a vend fails within **200 ms** of its
`onVendRequest`, the `onVendFailure` delivery is held back **350 ms** (a new VEND REQUEST flushes it first, so order
is kept; the bus replies are not delayed). Defaults ON. Setting: `setCancelGrace:WINDOW,DELAY` (ms, 0..5000),
`setCancelGrace:off`, `setCancelGrace:on`; Kotlin `setCancelGrace(windowMs, delayMs)`; SETTINGS_JSON
`cancelGraceWindowMs` / `cancelGraceDelayMs`; backend keys `mdb_cancel_grace_window_ms` /
`mdb_cancel_grace_delay_ms`. Log: `[mdb] onVendFailure came 57 ms after onVendRequest - delivered 350 ms later
(cancel grace)`; `vendStats` adds `failureDelayed`. The app must still clear its screen from `onVendFailure`.

### 8.2.6 - ordered vend callbacks and onVendFailure(reason) (27 October 2026)

Field case: the app called its gateway inside `onVendRequest` (~300 ms) and the machine sent VEND CANCEL 57 ms after
the request. Each callback ran on its own thread, so `onVendFailure` was delivered and finished BEFORE
`onVendRequest` returned; the app then painted its payment screen for a vend that was already dead and stayed there.
Reproduced on the JVM with the same executor.

- **The three vend callbacks now run on ONE ordered thread.** For a vend, `onVendRequest` completes before its
  `onVendSuccess` / `onVendFailure` is delivered, on MDB and RS232. The price: a request handler that blocks now
  delays the outcome by as long as it blocks (until 8.2.5 a cancel reached a stuck handler at once). So the rule is
  not optional any more: **return from every callback immediately; gateway work goes on your own thread.** The 3 s
  watchdog still names a stuck callback and `vendStats` counts it.
- **`onVendFailure(reason: VendFailureReason)`**: new overload, the reason captured when the vend was closed and
  passed with the callback, so a later failure or `stop()` cannot overwrite it before you read it. Override this one.
  The default calls the old `onVendFailure()`; nothing existing changes. Java implementers only override what they
  use (the interface methods are real default methods now).
- React Native: the bridge passes the captured reason; the event is unchanged.

### 8.2.5 - every cancel reaches onVendFailure with a reason; operator cancels get their own reason (25 October 2026)

The 8.2.2 rule (the app's own `cancelVend()` is silent) is withdrawn. Since 8.2.5 every cancel is delivered through
`onVendFailure`, exactly once, and `lastVendFailureReason` says who cancelled: **CANCELLED_BY_VMC** (the machine),
**CANCELLED_BY_APP** (your own `cancelVend()`), **CANCELLED_BY_OPERATOR** (new: the dashboard's Vend Cancel, the
remote `cancelVend` commands, or a remote session-mode switch while a session is live). The wire replies are
unchanged. In the handler: CANCELLED_BY_APP needs no gateway action (you already declined) but still resets the UI;
CANCELLED_BY_OPERATOR must void the hold, or reverse if you had approved, because the app did not decide it. A Java
`switch` over `VendFailureReason` without `default` must add the new case. `vendStats` adds `operatorCancels`.
Full tables and sequences: `CANCEL-FLOW-README.md`.

Also 8.2.5: `[remote]` reply lines (the answer to `help`, `getSettings` acknowledgements, the `vendStats`
summary) are no longer muted by the MQTT Logs switch, so an operator command always answers. They travel on the
`ops` channel since mqtt-lib 2.8.0.

### Session-cancel retry: one number for the wait, one for the count (8.2.5)

`setSessionCancelRetry:MS[,COUNT]` - the wait in ms (0 = off, 300..10000) and, optionally, how many re-sends before
the reader gives up (1..10, default 3). Both persisted; `on` / `off` stay as aliases for 1000 / 0. SETTINGS_JSON
carries `sessionCancelRetryMs` and `sessionCancelRetryCount`. Kotlin: `setSessionCancelRetry(ms, maxRetries)`,
`sessionCancelRetryCount`. Backend keys: `mdb_session_cancel_retry_ms` and `mdb_session_cancel_retry_count`,
a plain number each.

```
setSessionCancelRetry:1000,3     wait 1000 ms, re-send up to 3 times (the defaults)
setSessionCancelRetry:1500,5     wait 1500 ms, up to 5 times
setSessionCancelRetry:0          off
```


### 8.2.4 - skip 00 00 vend requests (24 October 2026, no code change)

Field case: a machine keeps sending VEND REQUEST with price `00 00` while the customer is still choosing, and sends
the real price only once an item is selected. Each 00 00 request reached the app as `onVendRequest(0.0, 0, ..)`.

New persisted setting **skip 00 00 vend** (default OFF): when ON, a VEND REQUEST whose price bytes are `00 00` is ACKed
on the bus and dropped - no `onVendRequest`, no vend opened, no state change, and an open vend, a pending approval or a
session-cancel retry is left as it is. The next request with a real price is handled exactly as before. Works in a
session and with direct vend alike.

- Dashboard: **Skip 00 00 Vend** toggle next to Cancel Retry. Remote: `setSkipZeroVend:on|off`.
- Kotlin: `HardwareLib.setSkipZeroVend(Boolean)` / `HardwareLib.isSkipZeroVend`. SETTINGS_JSON: `skipZeroVend`.
- Log: `[mdb] VEND REQUEST with price 00 00 skipped (skip 00 00 vend ON) - ACK only, no onVendRequest (N so far)`, at most
  one line per 10 s. The dropped exchanges themselves are hidden like idle POLLs (shown with `setPollVisibility:on`), so
  they do not flood the log or the backend. `vendStats` counts them as `zeroVendSkipped`.
- MDB only. Leave it OFF on machines that sell items at price 0 (free vend).

### 8.2.3 - session-cancel retry (24 October 2026, no code change)

Field case D-1637 (22 October): 3 of 47 SESSION CANCEL REQUESTs (our answer to the machine's VEND CANCEL) were
ignored. Each time the machine sent no SESSION COMPLETE and sat 21-29 s, blocking the next customer, until it sent
VEND CANCEL again; the second request was then answered at once. Answered requests took at most 0.36 s.

New persisted setting **session-cancel retry** (default OFF): when ON and SESSION COMPLETE has not arrived 1000 ms after
any SESSION CANCEL REQUEST the reader sent (VEND CANCEL / READER CANCEL reply, `cancelVend()`, Force End), the request
goes out again on the next POLL, up to 3 times; then `[mdb] WARNING: no SESSION COMPLETE after 3 re-sent ...` and the
session is left to the machine. A new VEND REQUEST stops the retry (the machine kept the session - that vend is served).

- Dashboard: **Cancel Retry** toggle next to Force End. Remote: `setSessionCancelRetry:on|off` or `setSessionCancelRetry:MS` (300-10000).
- Kotlin: `HardwareLib.setSessionCancelRetry(Boolean)` / `setSessionCancelRetry(ms)` / `isSessionCancelRetry`. SETTINGS_JSON: `sessionCancelRetryMs`.
- Log: `[mdb] no SESSION COMPLETE 1012 ms after SESSION CANCEL REQUEST - sent again (retry 1/3)`; the re-send itself is a
  normal `POLL tx=SESSION CANCEL REQUEST` exchange. `vendStats` counts `sessionCancelRetries` and `sessionCancelGaveUp`.
- Not the same as Force End: Force End decides WHEN the reader asks to close (after VEND SUCCESS); the retry makes sure
  any such request is not lost. Turn on what the machine needs; they work together.

**Two frames in one read (27 October 2026, rule table only - works on every library since 7.10.0, including the fleet's 8.2.2).** Field log:
`RS232 UNMATCHED rx=A0 03 00 07 53 55 43 43 45 53 53 E7 A0 06 00 02 48 42 AE` - the Making Result SUCCESS and the next
HEARTBEAT arrived back to back, inside the frame gap (`frameGapMs`, default 1000 ms), so the library read them as ONE
frame. An exact rule needs the exact length, so nothing matched and no `onVendSuccess` fired. Fix: make the two result
rules open-ended with a trailing `*` - `"A0 03 00 07 53 55 43 43 45 53 53 E7 *"` and `"A0 03 00 06 46 41 49 4C 45 44 A6 *"`
(the `*` is its OWN token: `E7 *` with a space; `E7*` is not valid hex and the whole table is rejected). An open-ended
rule matches the frame alone AND the frame with anything glued behind it, so the ACK goes out and the event fires in both
cases. Keep them ABOVE `RESULT_HEAD` (`A0 03 *`, no event) - rules are tried in order, first match wins. The heartbeat
glued into that read is not answered on its own; the machine's next heartbeat is. Keep the CRC check OFF for this machine:
the XOR over a merged frame never matches its last byte, so with CRC ON the frame is discarded before any rule sees it.

### 8.2.3 - RS232 rx patterns may start with `*` (24 October 2026, no code change)

A leading `*` matches the END of a frame: `"* 53 E7"` matches every frame whose last bytes are `53 E7`. For machines
that pause mid-frame longer than `frameGapMs`, so one frame arrives as two: a tail rule catches the second piece (the
first still logs UNMATCHED). First match wins - list tail rules after the exact ones, and use enough tail bytes to be
unique. `*` at both ends is rejected. Rule table only; every existing table behaves as before. mqtt-lib stays 2.8.0.
Details and a verify table: `RELEASE-NOTES-8.2.3.md`. Not yet run on a real CM30.

### 8.2.2 - the app's own cancelVend() is no longer echoed as onVendFailure (22 October 2026; WITHDRAWN in 8.2.5, see above)

Until 8.2.1 `HardwareLib.cancelVend()` (and the dashboard's `cancelVend` command) closed the open vend AND fired
`onVendFailure` with reason CANCELLED_BY_APP - the app heard its own cancel back. The fleet app does not want that:
it has already voided the hold and reset its screen when it calls cancelVend. Since 8.2.2 a cancel the app asked for
closes the vend **silently**: the deny reply still goes out on the next POLL, `lastVendFailureReason` still records
CANCELLED_BY_APP for anyone who reads it, but **no onVendFailure fires**. Log line:
`[mdb] vend closed by cancelVend - no onVendFailure (the app's own decision)`.

Everything the MACHINE does still reaches the listener exactly once: VEND CANCEL / READER CANCEL (CANCELLED_BY_VMC),
VEND FAILURE (FAILED), a session closed with the vend open (SESSION_ENDED), RESET / stop() (RESET). So the contract
is now: every VEND REQUEST ends in exactly one onVendSuccess or onVendFailure, **unless the app ended it itself with
cancelVend**, in which case the app already knows. Not yet run on a real CM30.

### mqtt-lib 2.8.0 - the backend's log topic carries only coded items; everything else goes to `ops` (8.2.2 release)

Field case D-0554: a device with the dashboard **Logs** toggle on published every plain report line and every
control line to `devices/<id>/logs`, and the backend filed them as `device.log.unknown_source`, thousands a day.
Turning the toggle off is not an answer: it also stops the coded exchange items the Android/backend team needs.

Since mqtt-lib 2.8.0 `MqttLib.enqueue` routes by payload: a coded log envelope (`RABBAH_LOG:{...}` or bare JSON)
goes to the log topic as before; everything else - plain `[mdb]` / `[remote]` / `[app]` lines, the control lines
(VMC_STATUS, SETTINGS_JSON, CONFIG_JSON, MQTT_STATS, VEND_STATS, RS232_RULES_JSON), PONG, the `version` reply - goes
to `devices/<id>/ops` (`MqttConfig.opsTopicSuffix`, default `"ops"`, null = old behaviour). The backend never
sees a non-JSON payload on `logs` again, whatever the toggle says. The **Logs** toggle keeps its meaning and its
persistence. The Hardware Dashboard v8.2.2 subscribes to `ops` as well; an older dashboard would still decode the
coded items but miss the plain lines, so update it with the libraries. No app change, no backend change.

### 8.2.2 - vend counters and the stuck-listener counter (22 October 2026, no code change)

Remote `vendStats` (dashboard **Vend** button) answers `VEND_STATS:{...}`: vend requests, successes, failures and
failures per reason, app cancels, ignored approves, and `callbackStuck` - how many times a VendListener callback was
still running after 3 s, with the callback's name and when. The watchdog line now reads
`[mdb] WARNING: VendListener.onVendRequest has been running for 3000 ms (stuck #N) ...`. Since app start, not
persisted. Code: `HardwareLib.vendStatsJson()` and the `vend*Count` properties. Full key list in
`API-REFERENCE.md`, "Vend counters".

### 8.2.1 / mqtt-lib 2.7.1 - every exchange reaches the backend exactly once (15 October 2026, no code change)

Field case D-0961: the backend showed VEND APPROVED four times within 20 ms and other exchanges twice. The MDB engine
answers a POLL once; the copies were extra publishers. Three library-side guards now make duplicates impossible:

1. **`add*Listener` never registers the same instance twice** (`addExchangeListener`, `addLogListener`,
   `addStateListener`, `addControlListener`, `addRs232EventListener`, and `MqttLib.addCommandListener`). A bridge
   or Activity that calls `attach()` on every recreation no longer stacks publishers.
2. **`HardwareLib.attachRabbahMqtt()` is a complete bridge.** It now publishes every MDB exchange as ONE coded
   RabbahLog item itself and keeps the plain exchange text local (exactly how RS232 already worked). The sample
   `MdbMqttBridge` is now a two-line wrapper around `attachRabbahMqtt()` / `detachRabbahMqtt()`. **Delete any
   exchange or log forwarder the app has of its own** - with 8.2.1 it only produces a second copy (which the next
   guard then drops anyway). Plain exchange lines that used to reach the backend as `device.log.unknown_source`
   stop; the coded item carries the same exchange.
3. **RabbahLog drops an item identical to the previous one within 30 ms** (same schema, code, params, session id).
   Two publishers wired by mistake collapse to one wire item; `RabbahLog.dedupedItems` counts the drops - a rising
   counter means the app still has an extra publisher.

Not yet run on a real CM30 - compiled and API-checked.

Also in 8.2.1, two field cases (15 October 2026):

- **READER ENABLE (14 01) and READER CANCEL (14 02) are answered in INACTIVE when direct vend is ON** (ACK / CAN,
  no state change). A direct-vend machine that sends READER ENABLE before its setup is finished, or re-sends it
  after a RESET, no longer sees an unanswered command and retries forever. With direct vend OFF, INACTIVE stays
  spec-strict and READER ENABLE is answered once setup is complete (DISABLED), as before.
- **The reported state is held and re-announced.** Two things the app saw as "ENABLED_STATE arrives only once":
  (1) a state or status listener registered AFTER the last transition got nothing until the next one - now every
  newly registered `stateListener` / `addStateListener` / `statusListener` receives the current state at once;
  (2) with direct vend ON the reported name stays ENABLED_STATE across the real INACTIVE -> DISABLED transitions, and
  the listener used to be silent for those - now it fires again on every real bus transition (same name, so the app
  can simply re-apply it). `VMC_STATUS.busState` still carries the real state.
- **`HardwareLib.currentState` returns the same reported state the listeners deliver** (ENABLED_STATE under direct
  vend while the bus is INACTIVE/DISABLED); the real bus state is the new `HardwareLib.busState`.
- **SESSION COMPLETE (13 04) and the other vend-group commands are answered in EVERY state.** A machine that was
  mid-session when the reader restarted keeps sending SESSION COMPLETE afterwards; before 8.2.1 that was UNHANDLED in
  INACTIVE / DISABLED / ENABLED and the machine never closed its side. Now: 13 04 -> ACK, then END SESSION on the next
  POLL, state unchanged; 13 01 / 13 02 / 13 03 outside a session -> ACK only, logged as
  `[mdb] <name> received with no session open (state=...) - ACK only`. No VendListener callback fires for these,
  because the reader has no vend open.

### What the reader answers in each MDB state (8.2.1)

Two gates run before every state: a first byte outside 10-17 is another peripheral and is ignored; RESET (10) from
ANY state is ACKed and jumps to INACTIVE. Everything not listed for a state goes UNHANDLED (visible with
`setUnhandledVisibility:on`).

| machine sends | INACTIVE (setup) | DISABLED (set up, reader off) | ENABLED (ready) | VEND (session open) |
|---|---|---|---|---|
| POLL 12 | JUST RESET x5, then ACK | ACK | SESSION BEGIN when armed (auto / beginSession), else ACK | the queued reply: VEND APPROVED, VEND DENIED, SESSION CANCEL REQUEST, END SESSION - else ACK |
| SETUP CONFIG 11 00 | READER CONFIG DATA | READER CONFIG DATA (retry) | - | - |
| SETUP MAX/MIN 11 01 | ACK (L1: -> DISABLED) | ACK (retry) | - | - |
| EXPANSION REQUEST ID 17 00 | PERIPHERAL ID (L2: -> DISABLED; L3 stays) | PERIPHERAL ID (retry, L2+) | - | - |
| EXPANSION ENABLE OPTIONS 17 04 | ACK (L3: -> DISABLED) | ACK (retry, L3) | - | - |
| READER ENABLE 14 01 | ACK only with direct vend ON (8.2.1; stays INACTIVE) | ACK -> ENABLED, auto mode arms SESSION BEGIN | ACK, re-arms in auto mode | ACK |
| READER DISABLE 14 00 | ACK | ACK | ACK -> DISABLED | ACK, session closes with END SESSION on the next POLL |
| READER CANCEL 14 02 | CAN only with direct vend ON (8.2.1) | CAN | CAN | CAN, session cancelled per cancel mode, onVendFailure if a vend was open |
| VEND REQUEST 13 00 | only with direct vend ON: ACK -> VEND, onVendRequest | same | with direct vend ON or Always Idle declared: ACK -> VEND | ACK, onVendRequest; approveVend / cancelVend decide the next POLL |
| VEND CANCEL 13 01 | ACK only (8.2.1) | ACK only (8.2.1) | ACK only (8.2.1) | ACK; next POLL sends the cancel mode reply; onVendFailure (CANCELLED_BY_VMC) |
| VEND SUCCESS 13 02 | ACK only (8.2.1) | ACK only (8.2.1) | ACK only (8.2.1) | ACK; onVendSuccess; with Force End ON arms SESSION CANCEL REQUEST |
| VEND FAILURE 13 03 | ACK only (8.2.1) | ACK only (8.2.1) | ACK only (8.2.1) | ACK; onVendFailure (FAILED) |
| SESSION COMPLETE 13 04 | ACK, END SESSION on next POLL, stays (8.2.1) | same | same | ACK; next POLL sends END SESSION -> ENABLED (onVendFailure SESSION_ENDED if a vend was still open) |
| CASH SALE 13 05 | - | - | - | - (logged, unhandled) |
| REVALUE REQUEST 15 00 | - | - | - | REVALUE DENIED (L2+) |
| REVALUE LIMIT REQUEST 15 01 | - | - | - | REVALUE LIMIT AMOUNT (L2+) |

### 8.2.0 - force session end after vend (8 October 2026, no code change)

Field case: a machine keeps the session open after VEND APPROVED / VEND SUCCESS and never sends SESSION
COMPLETE, so the reader never gets to send END SESSION and the next customer cannot start. New persisted
setting **force session end** (default OFF): when ON, as soon as VEND SUCCESS is ACKed the reader
arms SESSION CANCEL REQUEST (04) for the next POLL; the VMC answers SESSION COMPLETE and the session closes with
END SESSION as usual. If the VMC's SESSION COMPLETE has already arrived, nothing extra is sent. The
VendListener callbacks are unchanged - only the wire-level close is forced.

- Dashboard: **Force End** toggle next to Direct Vend. Remote: `setForceSessionEnd:on|off`.
- Kotlin: `HardwareLib.setForceSessionEnd(Boolean)` / `HardwareLib.isForceSessionEnd`. SETTINGS_JSON: `forceSessionEndAfterVend`.
- Log: `[mdb] force session end: SESSION CANCEL REQUEST goes out on the next POLL (after VEND SUCCESS)`. A failed vend keeps the spec flow.
- Also in 8.2.0: when END SESSION goes out, every per-session flag is cleared (a forced cancel still armed, an
  approve that arrived after the machine cancelled, the pending-request flag), so nothing leaks into the next session.

### 8.1.0 - RS232 rules fire the VendListener; ready-feedback gate over several inputs (additive, no breaking change)

Nothing in the MDB path changed. Two additions, both off unless you use them:

#### RS232: a rule can carry an `event`

Until now an RS232 machine only reached the app through `Rs232Lib.vendRequestListener` (price) and
the raw exchange listener - PRODUCTION FAIL after a paid sale was just a log line. Now a rule can name
which `VendListener` callback it fires, so RS232 and MDB share the SAME three callbacks and the same
guarantee (exactly one onVendSuccess / onVendFailure per onVendRequest):

| `"event"` | fires | notes |
|---|---|---|
| `vendRequest` | `onVendRequest(amount, minorUnits, item)` | needs `priceHi`/`priceLo` or `amountStart`/`amountEnd`; price = minor units, amount = price / 100.0, item = -1 |
| `vendSuccess` | `onVendSuccess(-1)` | ignored (logged) when no vend is open |
| `vendFailure` | `onVendFailure()`, reason FAILED | refund here |
| `vendCancel` | `onVendFailure()`, reason CANCELLED_BY_VMC | void the hold here |

A new vendRequest while one is still open closes the first with SESSION_ENDED. The app still answers the
machine itself with `Rs232Lib.sendHex(...)` / `sendXorFrame(...)` - RS232 has no approve/deny command.
Rules without `event` behave exactly as before.

```json
{"setRs232Rules":[
  {"name":"PAYMENT_REQUEST","rx":"A0 01 *","tx":"","amountStart":4,"amountEnd":-1,"event":"vendRequest"},
  {"name":"PRODUCTION_OK",  "rx":"A0 03 00 07 53 55 43 43 45 53 53 E7 *","tx":"A1 03 00 02 4F 4B A4","event":"vendSuccess"},
  {"name":"PRODUCTION_FAIL","rx":"A0 03 00 06 46 41 49 4C 45 44 A6 *","tx":"A1 03 00 02 4F 4B A4","event":"vendFailure"},
  {"name":"CANCEL",         "rx":"A0 08 00 06 43 41 4E 43 45 4C A8","tx":"","event":"vendCancel"}
]}
```

`getRs232Rules` returns the `event` field too. Log: `[rs232] PRODUCTION_FAIL -> ...` then the usual
`[mdb] vend failed: FAILED - onVendFailure fires`.

#### Pulse: ready feedback on more than one digital input

The CM30 has three digital inputs. The gate can now require ALL of a set of inputs to show their ready
value before a pulse train goes out:

- remote: `setReadyFeedback:0=1,2=0` (input 0 must read 1 AND input 2 must read 0); the old
  `setReadyFeedback:[yes,]value[,channel]` and `off` forms still work and mean a one-input gate
- code: `PulseLib.setReadyFeedbackChannels(mapOf(0 to 1, 2 to 0))`; empty map = gate off;
  `PulseLib.setReadyFeedback(value, channel)` is now the one-entry case of it
- `checkMachineReady` / `isMachineReady()` reads every input and logs them all:
  `[pulse] ready feedback in0 expected=1 actual=1, in2 expected=0 actual=1 ready=false`
- persisted; `getSettings` adds `readyFeedbackChannels` as `{"0":1,"2":0}` next to the old
  single-channel keys, so existing dashboards keep working

#### Direct vend reports ENABLED_STATE on the state listener

Some machines in direct-vend mode never send READER ENABLE, so the bus stays INACTIVE/DISABLED although
vends work. Apps that gate their ready screen on the state listener saying `ENABLED_STATE` waited forever.
With direct vend ON the state listener (and `VMC_STATUS.state`) now report `ENABLED_STATE` whenever the
bus state is INACTIVE or DISABLED; the real bus state travels alongside as `VMC_STATUS.busState` with
`"directVend": true`. The listener fires immediately when `setDirectVend(true)` is called, and goes back to
the real state when it is turned off. VEND_STATE and a real ENABLED_STATE are reported as before.

Not yet run on a real CM30 - compiled and API-checked only. Dashboard Ready FB control is still single-channel.

### mqtt-lib 2.7.0 - presence (online/offline) fixes, connection counters, takeover detection (no code change)

Field case D-0130, 2026-10-07: the status topic flipped offline/online every 3 s. Pattern = online for 3.1 s,
offline for 60 ms = two live sessions with the SAME client id kicking each other (MQTT session takeover),
not a network problem. Fixed on our side as far as the library can, and made visible:

#### Presence fixes
- **Stable client id per process.** Before, every reconnect used a new `<deviceId>-<millis>` id, so after a
  cellular drop the broker kept the OLD half-open session alive (up to 45 s) with its Will still armed; when
  that Will finally fired it wrote a retained `offline` OVER the new session's `online` - the device
  showed offline while connected. Now the id is `<deviceId>-<random, fixed for the process>`: the broker
  closes the old session the moment the new one connects, its Will fires FIRST, our fresh `online` lands
  last. A fixed `clientId` you pass yourself is used untouched - never share one between two live clients.
- **Graceful stop sends DISCONNECT** after the retained `offline`, so the broker no longer fires the Will on
  top of it (no doubled offline, no late Will).
- **Backoff with jitter** instead of a flat 3 s: 3, 6, 12, 24, 48, 60 s + 0-1 s random on consecutive
  failures or short sessions; back to 3 s after a session lasts 30 s. Two colliding clients stop flapping
  the status topic every 3 s; a real outage still recovers in 3 s.

#### Counters you can see in the dashboard (kept since app start, nothing persisted)

| counter | meaning |
|---|---|
| sessionsEstablished | connects that reached CONNACK |
| connectionLosses | sessions that were up and then died (broker kick, EOF, ping failure) |
| failedConnectAttempts | retries that never reached CONNACK (unreachable, refused, timeout) |
| consecutiveShortSessions | sessions < 5 s in a row - 3 or more = `takeoverSuspected` |
| lastLossReason / lastLossAgoSec / lastSessionDurationSec | what killed the last session and when |

- every (re)connect publishes one log line: `[mqtt] reconnected as D-0130-3f2a - session #7, losses=6,
  failed attempts=0, previous session lasted 3 s, last loss: EOFException - TAKEOVER SUSPECTED (3 short
  sessions in a row)`, plus `MQTT_STATS:{...}`
- 3 short sessions in a row log once: `[mqtt] WARNING: 3 sessions in a row closed within 5 s of connecting
  ... another client is probably connected with client id 'X' (session takeover). Check for a duplicate
  device code or a second app instance.`
- new command `mqttStats` (alias `linkStats`) -> `MQTT_STATS:{...}`; `version` now also prints the
  client id and the three counters
- dashboard: new **link** badge in the sub-header (green = clean, amber = losses/retries, red = takeover
  suspected; hover for the details) and a **Link** button that sends `mqttStats`
- code: `MqttLib.statsJson()`, `MqttLib.connectionLosses` / `failedConnectAttempts` /
  `sessionsEstablished` / `activeClientId`

Demo/test APK: **MDB-Slave-2 v2.22.0 build 109** bundles hardware-lib 8.2.7 + mqtt-lib 2.8.0.

What the library cannot fix: two physical units provisioned with the same device code, or a second process
on the unit that connects with a fixed client id. The WARNING line above is how you spot that from the dashboard.

### Health check that can never get stuck (8.2.1) - no app change needed

Field case: with direct vend turned on remotely, the app's health check waited for an ENABLED_STATE event, missed it
(registered after it fired) and stayed on the health-check screen forever. Since 8.2.1 the library guarantees the
existing check sees the state, whatever way it looks for it:

- any `stateListener` / `addStateListener` / `statusListener` / `controlListener` registered at ANY time gets the
  current state immediately (VMC_STATUS and SETTINGS_JSON for control listeners);
- with direct vend ON every real bus transition re-announces ENABLED_STATE;
- **while direct vend is ON and the bus is still INACTIVE/DISABLED, ENABLED_STATE is re-sent to the state listeners
  every 5 s** until the bus becomes really ENABLED/VEND or direct vend goes off - so a listener with any timeout,
  registered in any order, sees it within 5 s (local listeners only; VMC_STATUS over MQTT stays event-driven);
- `HardwareLib.currentState` returns the same reported state (`busState` = the real one).

If the check is ever rewritten, this is the shape that needs none of the above:

```kotlin
fun waitForReader(onReady: () -> Unit) {
    // 1. ask first - with direct vend ON this already says ENABLED_STATE, bus still in setup or not
    if (HardwareLib.currentState == "ENABLED_STATE" || HardwareLib.currentState == "VEND_STATE") { onReady(); return }
    // 2. then listen - a listener registered now gets the current state IMMEDIATELY (replayed), then every change
    val l: (String) -> Unit = { state ->
        if (state == "ENABLED_STATE" || state == "VEND_STATE") onReady()
    }
    HardwareLib.addStateListener(l)       // remove with HardwareLib.removeStateListener(l) when done
}
```

Polling `HardwareLib.currentState` and waiting for the listener carry the same reported state. If the screen must show the real bus state as well, read `HardwareLib.busState` or
`VMC_STATUS.busState`.

## Android: what changes from 8.0.0 to 8.1.0 / 2.7.0 (nothing mandatory)

Both AARs are additive. An app built on 8.0.0 / 2.6.0 compiles unchanged against 8.1.0 / 2.7.0 and behaves the
same. The steps below are only for USING the new features. One behaviour change to know about is at the end.

### RS232 machines - get the vend events through the same VendListener as MDB

On 8.0.0 the app only got the price (`Rs232Lib.vendRequestListener`) and had to recognise PRODUCTION OK /
PRODUCTION FAIL / CANCEL itself from `Rs232Lib.exchangeListener` by rule name - most apps never did, so a
failed production after a paid sale was just a log line.

1. Put `"event"` on the rules (in `setRs232Rules`, or wherever the app loads them):

```json
{"setRs232Rules":[
  {"name":"PAYMENT_REQUEST","rx":"A0 01 *","tx":"","amountStart":4,"amountEnd":-1,"event":"vendRequest"},
  {"name":"PRODUCTION_OK",  "rx":"A0 03 00 07 53 55 43 43 45 53 53 E7 *","tx":"A1 03 00 02 4F 4B A4","event":"vendSuccess"},
  {"name":"PRODUCTION_FAIL","rx":"A0 03 00 06 46 41 49 4C 45 44 A6 *","tx":"A1 03 00 02 4F 4B A4","event":"vendFailure"},
  {"name":"CANCEL",         "rx":"A0 08 00 06 43 41 4E 43 45 4C A8","tx":"","event":"vendCancel"}
]}
```

   `vendRequest` needs a price position (`priceHi`/`priceLo` or `amountStart`/`amountEnd`) or the
   device rejects the rule.

2. Set `HardwareLib.vendListener` for RS232 machines too - the SAME object the app already has for MDB:

```kotlin
HardwareLib.vendListener = object : HardwareLib.VendListener {
    override fun onVendRequest(amount: Double, minorUnits: Int, itemNumber: Int) {   // itemNumber = -1 on RS232
        scope.launch {
            val ok = gateway.authorize(minorUnits)
            Rs232Lib.sendHex(if (ok) TX_PAYMENT_SUCCESS else TX_PAYMENT_FAILED)   // RS232: answer with bytes
        }
    }
    override fun onVendSuccess(itemNumber: Int) { scope.launch { gateway.capture(); ui.showDispensed() } }
    override fun onVendFailure() {
        when (HardwareLib.lastVendFailureReason) {
            HardwareLib.VendFailureReason.FAILED -> scope.launch { gateway.refund(); ui.resetToIdle() }           // PRODUCTION_FAIL
            HardwareLib.VendFailureReason.CANCELLED_BY_VMC -> scope.launch { gateway.voidHold(); ui.resetToIdle() } // CANCEL
            else -> scope.launch { gateway.voidHold(); ui.resetToIdle() }
        }
    }
}
```

   Same guarantee as MDB: every `onVendRequest` ends in exactly one `onVendSuccess` or `onVendFailure`.
   The price arrives as minor units (`amount` = minorUnits / 100.0).

3. Keep answering the machine with `Rs232Lib.sendHex(...)` / `sendXorFrame(...)` after the card result -
   unchanged, RS232 has no approve/deny command.

4. Optional: `Rs232Lib.vendRequestListener` still fires too; once the VendListener is wired it can be removed.

### Pulse machines - ready feedback on more than one input

On 8.0.0: `PulseLib.setReadyFeedback(value, channel)` / `setReadyFeedback:yes,value,channel` - one input.
Still works. To require several inputs at once:

```kotlin
PulseLib.setReadyFeedbackChannels(mapOf(0 to 1, 2 to 0))   // digital_in(0) must read 1 AND digital_in(2) must read 0
PulseLib.setReadyFeedbackChannels(emptyMap())              // gate off
```

   or over MQTT `setReadyFeedback:0=1,2=0`. If the app reads the gate back from `getSettings`, the new field
   is `readyFeedbackChannels` (`{"0":1,"2":0}`); the old `readyFeedbackValue` / `readyFeedbackChannel`
   keys still exist and show the first entry. `PulseLib.isMachineReady()` now checks every listed input.

### MDB - one behaviour change to know about

With direct vend ON (`setDirectVend(true)` / `setDirectVend:on`), the state listener now reports
`ENABLED_STATE` while the bus is still INACTIVE or DISABLED - this is what lets the app's ready/health
screen pass on machines that never send READER ENABLE. No code change needed. If any code treated
INACTIVE/DISABLED as "machine not up yet" in direct-vend mode, it will now see ENABLED instead; the real
bus state is in the VMC_STATUS heartbeat as `busState` (with `"directVend": true`).

### mqtt-lib 2.7.0 - no code change

Stable client id, backoff and the connection counters are automatic. A fixed `clientId` passed in
`MqttConfig` is still used exactly as given - never share one id between two live clients.

## Register listeners ONCE - the "every line shows 10 times" problem (field case, 8 Oct 2026)

A device log looked like this: each exchange once in the library's own words, then the same event ten more
times in the app's own format:

```
SETUP CONFIG rx=11 00 03 10 02 00 26 tx=READER CONFIG DATA level=3
[V/113] 11 00 03 10 02 00 26 | READER CONFIG DATA | 3
[V/113] 11 00 03 10 02 00 26 | READER CONFIG DATA | 3
... (x10)
```

The library emits every exchange exactly once. The repeats mean the app registered the SAME listener ten times.
`HardwareLib.addExchangeListener`, `addLogListener`, `addStateListener`, `addControlListener` and
`addRs232EventListener` keep a plain list: every call adds one more entry, nothing removes it, and the count
grows for as long as the app runs. The library's own bridge is guarded (`attachRabbahMqtt()` attaches once), so
duplicates always come from app code - typically a listener added in an Activity/Fragment `onCreate` or
`onResume` and never removed, a Service that restarts, or a reconnect handler that re-registers on every connect.

Rules:

1. Register listeners ONCE per process - in the Application class or a singleton. The listener slots are
   process-wide, not per screen.
2. If a screen must listen, keep the lambda in a field and call the matching `remove...Listener(sameReference)`
   in `onDestroy` / `onPause`. Removal only works with the exact reference that was added.
3. The single-slot vars (`HardwareLib.exchangeListener = ...`, `logListener = ...`) replace instead of adding -
   safe to assign again, but they are one slot each.
4. Check: the dashboard shows one line per exchange (it reads the MQTT stream, which is never duplicated); if the
   on-device view shows N copies, the app has N registrations.

## How we verify after deploy (from the dashboard)

Send these on the passthrough bar (or press the toolbar buttons):

| Send | Expect |
|---|---|
| `version` | `[remote] mqtt-lib 2.7.1, hardware-lib 8.2.1 - client id D-0130-3f2a, sessions=1 losses=0 failed attempts=0` |
| `help` | the full command list |
| `open` | `VMC_STATUS` + MDB logs start flowing |
| `mqttStats` | `MQTT_STATS:{...}` - the link badge in the dashboard fills in |

If `version` still says "unknown command", the old mqtt-lib AAR is still in the
APK (check for a duplicate/renamed AAR in libs/).

## The vend contract (unchanged since 8.0.0)

The listener is exactly three functions, and `onVendFailure()` is THE non-success outcome:

| callback | fires when |
|---|---|
| `onVendRequest(amount, minorUnits, item)` | customer selected an item - authorize, then `approveVend()` / `cancelVend()` |
| `onVendSuccess(item)` | machine confirmed the product was dispensed - capture |
| `onVendFailure()` | EVERY other end of a vend, exactly once: machine cancel (13 01 / 14 02), dispense failure (13 03), session ended with the vend still open (no cancel/failure at all), bus RESET / stop(). NOT your own cancelVend() (8.2.2: no echo - you asked for it, you are not told again) |

Guarantee: every VEND REQUEST ends in exactly one of onVendSuccess or onVendFailure, never both, never
neither. Reset the payment UI, dismiss the gateway popup and void the hold in `onVendFailure`; refund
there too if you had already called `approveVend()`. When the app needs to know WHICH case it was,
read `HardwareLib.lastVendFailureReason` (CANCELLED_BY_VMC / FAILED /
SESSION_ENDED / RESET) inside the callback.

```kotlin
HardwareLib.vendListener = object : HardwareLib.VendListener {
    override fun onVendRequest(amount: Double, minorUnits: Int, itemNumber: Int) {
        scope.launch { if (gateway.authorize(minorUnits)) HardwareLib.approveVend() else HardwareLib.cancelVend() }
    }
    override fun onVendSuccess(itemNumber: Int) { scope.launch { gateway.capture(); ui.showDispensed() } }
    override fun onVendFailure() {
        scope.launch {
            gateway.cancelInFlightUiAndVoid()           // dismiss popup / card read, void any hold
            if (approvedThisVend) gateway.refund()      // paid but nothing came out
            ui.resetToIdle()
        }
    }
}
```

The log stream shows `[mdb] vend failed: <reason> - onVendFailure fires` each time.
react-native-mdb: `onVendFailure` carries `{ reason }`. Java implementers must override all three (they compile as abstract); Kotlin may override only what it needs.

## Standing behaviour (unchanged)

### Nothing turns on by itself

- `autoAttachHardware` now defaults to **false**: a device boots UNATTACHED. Attach on demand
  with the dashboard HW toggle (`attachHardware`); a restart drops it again.
- `mqttLogsEnabled` now defaults to **false**: no remote log stream until the dashboard Logs
  toggle (`setMqttLogging:on`) turns it on - persisted per device once `HardwareLib.init()`
  has been called.
- Settings commands (`getSettings`, `setMqttLogging`, ...) now work even if the app never calls
  `HardwareLib.init(context)` (previously they threw and showed as "unknown command"); the
  device warns once that such settings are in-memory only. CALL `HardwareLib.init(context)`
  AT APP START in every mode (MDB and RS232) so the switches persist across restarts.

### Remote debug controls

The dashboard has toggle switches for both: **HW** (attachHardware / detachHardware - wire or
fully unwire hardware-lib remotely) and **Logs** (setMqttLogging:on|off - stream or mute the
hardware logs; commands and status stay alive while muted). All remote, no builds needed once
these AARs are deployed.

### Log codes

MDB log envelopes now carry message codes **110-136** — unified with the command/exchange
codes (the backend's MdbLogSchema enum keyed 110-136 works as-is). RS232 stays 137-143.
Builds on mqtt-lib <= 2.3.0 emitted 0-26 for the same MDB events; `getCodebook` always
returns the codes the running build actually emits.

Already verified end-to-end on a test device against uat-api.rabbah.sa:1883.
