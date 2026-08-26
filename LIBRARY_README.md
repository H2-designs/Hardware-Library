# mdb-lib + mqtt-lib — integration guide

Two Android libraries extracted from the proven MDB Slave app:

| Artifact | What it is |
|---|---|
| `mqtt-lib-1.1.0.aar` | MQTT 3.1.1 transport: one bounded outbound **queue** + single publisher thread, command listener chain, auto-reconnect. No MDB knowledge. |
| `mdb-lib-6.4.1.aar` | The full MDB Cashless Device #1 slave (levels 1/2/3, config store, settings) for real CM30 hardware. |

## Gradle setup

Preferred: consume the modules directly (`implementation project(':mdb-lib')`,
`project(':mqtt-lib')`) — see the demo `app/`.

If consuming raw AARs instead: add `mqtt-lib-1.1.0.aar`, `mdb-lib-6.4.1.aar`, **and**
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
MqttLib.enqueue("[app] payment gateway responded in 420ms")
```

### Handling your own remote commands

```kotlin
MqttLib.addCommandListener { cmd ->
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

Rules: never block inside a callback (it stalls the bus loop and the VMC will RESET us);
exceptions you throw are caught and logged, never fatal. The price comes pre-scaled in two
forms: `minorUnits: Int` (exact integer halalas/cents — use for the gateway and all money math)
and `amount: Double` (decimal, for display — floating point, so format with `%.2f` and never
accumulate totals with it). `itemNumber` stays the raw 16-bit item code; all are `-1`/`-1.0` if
the VMC omitted those bytes.

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
| `MdbLib.setMdbLevel(1..3)` | `setMdbLevel:1|2|3` | MDB feature level (handshake + payloads) |
| `MdbLib.setMqttLogging(Boolean)` / `isMqttLoggingEnabled` | `setMqttLogging:on|off` | Mute/unmute the MDB log stream over MQTT — local logListener and the control plane (VMC_STATUS/SETTINGS_JSON/CONFIG_JSON/commands) keep working while muted |
| `MdbLib.setPollVisibility(Boolean)` | `setPollVisibility:on|off` | Log-debug: show idle POLL/ACK |
| `MdbLib.setUnhandledVisibility(Boolean)` | `setUnhandledVisibility:on|off` | Log-debug: show unrecognized commands |
| `MdbLib.vendListener / logListener / statusListener` | — | Typed vend events / log mirror / VMC status mirror (statusListener fires instantly on every state change + 3 s heartbeat) |
| `MdbLib.currentState: String` / `isSessionActive: Boolean` | — | Read the MDB state on demand: INACTIVE_STATE, DISABLED_STATE, ENABLED_STATE, VEND_STATE |

### Configuring the hex payloads from Android code

The same edits the dashboard's Config panel makes are available as functions. Byte length is
locked per payload (only values change); changes persist and are used on the very next send,
no restart; an ack + fresh `CONFIG_JSON:` snapshot are published automatically so any watching
dashboard stays in sync.

```kotlin
MdbLib.configNames()                                  // all editable names
MdbLib.getConfigHex(MdbLib.ConfigName.SESSION_BEGIN)  // -> "03 FF FF"
MdbLib.setConfigHex(MdbLib.ConfigName.SESSION_BEGIN, "03 07 D0")  // null = ok, else error text
MdbLib.resetConfig(MdbLib.ConfigName.SESSION_BEGIN)   // back to library default
MdbLib.configSnapshotJson()                           // everything, as JSON
```

| `MdbLib.ConfigName.…` | Bytes | What it is |
|---|---|---|
| `READER_CONFIG_DATA` | 8 | SETUP response: level, currency, scale, decimals, timeout, options (level byte overwritten at runtime) |
| `READER_CONFIG_INFO` | 30 | Peripheral ID (Level 2): manufacturer 3 + serial 12 + model 12 + sw version 2 |
| `READER_CONFIG_INFO_L3` | 34 | Peripheral ID (Level 3): same + 4 optional-feature-bits bytes — bit 5 of the LAST byte = Always Idle |
| `SESSION_BEGIN` | 3 | Begin Session (Level 1): code + funds hi/lo |
| `SESSION_BEGIN_L2` | 10 | Begin Session (Level 2/3): + payment media ID ×4, payment type, payment data ×2 |
| `REVALUE_LIMIT` | 3 | Revalue Limit Amount: code + limit hi/lo |
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
- Tagged messages out: `VMC_STATUS:{...}` (3 s heartbeat), `SETTINGS_JSON:{...}`,
  `CONFIG_JSON:{...}`, `PONG`; everything else is a plain log line.
- Queue: bounded (default 1000), drop-oldest on overflow (`MqttLib.droppedMessages` counts).
- Public broker = not private. Move to a private broker before carrying anything sensitive.
