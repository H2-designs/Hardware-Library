# hardware-lib 8.2.2 - every public function, by protocol

Package `com.rabbah.mdb`. Three singletons: `HardwareLib` (MDB engine, settings, payloads, listeners),
`Rs232Lib` (serial rule engine), `PulseLib` (coin-pulse output). Every call returns `Boolean` (true = done or
queued, false = rejected, with a `[..]` log line saying why), except the hex setters that return `null` on
success or the error text. Companion docs: `AAR-HANDOFF-README.md` (what to do this release), `PULSE-README.md`,
`samples/`.

Start of every app, in every mode:

```kotlin
HardwareLib.init(applicationContext)   // persistence for settings + payloads; nothing persists without it
```

---

## 1. MDB - `HardwareLib`

### Lifecycle

| function | what it does |
|---|---|
| `init(context): Boolean` | Loads persisted settings and payloads, re-drives pulse polarity and the ready gate, registers the remote-command listener if mqtt-lib is initialised. Idempotent. |
| `start(): Boolean` | Opens the CM30 MDB port and starts the bus loop. State resets to INACTIVE and is announced at once. Remote: `open`. |
| `stop(): Boolean` | Closes the port, resets to INACTIVE, closes any open vend with reason RESET. Remote: `close`. |
| `VERSION` | `"8.2.2"`. Remote `version` reports it together with mqtt-lib. |

### The payment hook - `vendListener`

```kotlin
HardwareLib.vendListener = object : HardwareLib.VendListener {
    override fun onVendRequest(amount: Double, minorUnits: Int, itemNumber: Int) { /* authorize, then approveVend() or cancelVend() */ }
    override fun onVendSuccess(itemNumber: Int) { /* product dispensed - capture */ }
    override fun onVendFailure() { /* every other end of the vend, exactly once - void / refund, reset UI */ }
}
```

| callback | fires when |
|---|---|
| `onVendRequest(amount, minorUnits, itemNumber)` | the customer picked an item. `minorUnits` is the exact integer price (use it for money), `amount` the decimal for display, both already scaled from READER_CONFIG_DATA. `itemNumber` is -1 when omitted. |
| `onVendSuccess(itemNumber)` | the machine confirmed the product came out. Capture here. |
| `onVendFailure()` | exactly once for every request that did not reach success: machine cancel, dispense failure, session ended with the vend open, reset. NOT for your own `cancelVend()` (8.2.2: no echo). Reason in `lastVendFailureReason`. |

Rules: return immediately and do gateway work on your own thread (each callback runs on its own thread; one
running longer than 3 s logs a warning); every request ends in exactly one of success / failure; the interface is
three methods and Java implementers must override all three.

| member | what it does |
|---|---|
| `lastVendFailureReason: VendFailureReason?` | `CANCELLED_BY_VMC`, `FAILED`, `SESSION_ENDED`, `RESET` inside `onVendFailure`; `CANCELLED_BY_APP` is only recorded after your own `cancelVend()` (no callback since 8.2.2). One global slot, never cleared. |

### Vend counters - `vendStats` (8.2.2)

Since app start, never persisted, like the mqtt-lib link counters. Remote `vendStats` answers
`VEND_STATS:{...}` and a one-line `[remote] vend stats: ...` summary; the dashboard has a **Vend** button for it.

| key | meaning |
|---|---|
| `vendRequests` / `vendSuccesses` / `vendFailures` | callbacks delivered to the listener (requests count even with no listener) |
| `vendFailuresByReason` | `{"CANCELLED_BY_VMC":n,"CANCELLED_BY_APP":0,"FAILED":n,"SESSION_ENDED":n,"RESET":n}` |
| `appCancels` | `cancelVend()` calls that closed an open vend (silent since 8.2.2) |
| `approveIgnored` | `approveVend()` with no request pending (machine cancelled / timed out first) |
| `callbackStuck` | **the stuck-listener counter**: a callback still running after 3 s; `lastStuckCallback` names it, `lastStuckAgoSec` when |
| `callbackThrew` / `noListener` | a callback threw / an event had nobody registered |
| `lastRequestAgoSec`, `lastFailureReason`, `vendOpen`, `listenerRegistered`, `sinceSec` | the current picture |

Code: `HardwareLib.vendStatsJson()`, `vendRequestCount`, `vendSuccessCount`, `vendFailureCount`,
`vendFailuresByReason`, `vendCallbackStuckCount`. The watchdog log line now names the callback and the count:
`[mdb] WARNING: VendListener.onVendRequest has been running for 3000 ms (stuck #2) ...`.

### Vend actions

| function | what it does | remote |
|---|---|---|
| `beginSession(): Boolean` | Arms BEGIN SESSION for the next POLL - the "card tap" in manual session mode. In auto mode never needed. | `beginSession` |
| `approveVend(): Boolean` | Arms VEND APPROVED at the requested price. `false` when no VEND REQUEST is pending (a late approval can never charge the next customer). | `vendApprove` |
| `cancelVend(): Boolean` | Cancels the live session on the next POLL with the standing cancel mode. Works before or after a request. `false` when no session is live. An open vend is closed silently - no `onVendFailure` (8.2.2), `lastVendFailureReason` = CANCELLED_BY_APP. | `cancelVend` |
| `cancelVend(response): Boolean` | Same, sending exactly `SESSION_CANCEL_REQUEST` or `VEND_DENIED` this once. | `cancelVend:sessionCancel` / `:vendDenied` |

### State

| member | what it does |
|---|---|
| `currentState: String` | `INACTIVE_STATE`, `DISABLED_STATE`, `ENABLED_STATE`, `VEND_STATE` - the REPORTED state (with direct vend ON, INACTIVE/DISABLED read as ENABLED_STATE). `busState` is the real one. |
| `isSessionActive: Boolean` | true between BEGIN SESSION and END SESSION. |
| `stateListener` / `addStateListener` | plain state name, edge-triggered on every transition. |
| `statusListener` | JSON `{"state","recentActivity"}` plus `busState` and `directVend` when direct vend rewrites the state. Same payload as the `VMC_STATUS:` control line. |
| `sessionId: String?` | the id correlating every log of the current vend. |

### Settings - all persisted, all mirrored to the dashboard as `SETTINGS_JSON`

| function | what it does | remote | key |
|---|---|---|---|
| `setAutoSession(Boolean)` / `isAutoSession` | auto: sessions begin by themselves on READER ENABLE and after END SESSION; manual: only `beginSession()`. Switching mid-session cancels it. | `setSessionMode:auto|manual` | `sessionBeginMode` |
| `setAutoBeginCooldown(Int)` / `autoBeginCooldown` | auto mode only: idle POLLs after END SESSION before SESSION BEGIN is re-armed, 0-50, default 3 (Sielaff sends READER ENABLE after its first POLL). | `setAutoBeginCooldown:N` | `autoBeginCooldownPolls` |
| `setCancelMode(CancelResponse)` | what plain `cancelVend()` sends and how the machine's own VEND CANCEL is answered: `SESSION_CANCEL_REQUEST` or `VEND_DENIED`. | `setCancelMode:sessionCancel|vendDenied` | `vmcCancelMode` |
| `setDirectVend(Boolean)` / `isDirectVend` | ON: a VEND REQUEST is accepted in INACTIVE / DISABLED / ENABLED (machines that skip the handshake); the state listener reports ENABLED_STATE while the bus is INACTIVE/DISABLED. | `setDirectVend:on|off` | `directVend` |
| `setForceSessionEnd(Boolean)` / `isForceSessionEnd` | ON: after every VEND SUCCESS the reader sends SESSION CANCEL REQUEST on the next POLL, for machines that never send SESSION COMPLETE. Failed vends keep the spec flow. | `setForceSessionEnd:on|off` | `forceSessionEndAfterVend` |
| `setMdbLevel(1|2|3)` | handshake variant, level byte in READER CONFIG DATA, which Begin Session / Peripheral ID payload is sent. | `setMdbLevel:N` | `mdbLevel` |
| `setMqttLogging(Boolean)` / `isMqttLoggingEnabled` | stream the log lines over MQTT or not (default OFF; control lines always flow). | `setMqttLogging:on|off` | `mqttLogsEnabled` |
| `setPollVisibility` / `setUnhandledVisibility` / `setPeripheralVisibility` / `setEmptySessionVisibility` | log-debug switches: idle POLL/ACK, commands we could not answer, traffic for other peripherals, empty auto-mode session cycles. | `set...Visibility:on|off` | `showPollTraffic`, `showUnhandledCmd`, `showOtherPeripheral`, `showEmptySessions` |
| `currentSettingsJson(): String` | everything above as one JSON. | `getSettings` | |

### Hex payloads - the bytes the reader sends, editable per machine

| function | what it does | remote |
|---|---|---|
| `configNames(): List<String>` | the editable names (below). | |
| `getConfigHex(name): String` | current bytes, space-separated hex. | `getConfig` -> `CONFIG_JSON:` |
| `setConfigHex(name, hex): String?` | sets one payload; `null` on success, else the error ("Wrong length for X: got 34 byte(s), need 30"). Live on the next send. | `setConfig:NAME:hex` or `{"setConfig":{"NAME":"hex"}}` |
| `resetConfig(name): Boolean` | back to the library default. | `resetConfig:NAME` or `{"resetConfig":["NAME"]}` |
| `configSnapshotJson(): String` | all payloads as JSON. | `getConfig` |
| `setReplyHex(code, hex)` / `getReplyHex(code)` / `replyWireHex(code)` / `replyConfigName(code)` | the same by MDB exchange code (110-136) instead of name; `replyWireHex` includes the checksum. | |
| `lastReceivedHex(code)` / `lastReceivedJson()` | the last frame the machine sent per code. | |

`HardwareLib.ConfigName.*` and their locked lengths:

| name | bytes | used at |
|---|---|---|
| `READER_CONFIG_DATA` | 8 | all levels; byte 2 = level |
| `READER_CONFIG_INFO` | 30 | Level 2 Peripheral ID |
| `READER_CONFIG_INFO_L3` | 34 | Level 3 Peripheral ID; bit 5 of the last byte = Always Idle |
| `SESSION_BEGIN` | 1-35 | Level 1 Begin Session, default 3 |
| `SESSION_BEGIN_L2` | 1-35 | Level 2/3 Begin Session, default 10 |
| `VEND_APPROVED` | 3 | price bytes filled at runtime |
| `REVALUE_LIMIT` / `REVALUE_DENIED` | 3 / 1 | Level 2/3 |
| `JUST_RESET`, `CAN`, `VEND_DENIED`, `END_SESSION`, `SESSION_CANCEL` | 1 | single response codes |

### Price helpers

| function | what it does |
|---|---|
| `priceToAmount(raw): Double` | raw 16-bit MDB price -> decimal, scale factor and decimals applied. |
| `priceToMinorUnits(raw): Int` | raw -> exact integer minor units. Already applied before `onVendRequest`. |

### Log and event feeds

| member | what it delivers |
|---|---|
| `logListener` / `addLogListener((line, showOnScreen))` | every log line; `showOnScreen=false` marks per-poll noise - never render those into a growing view. |
| `exchangeListener` / `addExchangeListener((MdbExchangeEvent))` | one structured event per bus exchange: `code` (110-136), `rxHex`, `txName`, `params`, `message`, `sessionId`, `timestampMs`. |
| `controlListener` / `addControlListener((tag, json))` | `SETTINGS_JSON`, `CONFIG_JSON`, `VMC_STATUS`, `LOG`. |
| `addRs232EventListener((eventName, params))` | the coded RS232 events 137-143. |
| `remove...Listener(sameReference)` | the matching removals. The `add` lists never deduplicate: register once per process (see the handoff README). |
| `attachRabbahMqtt()` / `detachRabbahMqtt()` | wire / unwire everything to mqtt-lib (remote commands in, logs and control lines out). Idempotent. mqtt-lib can do this itself on connect. |
| `attachLogSink((line))` | pipe every line and control snapshot into any transport of your own. |
| `handleCommand(text): Boolean` | feed a remote command from any transport; true when consumed. |
| `simulateExchange(hex)` | push a fake frame through the engine with no machine (test). Remote: `simulateExchange:10 10`. |

---

## 2. RS232 - `Rs232Lib`

The machine sends frames over the CM30 serial port; the library matches each frame against a rule table and
replies. Frames are cut by silence (`frameGapMs`). First matching rule wins.

### Setup

| function | what it does | remote |
|---|---|---|
| `init(context)` | persistence for rules and the CRC flag. `HardwareLib.init(context)` already calls it, so apps that initialise HardwareLib need nothing extra. | |
| `setRulesJson(json, persist = true): String?` | load the whole table (max 20 rules); `null` on success, else the error. Hot-reloaded. | `{"setRs232Rules":[...]}` |
| `rulesJson(): String` | the current table. | `getRs232Rules` -> `RS232_RULES_JSON:` |
| `clearRules(): Boolean` | empty the table (frames then only log as UNMATCHED). | `clearRs232Rules` |
| `open(baud = 9600, dataBits = 8, stopBits = 1, parity = 'N', flowControl = 'N', port = 0): Boolean` | open the port and start listening. | `rs232Open[:baud[,dataBits,stopBits,parity]]` |
| `close(): Boolean` / `isOpen` | stop / status. | `rs232Close` |
| `setCrcCheck(Boolean)` / `crcCheckEnabled` | discard frames whose last byte is not the XOR of the rest (persisted). | `rs232Crc:on|off` |
| `frameGapMs` (var, default 1000) | silence that ends a frame; the reply goes out this long after the machine's last byte. | `rs232Gap:MS` |

### A rule

```json
{"name":"PAYMENT_REQUEST","rx":"A0 01 *","tx":"","amountStart":4,"amountEnd":-1,"event":"vendRequest"}
```

| field | meaning |
|---|---|
| `rx` | hex pattern; `??` = any one byte, trailing `*` = any number of remaining bytes; without `*` the length must match |
| `tx` | hex reply sent immediately on match; `""` = match and report, send nothing |
| `priceHi` / `priceLo` | byte positions of a binary price (hi*256+lo); negative counts from the end |
| `amountStart` / `amountEnd` | ASCII digit price inside the frame; end is exclusive, -1 = up to the CRC |
| `event` (8.1.0) | `vendRequest` (needs a price), `vendSuccess`, `vendFailure`, `vendCancel` -> fires `HardwareLib.vendListener` exactly like MDB (price as minor units, item -1; reasons FAILED / CANCELLED_BY_VMC) |

### Sending

| function | what it does | remote |
|---|---|---|
| `sendHex(hex): Boolean` | raw bytes. | `rs232Send:HEX` |
| `buildXorFrame(headerHex, dataHex = ""): String` | `[header][2-byte length][data][XOR]`, returns the hex. | |
| `sendXorFrame(headerHex, dataHex = ""): Boolean` | build and send. | `rs232SendFrame:HEADER;DATAHEX` |
| `sendXorAscii(headerHex, text): Boolean` | same with an ASCII payload: `("A1 02", "SUCCESS")`. | `rs232SendAscii:HEADER;TEXT` |
| `asciiHex(text): String` | `"SUCCESS"` -> `53 55 43 43 45 53 53`. | |
| `simulateFrame(hex): Boolean` | fake a received frame through the matcher; the reply is written when the port is open, otherwise logged. | `rs232Simulate:HEX` |

### Listening

| member | what it delivers |
|---|---|
| `vendRequestListener: (price, frameHex)` | fires when a matched rule extracted a price. Still works beside `event`. |
| `exchangeListener: (Rs232Exchange)` | every coded event 137-143: `code`, `eventName`, `params`, `message`, `rxHex`, `ruleName` (null = unmatched), `txHex` (null = nothing sent), `price` (-1 = none), `timestampMs`. |
| `HardwareLib.vendListener` | via rule `event` - the recommended path for payments. |

RS232 has no approve/deny command: the app answers the machine with `sendHex` / `sendXorAscii` after the card
result. Constants: `MAX_RULES = 20`, `NO_INDEX`, `EVENT_VEND_REQUEST` etc.

---

## 3. Pulse - `PulseLib`

Credit as coin pulses on one digital output; optional "ready" digital input(s). Full guide: `PULSE-README.md`.

| function | what it does | remote |
|---|---|---|
| `initPulse(highPulse: Boolean): Boolean` | set polarity once: true = HIGH pulses / idle LOW, false = the reverse. Persisted as `pulseMode` and re-driven by `HardwareLib.init`. Nothing pulses before it. | `initPulse:true|false` |
| `sendPulse(widthMs, periodMs, count): Boolean` | one train; BLOCKS about period x count; true only when every pulse went out. Rejected (false + log) when not initialised, width<1, period<width, period==width with count>1, count<1, queue (100) full, gate not ready, hardware error. Never on the UI thread. | `sendPulse:w,p,c` |
| `setReadyFeedback(expectedValue: Int?, channel = 0)` | one-input gate: input must read the value before any train; `null` = off. Persisted. | `setReadyFeedback:[yes,]value[,channel]` / `:off` |
| `setReadyFeedback(supported: Boolean, expectedValue: Int?, channel = 0)` | backend-model form: `supported=false` or null value = off. | same |
| `setReadyFeedbackChannels(map: Map<Int, Int>)` (8.1.0) | several inputs (0..2 on the CM30): every listed input must show its value; empty map = off. | `setReadyFeedback:0=1,2=0` |
| `enableReadyFeedback()` | re-arm the last saved gate. | `setReadyFeedback:on` |
| `isMachineReady(): Boolean` | read the gated inputs now; true when all match or the gate is off; logs what it read. `sendPulse` runs it itself. | `checkMachineReady` |
| `isInitialized` / `isHighPulse` / `pendingTrains` | polarity set this run / current polarity / trains waiting. | |
| `readyFeedbackChannels: Map<Int,Int>` / `readyFeedbackValue` / `readyFeedbackInputChannel` | the armed gate. | |
| `vendorPulse(p1, p2, p3, p4)` | raw passthrough to the vendor pulser - experiments only, wrong count on real hardware. | |

Settings keys: `pulseMode`, `readyFeedbackEnabled`, `readyFeedbackValue`, `readyFeedbackChannel`, `readyFeedbackChannels`.

---

## 4. Remote command cheat sheet (dashboard passthrough bar or the backend cmd topic)

```
open | close | beginSession | vendApprove | cancelVend[:sessionCancel|:vendDenied]
setCancelMode:sessionCancel|vendDenied | setSessionMode:auto|manual | setAutoBeginCooldown:0-50
setDirectVend:on|off | setForceSessionEnd:on|off | setMdbLevel:1|2|3 | setMqttLogging:on|off
setPollVisibility:on|off | setUnhandledVisibility:on|off | setPeripheralVisibility:on|off | setEmptySessionVisibility:on|off
getSettings | vendStats | getConfig | setConfig:NAME:hex | resetConfig:NAME | {"setConfig":{...}} | {"resetConfig":[...]} | simulateExchange:HEX
initPulse:true|false | sendPulse:w,p,c | setReadyFeedback:[yes,]value[,channel]|ch=val,ch=val|on|off | checkMachineReady
rs232Open[:baud[,dataBits,stopBits,parity]] | rs232Close | rs232Send:HEX | rs232SendFrame:HEADER;DATAHEX | rs232SendAscii:HEADER;TEXT
rs232Simulate:HEX | rs232Crc:on|off | rs232Gap:MS | getRs232Rules | clearRs232Rules | {"setRs232Rules":[...]}
ping | version | help | attachHardware | detachHardware | mqttStats          (the last five answered by mqtt-lib itself)
```

Replies come back on the device's log stream: plain `[remote]` / `[mdb]` / `[rs232]` / `[pulse]` lines, and the
control lines `SETTINGS_JSON:`, `CONFIG_JSON:`, `RS232_RULES_JSON:`, `VMC_STATUS:`, `MQTT_STATS:`, `PONG`.
