# MDB on the CM30 - the complete guide to hardware-lib

hardware-lib 8.2.15 + mqtt-lib 2.8.0 + dashboard 8.2.13, 16 November 2026. Package `com.rabbah.mdb`, singleton
`HardwareLib`. This document is the one place that explains **what the library does on the MDB bus, every function
it exposes, every setting and payload you can configure, and how the dashboard, the backend and the Android app
reach it**. The per-topic guides (`VENDLISTENER-README.md`, `CANCEL-FLOW-README.md`, `SESSION-ENDED-README.md`,
`IMPLEMENTATION-README.md`, `API-REFERENCE.md`, `PULSE-README.md`, RS232 guide) go deeper on one subject each;
the release notes (`RELEASE-NOTES-8.2.x.md`) say what changed when.

---

## 1. What this is

The CM30 payment terminal sits inside a vending machine as **MDB Cashless Device #1** (address `0x10`). The
machine's controller (the VMC, the bus master) polls the reader many times per second; the reader may only answer,
never speak first. hardware-lib is that reader:

- it opens the CM30's MDB slave port through the vendor AAR (`CM30-HardwareLibrary-1.0.9.aar`, armeabi-v7a only),
- runs the MDB cashless state machine (setup handshake, enable/disable, session, vend, cancel, end),
- answers every frame inside the MDB reply window on its own bus thread,
- turns the vend into **three app callbacks** (`onVendRequest`, `onVendSuccess`, `onVendFailure`) on a separate
  ordered thread so the app can take a payment and tell the machine to dispense,
- keeps every reply payload, setting and switch **configurable and persisted** per machine,
- and exposes everything (log, status, settings, counters, remote commands) to the dashboard and the Rabbah
  backend through mqtt-lib, without containing any networking itself.

No networking in hardware-lib, no MDB in mqtt-lib. The only place the two meet is `attachRabbahMqtt()`, called by
mqtt-lib itself on connect.

## 2. Feature list

| area | feature | since |
|---|---|---|
| bus | MDB Cashless #1 slave on the CM30 vendor port, one bus loop per `start()` (generation counter, old loop joined on `stop()`) | 7.x / 8.2.12 |
| bus | Level 1, 2 and 3 handshakes; level byte, Peripheral ID and Begin Session payload follow the configured level | 7.x |
| bus | RESET from any state -> ACK, INACTIVE, JUST RESET announced on the next 5 POLLs | 7.x |
| bus | Other-peripheral addresses ignored; unknown commands logged as UNHANDLED (visible on demand) | 7.x |
| bus | Warm resume: READER ENABLE in INACTIVE with no RESET since start -> ACK + ENABLED (reader restarted, machine never noticed) | 8.2.13 |
| bus | CASH SALE (13 05) ACKed in every state, logged with price + item, counted | 8.2.14 |
| bus | REVALUE REQUEST -> REVALUE DENIED, REVALUE LIMIT REQUEST -> limit payload (Level 2+) | 7.x |
| session | Auto session (BEGIN SESSION armed on READER ENABLE and after every END SESSION, with a POLL cooldown) or manual (`beginSession()`) | 7.x |
| session | Direct vend: VEND REQUEST accepted outside a session (machines that skip the handshake); Always Idle read live from Peripheral ID bit | 8.2.1 |
| session | Force session end: SESSION CANCEL REQUEST after every VEND SUCCESS for machines that never send SESSION COMPLETE | 8.2.0 |
| session | Session-cancel retry: re-send an unanswered SESSION CANCEL REQUEST N times every M ms | 8.2.3 / 8.2.5 |
| vend | `approveVend()` -> VEND APPROVED at the requested price; `cancelVend()` -> SESSION CANCEL REQUEST or VEND DENIED (standing mode or per call) | 7.x |
| vend | Skip 00 00 vend: price-less VEND REQUESTs ACKed and dropped | 8.2.4 |
| vend | Every vend ends in exactly one of `onVendSuccess` / `onVendFailure(reason)`; six reasons | 8.0.0 / 8.2.5 / 8.2.6 |
| vend | Stale-approve protection: approval refused once a cancel or session end is armed; a new VEND REQUEST wipes every flag of the previous one; VEND SUCCESS for a dead vend ignored | 8.2.8 / 8.2.9 / 8.2.12 |
| vend | Cancel grace: a cancel arriving within 200 ms of the request has its failure delivered 500 ms later so the app UI has drawn the request | 8.2.7 / 8.2.10 |
| vend | Vend event gap: at least 500 ms between two callbacks reaching the app, in order | 8.2.11 |
| vend | Callback watchdog (3 s), exceptions caught, one ordered delivery thread, counters for everything | 8.2.2 / 8.2.6 |
| config | 13 named reply payloads editable as hex per machine, persisted, live on the next send; two Begin Session payloads (L1 / L2-3) with editable length | 7.x / 8.2.1 |
| config | 23 persisted settings, every one settable from code, dashboard and backend, echoed as `SETTINGS_JSON` | 7.x - 8.2.13 |
| observe | Log lines (screen / MQTT), structured exchange events with CMD codes 110-136, state and status feeds, `vendStats`, `VMC_STATUS` | 7.x / 8.2.2 |
| observe | Machine ready: `isMachineReady` / `machineReadyJson()` readable any time, `readyListener` replayed on registration then edge-only, `MACHINE_READY` control line, remote `getMachineReady`; covers MDB (reader ENABLED / VEND) and RS232 (machine heard, rule event `connect`, optional ready timeout) | 8.2.15 |
| remote | 50+ text commands via `handleCommand(text)` from any transport; dashboard passthrough bar and backend `cmd` topic | 7.x |
| test | `simulateExchange(hex)` drives the full pipeline without hardware; JVM bus-trace harness with 31 scenarios in `source/MdbSlaveApp/hardware-lib/bus-trace/` | 7.x / 8.2.8+ |
| siblings | `PulseLib` (coin-pulse output + machine-ready input on CM30 digital IO), `Rs232Lib` (serial rule engine for non-MDB machines) | 7.x |

## 3. How the reader works on the bus

### 3.1 States

```
          RESET (10) from anywhere
                 |
                 v
 INACTIVE  --setup done-->  DISABLED  --READER ENABLE-->  ENABLED  --BEGIN SESSION-->  VEND_STATE
 (setup)                   (reader off)                   (ready)                      (session open)
                                        <--READER DISABLE--        <----END SESSION-----
```

| state | meaning | leaves it on |
|---|---|---|
| INACTIVE | after RESET or `start()`; the machine runs the setup handshake | last setup step for the configured level (L1: SETUP MAX/MIN, L2: EXPANSION REQUEST ID, L3: EXPANSION ENABLE OPTIONS), or warm resume |
| DISABLED | set up, cashless disabled by the machine | READER ENABLE -> ENABLED |
| ENABLED | ready; in auto mode BEGIN SESSION is armed | the POLL that carries BEGIN SESSION -> VEND_STATE; READER DISABLE -> DISABLED |
| VEND_STATE | session open; VEND REQUEST / approval / success / failure / cancel happen here | the POLL that carries END SESSION -> ENABLED |

`currentState` is the *reported* state: with direct vend ON, INACTIVE and DISABLED read as `ENABLED_STATE`
(`busState` is always the real one).

### 3.2 What the reader answers in each state

Two gates run first: a first byte outside `10`-`17` is another peripheral and is ignored; RESET (`10`) from any
state is ACKed and jumps to INACTIVE. CASH SALE (`13 05`) is ACKed in every state. Everything not listed goes
UNHANDLED (visible with `setUnhandledVisibility:on`).

| machine sends | INACTIVE (setup) | DISABLED | ENABLED | VEND_STATE |
|---|---|---|---|---|
| POLL 12 | JUST RESET x5, then ACK | ACK | SESSION BEGIN when armed, else ACK | the queued reply: VEND APPROVED, VEND DENIED, SESSION CANCEL REQUEST, END SESSION - else ACK |
| SETUP CONFIG 11 00 | READER CONFIG DATA | READER CONFIG DATA (retry) | - | - |
| SETUP MAX/MIN 11 01 | ACK (L1: -> DISABLED) | ACK (retry) | - | - |
| EXPANSION REQUEST ID 17 00 | PERIPHERAL ID (L2: -> DISABLED; L3 stays) | PERIPHERAL ID (retry, L2+) | - | - |
| EXPANSION ENABLE OPTIONS 17 04 | ACK (L3: -> DISABLED) | ACK (retry, L3) | - | - |
| READER ENABLE 14 01 | warm resume ON and no RESET seen: ACK -> ENABLED (8.2.13); direct vend ON: ACK, stays | ACK -> ENABLED, auto mode arms SESSION BEGIN | ACK, re-arms in auto mode | ACK |
| READER DISABLE 14 00 | ACK | ACK | ACK -> DISABLED | ACK; END SESSION on the next POLL, open vend -> onVendFailure |
| READER CANCEL 14 02 | CAN only with direct vend ON | CAN | CAN | CAN; session cancelled per cancel mode; onVendFailure if a vend was open |
| VEND REQUEST 13 00 | direct vend ON: ACK -> VEND_STATE, onVendRequest | same | direct vend ON or Always Idle: ACK -> VEND_STATE | ACK, onVendRequest; approveVend / cancelVend decide the next POLL |
| VEND CANCEL 13 01 | ACK only | ACK only | ACK only | ACK; next POLL sends the cancel-mode reply; onVendFailure (CANCELLED_BY_VMC) |
| VEND SUCCESS 13 02 | ACK only | ACK only | ACK only | ACK; onVendSuccess (ignored if the vend was already closed); Force End ON arms SESSION CANCEL REQUEST |
| VEND FAILURE 13 03 | ACK only | ACK only | ACK only | ACK; onVendFailure (FAILED) |
| SESSION COMPLETE 13 04 | ACK, END SESSION on next POLL | same | same | ACK; next POLL END SESSION -> ENABLED (onVendFailure SESSION_ENDED if a vend was open) |
| CASH SALE 13 05 | ACK | ACK | ACK | ACK (logged with price + item, counted, no callback) |
| REVALUE REQUEST 15 00 | - | - | - | REVALUE DENIED (L2+) |
| REVALUE LIMIT REQUEST 15 01 | - | - | - | REVALUE LIMIT AMOUNT (L2+) |

### 3.3 A normal vend, step by step

```
VMC                               reader (hardware-lib)                 app
POLL ---------------------------> BEGIN SESSION (funds FF FF)
VEND REQUEST price item --------> ACK                                   onVendRequest(amount, minorUnits, item)
POLL ---------------------------> ACK (waiting)                         ... take the payment ...
                                                                        approveVend()
POLL ---------------------------> VEND APPROVED price
(dispenses)
VEND SUCCESS item --------------> ACK                                   onVendSuccess(item)   -> capture
SESSION COMPLETE ---------------> ACK
POLL ---------------------------> END SESSION                           (state ENABLED; auto mode re-arms BEGIN SESSION after the cooldown)
```

If the app calls `cancelVend()` instead, or the machine sends VEND CANCEL / READER CANCEL, the next POLL carries the
cancel-mode reply (SESSION CANCEL REQUEST or VEND DENIED) and the app gets `onVendFailure(reason)`. If the machine
answers VEND FAILURE after approval the app gets `onVendFailure(FAILED)` and must void. If the session ends with the
vend still open the app gets `onVendFailure(SESSION_ENDED)`. Every request ends in exactly one of success / failure.

### 3.4 Threads

- **Bus thread**: reads frames from the vendor port, decides the reply, writes it. Nothing else runs here.
- **Offload thread**: log lines, listeners, control lines.
- **Vend delivery thread** (one, ordered): the three VendListener callbacks. A callback is never delivered before
  the previous one returned; the vend event gap and the cancel grace are applied here. A callback running longer
  than 3 s logs a warning and counts in `callbackStuck`. Exceptions are caught and counted (`callbackThrew`).

The app must return from the callbacks immediately and do gateway work on its own thread.

## 4. Public API - every function

All calls return `Boolean` (true = done or queued, false = rejected with a log line saying why), except the hex
setters that return `null` on success or an error sentence.

### 4.1 Lifecycle

| function | what it does | remote |
|---|---|---|
| `init(context)` | loads persisted settings, payloads and RS232 rules, publishes the first `SETTINGS_JSON`. Idempotent. **Attach listeners before this.** Without it everything works in memory only and resets on restart. | |
| `start()` | opens the MDB port, starts the bus loop, state INACTIVE announced at once. False on a device without the CM30 runtime. | `open` |
| `stop()` | closes the port, joins the loop, closes any open vend with reason RESET. | `close` |
| `VERSION` | `"8.2.15"` | `version` (answered by mqtt-lib together with its own) |

### 4.2 The payment hook - `vendListener`

```kotlin
HardwareLib.vendListener = object : HardwareLib.VendListener {
    override fun onVendRequest(amount: Double, minorUnits: Int, itemNumber: Int) { /* authorize, then approveVend() or cancelVend() */ }
    override fun onVendSuccess(itemNumber: Int) { /* product dispensed - capture */ }
    override fun onVendFailure(reason: HardwareLib.VendFailureReason) { /* void / refund, reset the UI */ }
}
```

| callback | fires when |
|---|---|
| `onVendRequest(amount, minorUnits, itemNumber)` | the customer picked an item. `minorUnits` is the exact integer price (use it for money), `amount` the decimal for display, both scaled from READER_CONFIG_DATA. `itemNumber` is -1 when the machine omitted it. |
| `onVendSuccess(itemNumber)` | the machine confirmed the product came out. Capture here. |
| `onVendFailure(reason)` | exactly once for every request that did not reach success. The no-argument `onVendFailure()` still exists; the default `onVendFailure(reason)` calls it. |

| `VendFailureReason` | meaning | what the app does |
|---|---|---|
| `CANCELLED_BY_VMC` | the machine cancelled (VEND CANCEL or READER CANCEL): customer pressed cancel or the selection timed out | reset the UI |
| `CANCELLED_BY_APP` | the app's own `cancelVend()` | nothing more |
| `CANCELLED_BY_OPERATOR` | a dashboard / remote `cancelVend` | reset the UI |
| `FAILED` | VEND FAILURE after approval: product not dispensed | void / refund |
| `SESSION_ENDED` | the session ended with the vend open (no SUCCESS, FAILURE or CANCEL came) | approved: treat as FAILED; not approved: treat as cancel |
| `RESET` | bus RESET or `stop()` while the vend was open | void if approved |

`lastVendFailureReason` holds the last reason too (one global slot).

### 4.3 Vend actions

| function | what it does | remote |
|---|---|---|
| `beginSession()` | arms BEGIN SESSION for the next POLL. Only in ENABLED_STATE; the "card tap" in manual mode. Not needed in auto mode. | `beginSession` |
| `approveVend()` | arms VEND APPROVED at the requested price. False when no request is pending, or when a cancel reply / session end is already armed (the vend is over: void). | `vendApprove` |
| `cancelVend()` | cancels the live session on the next POLL with the standing cancel mode; closes an open vend with CANCELLED_BY_APP. False when no session is live. | `cancelVend` |
| `cancelVend(response)` | same, sending exactly `SESSION_CANCEL_REQUEST` or `VEND_DENIED` this once. | `cancelVend:sessionCancel` / `cancelVend:vendDenied` |

### 4.4 State and status

| member | what it gives |
|---|---|
| `currentState: String` | `INACTIVE_STATE` / `DISABLED_STATE` / `ENABLED_STATE` / `VEND_STATE`, as reported (direct vend rewrites INACTIVE/DISABLED to ENABLED) |
| `busState: String` | the real bus state |
| `isSessionActive` | true between BEGIN SESSION and END SESSION |
| `sessionId: String?` | the id that correlates every log line of the current vend |
| `stateListener` / `addStateListener`, `removeStateListener` | state name on every transition |
| `statusListener` | JSON `{"state","recentActivity"}` plus `busState` and `directVend` when they differ; same as the `VMC_STATUS:` control line. Event-driven, never periodic. |
| `isMachineReady` / `isMdbReady` / `isMdbHandshakeDone` (8.2.15) | idempotent readiness: reader running and reported state ENABLED / VEND (`isMdbReady`), or RS232 machine heard; `isMdbHandshakeDone` = SETUP done since `start()` |
| `machineReadyJson()` (8.2.15) | the readiness snapshot (`mdb` + `rs232` halves), same JSON as the `MACHINE_READY:` control line and remote `getMachineReady` |
| `readyListener` / `addReadyListener((ready, json))`, `removeReadyListener` (8.2.15) | current value once at registration, then only on change - the fix for "the machine finished its handshake before the app registered" |

### 4.5 Settings

Every setter persists, publishes a new `SETTINGS_JSON`, and has a remote command. Section 5 has the full table.

`setAutoSession`, `setAutoBeginCooldown`, `setCancelMode`, `setDirectVend`, `setForceSessionEnd`,
`setSessionCancelRetry(ms)`, `setSessionCancelRetry(ms, count)`, `setSessionCancelRetry(enabled)`,
`setCancelGrace(windowMs, delayMs)`, `setVendEventGap(ms)`, `setWarmResume`, `setSkipZeroVend`, `setMdbLevel(1|2|3)`,
`setMqttLogging`, `setPollVisibility`, `setUnhandledVisibility`, `setPeripheralVisibility`,
`setEmptySessionVisibility`, plus the read-backs `isAutoSession`, `autoBeginCooldown`, `isDirectVend`,
`isForceSessionEnd`, `isSessionCancelRetry`, `sessionCancelRetryWaitMs`, `sessionCancelRetryCount`,
`cancelGraceWindow`, `cancelGraceDelay`, `vendEventGap`, `isWarmResume`, `isSkipZeroVend`, `isMqttLoggingEnabled`,
and `currentSettingsJson()` for all of them at once.

### 4.6 Reply payloads (hex config)

| function | what it does | remote |
|---|---|---|
| `configNames()` | the 13 editable names (section 6) | |
| `getConfigHex(name)` | current bytes as space-separated hex | `getConfig` -> `CONFIG_JSON:` |
| `setConfigHex(name, hex)` | sets one payload, live on the next send; `null` on success, else e.g. `Wrong length for READER_CONFIG_INFO: got 34 byte(s), need 30` | `setConfig:NAME:hex` or `{"setConfig":{"NAME":"hex"}}` |
| `resetConfig(name)` | back to the library default | `resetConfig:NAME` |
| `configSnapshotJson()` | every payload as JSON | `getConfig` |

### 4.7 Price helpers

| function | what it does |
|---|---|
| `priceToAmount(raw): Double` | raw 16-bit MDB price -> decimal using scale factor (READER_CONFIG_DATA byte 4) and decimals (byte 5). Default scale 1, decimals 2: raw 350 -> 3.50 |
| `priceToMinorUnits(raw): Int` | raw x scale, integer only: raw 350 -> 350 halalas. Already applied before `onVendRequest`. -1 when the machine omitted the price |

### 4.8 Feeds, counters, remote control, test

| member | what it delivers |
|---|---|
| `logListener` / `addLogListener((line, showOnScreen))` | every log line; `showOnScreen=false` marks per-POLL noise |
| `exchangeListener` / `addExchangeListener((MdbExchangeEvent))` | one event per bus exchange: `code` (110-136), `rxHex`, `txName`, `params`, `message`, `sessionId`, `timestampMs`, `logEventName` |
| `controlListener` / `addControlListener((tag, json))` | `SETTINGS_JSON`, `CONFIG_JSON`, `VMC_STATUS`, `VEND_STATS`, `MACHINE_READY` (8.2.15), `LOG` |
| `addRs232EventListener((eventName, params))` | the coded RS232 events |
| `remove…Listener(sameReference)` | the matching removals; register once per process |
| `vendStatsJson()` (+ `vendRequestCount`, `vendSuccessCount`, `vendFailureCount`, `vendFailuresByReason`, `vendCallbackStuckCount`) | the counters of section 7 | 
| `handleCommand(text): Boolean` | feed a remote command from any transport; true when consumed |
| `attachRabbahMqtt()` / `detachRabbahMqtt()` | wire / unwire everything to mqtt-lib (commands in, logs + control lines out). mqtt-lib calls it on connect. |
| `attachLogSink((line))` | pipe every line and control snapshot into a transport of your own |
| `simulateExchange(rxHex, txName = "ACK")` | push a fake frame through classify -> template -> log / exchange listeners with no machine (not the state machine, so no VendListener callback); listeners run synchronously here. Remote `simulateExchange:10 10` |

## 5. Configuration - the 23 settings

Three ways to set each one, all equivalent and all persisted in `SharedPreferences` (`mdb_settings`) once `init()`
ran: the Kotlin function, the remote command (dashboard passthrough bar or backend `cmd` topic), or the backend
machine-settings key (applied by the app through the same function). `getSettings` echoes them all as
`SETTINGS_JSON:{...}`.

| setting | default | range | function | remote command | SETTINGS_JSON key | backend key |
|---|---|---|---|---|---|---|
| session mode | auto | auto / manual | `setAutoSession(Boolean)` | `setSessionMode:auto|manual` | `sessionBeginMode` | `auto_session` |
| auto-begin cooldown | 3 POLLs | 0-50 | `setAutoBeginCooldown(n)` | `setAutoBeginCooldown:N` | `autoBeginCooldownPolls` | `auto_begin_cooldown` |
| MDB level | 2 | 1 / 2 / 3 | `setMdbLevel(n)` | `setMdbLevel:1|2|3` | `mdbLevel` | `feature_level` |
| cancel mode | sessionCancel | sessionCancel / vendDenied | `setCancelMode(CancelResponse)` | `setCancelMode:sessionCancel|vendDenied` | `vmcCancelMode` | `vmc_cancel_mode` |
| direct vend | off | on / off | `setDirectVend(Boolean)` | `setDirectVend:on|off` | `directVend` | `mdb_direct_vend` |
| force session end after vend | off | on / off | `setForceSessionEnd(Boolean)` | `setForceSessionEnd:on|off` | `forceSessionEndAfterVend` | `mdb_force_session_end` |
| session-cancel retry wait | 0 (off) | 300-10000 ms, `on` = 1000 | `setSessionCancelRetry(ms)` | `setSessionCancelRetry:on|off|MS[,COUNT]` | `sessionCancelRetryMs` | `mdb_session_cancel_retry_ms` |
| session-cancel retry count | 3 | 1-10 | `setSessionCancelRetry(ms, count)` | same | `sessionCancelRetryCount` | `mdb_session_cancel_retry_count` |
| cancel grace window | 200 ms | 0-5000 (0 = off) | `setCancelGrace(window, delay)` | `setCancelGrace:on|off|WINDOW,DELAY` | `cancelGraceWindowMs` | `mdb_cancel_grace_window_ms` |
| cancel grace delay | 500 ms | 0-5000 | same | same | `cancelGraceDelayMs` | `mdb_cancel_grace_delay_ms` |
| vend event gap | 500 ms | 0-5000 (0 = off) | `setVendEventGap(ms)` | `setVendEventGap:on|off|MS` | `vendEventGapMs` | `mdb_vend_event_gap_ms` |
| warm resume | on | on / off | `setWarmResume(Boolean)` | `setWarmResume:on|off` | `warmResume` | `mdb_warm_resume` |
| skip 00 00 vend | off | on / off | `setSkipZeroVend(Boolean)` | `setSkipZeroVend:on|off` | `skipZeroVend` | `mdb_skip_zero_vend` |
| MQTT log lines | off | on / off | `setMqttLogging(Boolean)` | `setMqttLogging:on|off` | `mqttLogsEnabled` | `mdb_mqtt_logging` |
| show POLL traffic | off | on / off | `setPollVisibility(Boolean)` | `setPollVisibility:on|off` | `showPollTraffic` | - |
| show unhandled commands | off | on / off | `setUnhandledVisibility(Boolean)` | `setUnhandledVisibility:on|off` | `showUnhandledCmd` | - |
| show other peripherals | off | on / off | `setPeripheralVisibility(Boolean)` | `setPeripheralVisibility:on|off` | `showOtherPeripheral` | - |
| show empty sessions | off | on / off | `setEmptySessionVisibility(Boolean)` | `setEmptySessionVisibility:on|off` | `showEmptySessions` | - |
| pulse mode (PulseLib) | unset | high / low | `PulseLib.initPulse(highPulse)` | `initPulse:true|false` | `pulseMode` | - |
| ready feedback (PulseLib) | off | value / channel map | `PulseLib.setReadyFeedback(...)` | `setReadyFeedback:…` | `readyFeedbackEnabled`, `readyFeedbackValue`, `readyFeedbackChannel`, `readyFeedbackChannels` | - |

What each MDB setting is for:

- **Session mode.** Auto: the reader arms BEGIN SESSION as soon as the machine enables it and again after every
  END SESSION, so the customer can select first and pay after (the usual vending flow). Manual: a session only
  starts on `beginSession()`, the "card tap first" flow. Switching mid-session cancels the session.
- **Auto-begin cooldown.** Idle POLLs to let pass after END SESSION before re-arming BEGIN SESSION. Sielaff sends
  READER ENABLE after its first POLL; 3 keeps the two from colliding.
- **MDB level.** Decides the level byte in READER CONFIG DATA, which setup step ends INACTIVE, which Peripheral ID
  payload (30 or 34 bytes) is sent and which Begin Session payload (`SESSION_BEGIN` for L1, `SESSION_BEGIN_L2` for
  L2/3) is sent. Set it to what the machine's config menu says.
- **Cancel mode.** What `cancelVend()` sends and how the machine's own VEND CANCEL is answered: SESSION CANCEL
  REQUEST (machine answers SESSION COMPLETE, reader sends END SESSION) or VEND DENIED (session stays open).
- **Direct vend.** For machines that send VEND REQUEST without a proper handshake / session; the request is
  accepted from any state. Also reports ENABLED while the bus is INACTIVE/DISABLED so the app UI shows "ready".
- **Force session end.** For machines that never send SESSION COMPLETE after a vend: SESSION CANCEL REQUEST goes
  out after every VEND SUCCESS so the session closes.
- **Session-cancel retry.** When the machine ignores a SESSION CANCEL REQUEST, resend it after the wait, up to the
  count, then a WARNING. Stops on SESSION COMPLETE, END SESSION, RESET or a new VEND REQUEST.
- **Cancel grace.** A customer who presses cancel within 200 ms of the selection would otherwise produce a
  request and a failure the app renders in the same frame, leaving a stuck screen. The failure is held 500 ms.
- **Vend event gap.** Minimum spacing between two callbacks reaching the app, in order, so an app that animates
  each event never receives the next one mid-animation.
- **Warm resume.** After the app restarts (or dashboard Close/Open) the machine is still ENABLED and only sends
  READER ENABLE / POLL, never RESET; without this the reader stays INACTIVE forever (`UNHANDLED rx=14 01` loop).
- **Skip 00 00 vend.** Some machines send `13 00 00 00 ...` continuously until an item is chosen; the empty
  requests are ACKed and dropped.
- **MQTT log lines.** Whether plain log lines leave the device. Control lines and coded exchanges always flow.
- **Visibility switches.** Debug only: idle POLL/ACK, unhandled commands, other peripherals' traffic, empty
  auto-mode session cycles.

## 6. Configuration - the reply payloads

The bytes the reader puts on the bus, editable per machine with `setConfigHex(name, hex)`, the dashboard Config
panel, or `{"setConfig":{"NAME":"hex"}}`. Persisted in `mdb_config`. Fixed length unless noted (MDB max block is 36
bytes on the wire, so editable payloads cap at 35 data bytes; the checksum is always computed by the transport).

| name (`HardwareLib.ConfigName`) | default | bytes | sent as |
|---|---|---|---|
| `READER_CONFIG_DATA` | `01 02 19 78 01 02 E8 0B` | 8 | reply to SETUP CONFIG. Byte 1 = feature level (follows the level setting), bytes 2-3 country code `19 78` (BCD), byte 4 scale factor 1, byte 5 decimal places 2, byte 6 max response time `E8` = 232 s, byte 7 options `0B` |
| `READER_CONFIG_INFO` | `09 43 41 53 30 … 31 00 01` | 30 | Level 2 PERIPHERAL ID: manufacturer `CAS`, serial `000000000001`, model `000000000001`, software 0001 |
| `READER_CONFIG_INFO_L3` | same + `00 00 00 00` | 34 | Level 3 PERIPHERAL ID; the 4 extra bytes are the optional-feature bits, all zero. Bit 5 of the last byte = Always Idle, read live |
| `SESSION_BEGIN` | `03 FF FF` | 1-35 | Level 1 BEGIN SESSION, funds `FF FF` = unknown |
| `SESSION_BEGIN_L2` | `03 FF FF 00 00 00 01 00 00 00` | 1-35 | Level 2/3 BEGIN SESSION: funds + payment media id + payment type + payment data |
| `VEND_APPROVED` | `05 00 00` | 3 | price bytes filled at runtime from the request |
| `VEND_DENIED` | `06` | 1 | |
| `END_SESSION` | `07` | 1 | |
| `SESSION_CANCEL` | `04` | 1 | SESSION CANCEL REQUEST |
| `JUST_RESET` | `00` | 1 | first 5 POLLs after RESET |
| `CAN` | `08` | 1 | reply to READER CANCEL |
| `REVALUE_LIMIT` | `0F FF FF` | 3 | reply to REVALUE LIMIT REQUEST |
| `REVALUE_DENIED` | `0E` | 1 | reply to REVALUE REQUEST (the reader never credits media) |

The max response time (232 s) is how long the machine waits for the reader's vend decision, which is why a pending
payment never times out on the bus side.

Field case: if the bus shows more bytes than `03 FF FF` after BEGIN SESSION, the level is 2 or 3 and
`SESSION_BEGIN_L2` is the payload being sent; edit it (dashboard "Begin Session (Level 2/3)") or set the level to 1.

## 7. Observability

### 7.1 Exchange codes (`MdbCmd`, append-only)

| code | exchange | reply | code | exchange | reply |
|---|---|---|---|---|---|
| 110 | any other exchange | - | 124 | VEND SUCCESS 13 02 | ACK |
| 111 | RESET 10 | ACK | 125 | VEND FAILURE 13 03 | ACK |
| 112 | POLL 12 | JUST RESET | 126 | SESSION COMPLETE 13 04 | ACK |
| 113 | SETUP CONFIG 11 00 | READER CONFIG DATA | 127 | POLL 12 | END SESSION |
| 114 | EXPANSION REQUEST ID 17 00 | PERIPHERAL ID | 128 | VEND CANCEL 13 01 | ACK |
| 115 | SETUP MAX/MIN 11 01 | ACK | 129 | POLL 12 | SESSION CANCEL REQUEST |
| 116 | EXPANSION ENABLE OPTIONS 17 04 | ACK | 130 | REVALUE REQUEST 15 00 | REVALUE DENIED |
| 117 | READER ENABLE 14 01 | ACK | 131 | REVALUE LIMIT REQUEST 15 01 | REVALUE LIMIT AMOUNT |
| 118 | READER DISABLE 14 00 | ACK | 132 | CASH SALE 13 05 | ACK (price, item) |
| 119 | READER CANCEL 14 02 | CANCELLED | 133 | POLL 12 | ACK (idle) |
| 120 | POLL 12 | BEGIN SESSION | 134 | EXPANSION 17 xx | varies |
| 121 | VEND REQUEST 13 00 | ACK (price, item) | 135 | non-cashless address | ignored |
| 122 | POLL 12 | VEND APPROVED | 136 | unrecognized in this state | none (UNHANDLED) |
| 123 | POLL 12 | VEND DENIED | | | |

Each exchange is one `MdbExchangeEvent` on the exchange feed and, through mqtt-lib, one coded log item for the
backend (`MDB_VEND_REQUEST`, `MDB_CASH_SALE`, …) on the `logs` topic.

### 7.2 Log line prefixes

`[mdb]` engine, `[remote]` answers to remote commands, `[app]` rejected app calls, `[pulse]`, `[rs232]`. Per-POLL
noise is flagged `showOnScreen=false`.

### 7.3 Control lines

| line | content | when |
|---|---|---|
| `VMC_STATUS:{...}` | `state`, `recentActivity`, plus `busState` / `directVend` when they differ | on every state change and when bus activity appears / disappears (5 s silence) |
| `SETTINGS_JSON:{...}` | the 23 settings | after `init()`, after every setter, on `getSettings` |
| `CONFIG_JSON:{...}` | the 13 payloads | on `getConfig` and after a config change |
| `VEND_STATS:{...}` | the counters below | on `vendStats` |
| `MACHINE_READY:{...}` (8.2.15) | `ready`, `mdb{ready,running,handshake,state,busState,directVend,recentActivity,level}`, `rs232{ready,open,connected,lastRule,lastRxAgeMs,rules,connectRules,readyTimeoutMs}`, `at` | on every readiness change, once to a late control listener, on `getMachineReady` |

### 7.4 `vendStats` counters (since app start, not persisted)

| key | meaning |
|---|---|
| `vendRequests` / `vendSuccesses` / `vendFailures` | callbacks delivered |
| `vendFailuresByReason` | per `VendFailureReason` |
| `appCancels` / `operatorCancels` | `cancelVend()` from code / from the dashboard that closed an open vend |
| `approveIgnored` | `approveVend()` with nothing pending |
| `approveAfterCancel` | `approveVend()` refused because a cancel or session end was already armed (8.2.8) |
| `requestSupersededFlags` | flags of the previous vend wiped by a new VEND REQUEST (8.2.9) |
| `successIgnored` | VEND SUCCESS for a vend already closed (8.2.12) |
| `warmResumes` | reader restarts picked up as ENABLED (8.2.13) |
| `cashSales` | CASH SALE reports (8.2.14) |
| `callbackStuck` / `lastStuckCallback` / `lastStuckAgoSec` | the 3 s watchdog |
| `callbackThrew` / `noListener` | a callback threw / nobody registered |
| `sessionCancelRetries` / `sessionCancelGaveUp` | retry sent / gave up (8.2.3) |
| `zeroVendSkipped` | `00 00` requests dropped (8.2.4) |
| `failureDelayed` | failures held by the cancel grace (8.2.7) |
| `eventsSpaced` | callbacks that waited for the event gap (8.2.11) |
| `lastRequestAgoSec`, `lastFailureReason`, `vendOpen`, `listenerRegistered`, `sinceSec` | the current picture |

## 8. Remote commands

Text in, answered on the log stream. Accepted from the dashboard passthrough bar (`<prefix>/<deviceId>/passthrough`),
the backend `cmd` topic, or any transport the app feeds into `handleCommand(text)`.

```
open | close | beginSession | vendApprove | cancelVend[:sessionCancel|:vendDenied]
setCancelMode:sessionCancel|vendDenied | setSessionMode:auto|manual | setAutoBeginCooldown:0-50
setDirectVend:on|off | setForceSessionEnd:on|off | setSessionCancelRetry:on|off|MS[,COUNT]
setCancelGrace:on|off|WINDOW,DELAY | setVendEventGap:on|off|MS | setSkipZeroVend:on|off | setWarmResume:on|off
setMdbLevel:1|2|3 | setMqttLogging:on|off
setPollVisibility:on|off | setUnhandledVisibility:on|off | setPeripheralVisibility:on|off | setEmptySessionVisibility:on|off
getSettings | vendStats | getConfig | setConfig:NAME:hex | resetConfig:NAME | {"setConfig":{...}} | {"resetConfig":[...]}
simulateExchange:HEX | getMachineReady
initPulse:true|false | sendPulse:w,p,c | setReadyFeedback:[yes,]value[,channel]|ch=val,ch=val|on|off | checkMachineReady
rs232Open[:baud[,dataBits,stopBits,parity]] | rs232Close | rs232Send:HEX | rs232SendFrame:HEADER;DATAHEX
rs232SendAscii:HEADER;TEXT | rs232Simulate:HEX | rs232Crc:on|off | rs232Gap:MS | rs232ReadyTimeout:MS|off | getRs232Rules | clearRs232Rules | {"setRs232Rules":[...]}
ping | version | help | attachHardware | detachHardware | mqttStats        (the last five answered by mqtt-lib itself)
```

## 9. How the pieces connect

```
 vending machine ==MDB bus== CM30 vendor AAR == HardwareLib ==VendListener== Android app (payment, UI)
                                                    |  attachRabbahMqtt()
                                                 mqtt-lib 2.8.0
                                      /            |              \
                      <prefix>/<id>/logs    <prefix>/<id>/ops   <prefix>/<id>/cmd + /passthrough
                      coded MDB items       plain lines +       commands in (backend / dashboard)
                      for the backend       control lines       <prefix>/<id>/status: retained online/offline
                                                 |
                                    Hardware Dashboard (Electron, Windows / macOS)
```

- **mqtt-lib** owns the broker link (MQTT 3.1.1, TCP), retained presence on `status`, the coded log envelope
  (`RabbahLog`), the two inbound command topics and the `ops` channel. It knows nothing about MDB. On connect it
  reflectively calls `HardwareLib.attachRabbahMqtt()`.
- **The app** (`MdbMqttBridge.kt` in the demo app, or the RN module `react-native-mdb` 1.5.0) sets the listeners,
  calls `init`, `start`, and `approveVend` / `cancelVend` from the payment result. Backend machine-settings keys
  (section 5) are applied through the same setters.
- **The dashboard** (`dashboard-app/`, v8.2.13) subscribes to `logs` + `ops`, renders the live log, state, settings
  switches (session mode, cancel mode, level, direct vend, force end, retry, cancel grace, event gap, warm resume,
  skip 00 00), the Config panel for the 13 payloads, the Vend (stats) button, and the passthrough bar.

## 10. Integration in five lines

```kotlin
HardwareLib.vendListener = myListener            // 1. before init
HardwareLib.init(applicationContext)             // 2. persistence + first SETTINGS_JSON
MqttLib.start(context, MqttConfig(...))          // 3. optional: broker link, attaches hardware-lib itself
HardwareLib.start()                              // 4. open the bus
// 5. in onVendRequest: take the payment, then HardwareLib.approveVend() or HardwareLib.cancelVend()
```

Gradle:

```gradle
implementation files('libs/hardware-lib-8.2.15.aar')
implementation files('libs/mqtt-lib-2.8.0.aar')
implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
```

## 11. Testing without a machine

- `simulateExchange("13 00 01 86 00 33")` pushes a VEND REQUEST frame (price 390, item 51) through the classify,
  template and log / exchange listener pipeline on the calling thread, so the dashboard shows code 121. It does not
  run the state machine, so the VendListener does not fire; to exercise the listener without a machine use RS232
  rules with `event` (see `LISTENERS-README.md` section 12 and `VENDLISTENER-README.md` section 8).
- The JVM bus-trace harness in `source/MdbSlaveApp/hardware-lib/bus-trace/` (team `BusTrace.java` S1-S8 +
  `extra/BusTraceExtra*.java` S9-S28) runs the real `HardwareLib` class against a fake `MdbSlave` and asserts
  replies, callbacks and counters for every flow above (stale approve, cancel grace, event gap, warm resume, cash
  sale, …), S29-S31 (machine ready). All 31 scenarios pass on 8.2.15. `run.sh` inside builds and runs it.
- Nothing from 8.1.0 onward has yet run on a real CM30; the dashboard "Verify after deploy" rows in each release
  note are the field checklist.

## 12. Known limits

- SETUP and EXPANSION commands arriving in ENABLED or VEND_STATE are not answered (UNHANDLED).
- No timeout for a vend that gets neither VEND SUCCESS nor VEND FAILURE after approval (the machine's own 232 s
  applies on its side only).
- The vendor AAR is armeabi-v7a only; on any other device `start()` returns false and only `simulateExchange`
  works.
- The machine-setup template does not yet have fields for cancel grace, event gap and warm resume.

## 13. Where things live

| what | where |
|---|---|
| source of truth | `RabbahSystems/hardware-library` (private): `source/MdbSlaveApp/`, `libs/`, guides, `AAR-Update-latest.zip` |
| public mirror | `H2-designs/Hardware-Library` (no source, no demo APK) |
| React Native bridge | `H2-designs/Hardware-ReactNative` (`react-native-mdb`) |
| library code | `source/MdbSlaveApp/hardware-lib/src/main/java/com/rabbah/mdb/` - `HardwareLib.kt` (engine), `MdbSettings.kt`, `MdbConfigStore.kt`, `MdbSlaveWrapper.kt` (vendor port), `MdbCmd.kt` (codes), `PulseLib.kt`, `Rs232Lib.kt`, `Rs232Cmd.kt` |
| demo / test app | `source/MdbSlaveApp/app/` -> `MDB-Slave-2` APK (private release asset only; it embeds broker credentials) |
| dashboard | `dashboard-app/` (Electron; `npm start` on Windows or macOS) |
| releases | GitHub Releases `v8.2.15` on both repos: `AAR-Update-latest.zip`, dashboard zip, release notes |
