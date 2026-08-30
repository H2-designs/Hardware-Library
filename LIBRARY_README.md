# mdb-lib + mqtt-lib — integration guide

Two Android libraries extracted from the proven MDB Slave app:

| Artifact | What it is |
|---|---|
| `mqtt-lib-1.3.1.aar` | MQTT 3.1.1 transport (queue + publisher thread + auto-reconnect, with broker **username/password** auth) **plus the Rabbah compact-log layer**: `RabbahLog` (one function to ship a log), the unified MDB/INFO codebooks, and `RabbahMqtt` (send/receive logs, text or JSON on any topic — usable with zero MDB involvement). |
| `mdb-lib-6.4.1.aar` | The full MDB Cashless Device #1 slave (levels 1/2/3, config store, settings) for real CM30 hardware. Every bus exchange ships as ONE unified log code carrying both **rx** (frame received) and **tx** (our reply). |

## RabbahLog — sending logs (the compact codebook envelope)

MQTT has two producers, both exiting through the same bounded queue:

- **Part 1 — mdb-lib, automatic.** Nothing to call: every exchange becomes one unified
  `MdbLogEvent` where `p[0]` = rx frame hex and `p[1]` = tx reply name. A session id is set on
  SESSION BEGIN and cleared after END SESSION, correlating every log of one vend.
- **Part 2 — your app, plain functions:**

```kotlin
RabbahLog.init("vending-app", "2.13.5")          // once — names the emitter on every item

RabbahLog.raw("payment gateway responded in 420ms")          // free text
RabbahLog.rawError("gateway timeout after 3 retries")        // free text, severity=e
RabbahLog.log(MdbLogEvent.MDB_VEND_REQUEST,                  // typed event
              "13 00 01 F4 00 03", "ACK", "500", "3")
```

On the wire each call is one compact item on the `liveLog` topic — identical envelope to the
production Rabbah Log Codebook (`t/s/m/a/v/k/i/d/p`, single-letter keys, positional params):

```
RABBAH_LOG:{"t":"1787743651002","s":"MDB","m":"13","a":"vending-app","v":"2.13.5",
            "k":"i","i":"7c1f2a9b","d":1,"p":["13 00 01 F4 00 03","ACK","500","3"]}
```

The dashboard decodes codes back into sentences using the codebook the device itself serves
(`getCodebook` → `CODEBOOK_JSON:{…}`), so decode tables can never drift from the emitting
build. `RabbahLog.makeLogJson(...)` builds the envelope without sending;
`RabbahLog.format(event, params)` renders the sentence locally.

## RabbahMqtt — the generic MQTT API (no MDB required)

The one-stop surface for an Android app that just wants to talk to the broker. Everything is
queued (never blocks, buffers offline, silent no-op when MQTT is off), and every subscription
re-establishes itself on reconnect.

```kotlin
// logs — ride the RABBAH_LOG envelope, render on the dashboard automatically:
RabbahMqtt.sendLog("payment gateway responded in 420ms")
RabbahMqtt.sendError("gateway timeout after 3 retries")

// generic inbox — plain-text messages on the commands topic:
val cmdSub = RabbahMqtt.onCommand { cmd ->
    when (cmd) {
        "rebootKiosk" -> { scheduleReboot(); true }   // true = consumed, chain stops
        else -> false                                 // false = let other listeners look
    }
}
RabbahMqtt.removeCommand(cmdSub)

// any custom channel "<prefix>/<deviceId>/<suffix>", both directions, both formats:
RabbahMqtt.sendJson("telemetry", JSONObject().put("battery", 87))
RabbahMqtt.sendText("status", "READY")
val s1 = RabbahMqtt.subscribeJson("inbox")   { json -> ... }   // non-JSON arrives as {"raw": "..."}
val s2 = RabbahMqtt.subscribeText("control") { text -> ... }
RabbahMqtt.unsubscribe(s1)
```

Handlers run on the MQTT reader thread — return quickly, never block, hop to your own thread
for real work. Topics are always `<prefix>/<deviceId>/<suffix>`; callers never build one.

## Broker auth (private mosquitto etc.)

```kotlin
MqttLib.init(MqttConfig(
    topicPrefix = "cm30-mdb/hamdan-rabbah", deviceId = myDeviceId,
    brokerHost = "YOUR-SERVER-IP", brokerPort = 1883,
    username = "rabbah", password = "…"
))
```

The `log-viewer.html` dashboard can point at the same broker via its **WebSocket** listener
(mosquitto needs `listener 9001` + `protocol websockets`): open it once as
`log-viewer.html?broker=ws://YOUR-SERVER:9001&user=rabbah&pass=…` — values persist in
localStorage (query wins over stored). A browser cannot speak plain TCP 1883.

`rabbahlog-sample-v1.2.apk` (in `dist/`) is the proof app: editable broker settings on screen,
buttons for raw log / MDB example / telemetry JSON / burst, a live `queued/sent/dropped`
status line, and an `inbox` subscription you can hit with `mosquitto_pub`.

## Gradle setup

Preferred: consume the modules directly (`implementation project(':mdb-lib')`,
`project(':mqtt-lib')`) — see the demo `app/`.

If consuming raw AARs instead: add `mqtt-lib-1.3.1.aar`, `mdb-lib-6.4.1.aar`, **and**
`CM30-HardwareLibrary-1.0.9.aar` (mdb-lib needs it at runtime; AARs do not nest).

## Integration — the whole thing

```kotlin
// once, at startup (Application or first Activity):
MqttLib.init(MqttConfig(topicPrefix = "cm30-mdb/hamdan-rabbah", deviceId = myDeviceId))
MqttLib.start()
MdbLib.init(applicationContext)
MdbLib.start()
// Done. All MDB data now flows to the dashboard; all remote commands work.
```

### Sending your own logs (the queue)

Never publish directly — push to the same queue the MDB library uses. It never blocks,
never touches the network on your thread, buffers while offline, and keeps ordering:

```kotlin
RabbahMqtt.sendLog("payment gateway responded in 420ms")   // compact envelope (preferred)
MqttLib.enqueue("[app] plain legacy line")                 // raw string, still works
```

### Handling your own remote commands

```kotlin
RabbahMqtt.onCommand { cmd ->
    if (cmd == "rebootKiosk") { doReboot(); true }   // true = consumed
    else false                                       // false = let others handle it
}
```
MDB commands are consumed by mdb-lib's own listener automatically. `ping` is answered
(`PONG`) by mqtt-lib itself. Anything nobody consumes is reported back as unknown.

### Local UI mirror (optional)

```kotlin
MdbLib.logListener = { line, showOnScreen -> /* your on-screen log */ }
MdbLib.statusListener = { json -> /* {"state": "...", "recentActivity": true} */ }
```
Do NOT render lines with `showOnScreen == false` into a growing text view — that is
per-poll traffic and will freeze a UI on real hardware. Do NOT re-enqueue these lines;
the library already did.

### Taking payments — the VendListener

This is the payment-gateway hook. `onVendRequest` fires when the customer selects an item;
run the gateway call on your own thread and answer with `approveVend()` / `cancelVend(...)` —
the library keeps the VMC waiting correctly in the meantime (per-spec delayed response):

```kotlin
MdbLib.vendListener = object : MdbLib.VendListener {
    override fun onVendRequest(amount: Double, minorUnits: Int, itemNumber: Int) {
        // minorUnits = 350 (EXACT integer halalas - use for the gateway & money math)
        // amount     = 3.5 (decimal, for display; format with "%.2f" to show 3.50)
        // The library already applied the scale factor. Pay async:
        scope.launch {
            val approved = paymentGateway.charge(minorUnits)       // your gateway call
            if (approved) MdbLib.approveVend()
            else MdbLib.cancelVend()   // uses the standing mode set once via setCancelMode(...)
        }
    }
    override fun onVendSuccess(itemNumber: Int) { scope.launch { paymentGateway.capture() } }
    override fun onVendFailure()                { scope.launch { paymentGateway.refund() } }
    override fun onSessionEnded()               { /* per-session cleanup */ }
}
```

Callbacks fire on a dedicated callback thread, never the bus thread — a slow callback can
not make a response miss the VMC's reply window, but still return promptly and run gateway
calls on your own thread. Exceptions you throw are caught and logged, never fatal. The price
comes pre-scaled in two forms: `minorUnits: Int` (exact integer halalas/cents — use for the
gateway and all money math) and `amount: Double` (decimal, for display — floating point, so
format with `%.2f` and never accumulate totals with it). `itemNumber` stays the raw 16-bit
item code; all are `-1`/`-1.0` if the VMC omitted those bytes.

### MDB control API

Every control exists in BOTH forms — a public function for a standalone app that runs
everything manually with no dashboard, and the equivalent dashboard MQTT command. Both call
the same code, settings persist on the device either way, and every change is reported back
in `SETTINGS_JSON:` so a dashboard (if one is watching) always shows the real values.

| App function | Dashboard command | What it does |
|---|---|---|
| `MdbLib.start()` / `stop()` | `open` / `close` | Open/close the MDB port + worker loop |
| `MdbLib.beginSession()` | `beginSession` | Start a session (the "card tap"; needed in manual mode) |
| `MdbLib.approveVend(): Boolean` | `vendApprove` | Approve the pending VEND REQUEST (false if none pending) |
| `MdbLib.setCancelMode(CancelResponse)` | `setCancelMode:sessionCancel` / `setCancelMode:vendDenied` | Set ONCE: the standing response for cancels + the VMC's own VEND CANCEL. Persisted. |
| `MdbLib.cancelVend(): Boolean` | `cancelVend` | The simple cancel — sends the standing response set above |
| `MdbLib.cancelVend(CancelResponse): Boolean` | `cancelVend:sessionCancel` / `cancelVend:vendDenied` | One-time override without touching the standing mode |
| `MdbLib.setAutoSession(Boolean)` / `isAutoSession` | `setSessionMode:auto` / `setSessionMode:manual` | true = sessions begin by themselves, false = manual |
| `MdbLib.setMdbLevel(1..3)` | `setMdbLevel:1\|2\|3` | MDB feature level (handshake + payloads) |
| `MdbLib.setMqttLogging(Boolean)` / `isMqttLoggingEnabled` | `setMqttLogging:on\|off` | Mute/unmute the MDB log stream over MQTT — local logListener and the control plane (VMC_STATUS/SETTINGS_JSON/CONFIG_JSON/commands) keep working while muted |
| `MdbLib.setPollVisibility(Boolean)` | `setPollVisibility:on\|off` | Log-debug: show idle POLL/ACK |
| `MdbLib.setUnhandledVisibility(Boolean)` | `setUnhandledVisibility:on\|off` | Log-debug: show commands addressed to us we could not answer |
| `MdbLib.setPeripheralVisibility(Boolean)` | `setPeripheralVisibility:on\|off` | Log-debug: show bus traffic addressed to OTHER peripherals (coin changer, bill validator). Separate from unhandled, so "cashless + unhandled only" is possible. The dashboard also has a client-side "Cashless only" filter that works with any device build. |
| `MdbLib.vendListener / logListener / statusListener` | — | Typed vend events / log mirror / VMC status mirror (statusListener fires instantly on every state change + 3 s heartbeat) |
| `MdbLib.currentState: String` / `isSessionActive: Boolean` | — | Read the MDB state on demand: INACTIVE_STATE, DISABLED_STATE, ENABLED_STATE, VEND_STATE |
| `MdbLib.priceToAmount(raw)` / `priceToMinorUnits(raw)` | — | Standalone price converters using the live READER_CONFIG_DATA scale/decimals |

### Configuring the hex payloads from Android code

The same edits the dashboard's Config panel makes are available as functions. Byte length is
locked per payload (only values change) — EXCEPT the two Begin Session payloads, whose length
is freely editable (1–35 bytes; some feature-level-2 machines only accept the short
Level-1-style 3-byte form, so store exactly the bytes your machine wants). Changes persist
and are used on the very next send, no restart; an ack + fresh `CONFIG_JSON:` snapshot are
published automatically so any watching dashboard stays in sync.

```kotlin
MdbLib.configNames()                                  // all editable names
MdbLib.getConfigHex(MdbLib.ConfigName.SESSION_BEGIN)  // -> "03 FF FF"
MdbLib.setConfigHex(MdbLib.ConfigName.SESSION_BEGIN_L2, "03 FF FF")  // null = ok, else error text
MdbLib.resetConfig(MdbLib.ConfigName.SESSION_BEGIN)   // back to library default
MdbLib.configSnapshotJson()                           // everything, as JSON
```

| `MdbLib.ConfigName.…` | Bytes | What it is |
|---|---|---|
| `READER_CONFIG_DATA` | 8 | SETUP response: level, currency, scale, decimals, timeout, options (level byte overwritten at runtime) |
| `READER_CONFIG_INFO` | 30 | Peripheral ID (Level 2): manufacturer 3 + serial 12 + model 12 + sw version 2 |
| `READER_CONFIG_INFO_L3` | 34 | Peripheral ID (Level 3): same + 4 optional-feature-bits bytes — bit 5 of the LAST byte = Always Idle |
| `SESSION_BEGIN` | 1–35 (editable) | Begin Session (Level 1), default `03 FF FF` |
| `SESSION_BEGIN_L2` | 1–35 (editable) | Begin Session (Level 2/3), default 10 bytes — set `03 FF FF` for machines that want the short form |
| `REVALUE_LIMIT` | 3 | Revalue Limit Amount: code + limit hi/lo — sent as-is on REVALUE LIMIT REQUEST (15 01) |
| `REVALUE_DENIED` | 1 | Reply to a REVALUE REQUEST (15 00) — default `0E`; this device never credits funds onto media |
| `VEND_APPROVED` | 3 | code + price hi/lo (price overwritten at runtime) |
| `JUST_RESET` / `CAN` / `VEND_DENIED` / `END_SESSION` / `SESSION_CANCEL` | 1 | single response codes |

### Configs over MQTT (all inside the library)

Everything about response payloads — parsing, validation, persistence, live hot-reload,
acks — is `MdbConfigStore`'s job. Over MQTT, send JSON on the commands topic:

```json
{ "setConfig": { "SESSION_BEGIN": "03 FF FF", "READER_CONFIG_DATA": "01 02 19 78 01 02 E8 0B" } }
{ "resetConfig": ["SESSION_BEGIN"] }
{ "getConfig": true }
```

Per-name validation (unknown name / bad hex / wrong length rejected individually), per-name
ack lines, and a full `CONFIG_JSON:` snapshot come back automatically. The legacy text form
(`setConfig:NAME:hex`, `resetConfig:NAME`, `getConfig`) still works, so the existing
`log-viewer.html` dashboard needs no changes. Locally: `MdbConfigStore.applyJson(json)`,
`.get(name)`, `.set(name, hex)`, `.snapshotJson()`.

Special byte worth knowing: **Always Idle** (Level 3) is bit 5 of the LAST byte (Z34) of
`READER_CONFIG_INFO_L3` — set that byte to `20` to enable. There is deliberately no separate
flag; the engine reads the declared wire bytes.

## Wire protocol (device <-> dashboard)

- Topics: `<prefix>/<deviceId>/liveLog` (out) and `<prefix>/<deviceId>/commands` (in).
- Tagged messages out: `RABBAH_LOG:{…}` (compact log items), `CODEBOOK_JSON:{…}` (reply to
  `getCodebook`), `VMC_STATUS:{...}` (3 s heartbeat + instant on state change),
  `SETTINGS_JSON:{...}`, `CONFIG_JSON:{...}`, `PONG`; anything untagged is a plain log line.
- Queue: bounded (default 1000), drop-oldest on overflow (`MqttLib.droppedMessages` counts).
- The stack runs on the Rabbah mosquitto (mqtt://mosquitto:1883) with username/password auth; the old public HiveMQ default is gone. The app reads broker credentials from local.properties via BuildConfig.
