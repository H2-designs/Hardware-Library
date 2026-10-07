# AAR update — mqtt-lib 2.7.0 + hardware-lib 8.1.0

## What to do (2 steps, no code changes)

1. Replace BOTH AARs in your app's `libs/`:
   - `mqtt-lib-2.7.0.aar` (replaces 2.6.0)
   - `hardware-lib-8.1.0.aar` (replace whatever version you bundle now)

   ```gradle
   implementation files('libs/mqtt-lib-2.7.0.aar')
   implementation files('libs/hardware-lib-8.1.0.aar')
   implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
   ```

2. Build and deploy. That's it — **do NOT write any wiring code, do NOT edit proguard.**
   These AARs (8.1.0 / 2.7.0) carry their R8 keep rules INSIDE (consumerProguardFiles),
   so minified builds can no longer strip them.
   Verify the APK BEFORE deploying: Android Studio > Build > Analyze APK > search
   `com.rabbah.mdb` — HardwareLib must be present in the dex.

> Replace BOTH files every time. A build that swaps one AAR and keeps the other old one shows
> "hardware-lib absent" on the device (R8 renames the unprotected old file).

## What changed in this library - hardware-lib 8.1.0 + mqtt-lib 2.7.0 (vs the fleet's 8.0.0 / 2.6.0)

Both additive: no breaking change, an app built on 8.0.0 / 2.6.0 compiles and behaves the same. The next
section lists the code the Android app may add to USE the new parts.

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
  {"name":"PRODUCTION_OK",  "rx":"A0 03 00 07 53 55 43 43 45 53 53 E7","tx":"","event":"vendSuccess"},
  {"name":"PRODUCTION_FAIL","rx":"A0 03 00 06 46 41 49 4C 45 44 A6","tx":"","event":"vendFailure"},
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

Demo/test APK: **MDB-Slave-2 v2.15.0 build 102** bundles hardware-lib 8.1.0 + mqtt-lib 2.7.0.

What the library cannot fix: two physical units provisioned with the same device code, or a second process
on the unit that connects with a fixed client id. The WARNING line above is how you spot that from the dashboard.

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
  {"name":"PRODUCTION_OK",  "rx":"A0 03 00 07 53 55 43 43 45 53 53 E7","tx":"","event":"vendSuccess"},
  {"name":"PRODUCTION_FAIL","rx":"A0 03 00 06 46 41 49 4C 45 44 A6","tx":"","event":"vendFailure"},
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

## How we verify after deploy (from the dashboard)

Send these on the passthrough bar (or press the toolbar buttons):

| Send | Expect |
|---|---|
| `version` | `[remote] mqtt-lib 2.7.0, hardware-lib 8.1.0 - client id D-0130-3f2a, sessions=1 losses=0 failed attempts=0` |
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
| `onVendFailure()` | EVERY other end of a vend, exactly once: machine cancel (13 01 / 14 02), dispense failure (13 03), session ended with the vend still open (no cancel/failure at all), your own cancelVend(), bus RESET / stop() |

Guarantee: every VEND REQUEST ends in exactly one of onVendSuccess or onVendFailure, never both, never
neither. Reset the payment UI, dismiss the gateway popup and void the hold in `onVendFailure`; refund
there too if you had already called `approveVend()`. When the app needs to know WHICH case it was,
read `HardwareLib.lastVendFailureReason` (CANCELLED_BY_VMC / CANCELLED_BY_APP / FAILED /
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
