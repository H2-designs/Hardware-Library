# AAR update — mqtt-lib 2.7.0 + hardware-lib 8.1.0

## What to do (2 steps, no code changes)

1. Replace BOTH AARs in your app's `libs/`:
   - `mqtt-lib-2.7.0.aar` (replaces 2.6.0 / 2.2.0)
   - `hardware-lib-8.1.0.aar` (replace whatever version you bundle now)

   ```gradle
   implementation files('libs/mqtt-lib-2.7.0.aar')
   implementation files('libs/hardware-lib-8.1.0.aar')
   implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
   ```

2. Build and deploy. That's it — **do NOT write any wiring code, do NOT edit proguard.**
   These AARs (8.1.0 / 2.7.0) carry their R8 keep rules INSIDE (consumerProguardFiles),
   so minified builds can no longer strip them — the "bundled: absent" failure seen on
   D-0416 is impossible with these versions.
   Verify the APK BEFORE deploying: Android Studio > Build > Analyze APK > search
   `com.rabbah.mdb` — HardwareLib must be present in the dex.

> Build 1.0.235 shipped mqtt-lib 2.5.2 but kept the OLD hardware-lib file — the device
> still said "hardware-lib absent" (R8 renamed the unprotected old AAR). mqtt-lib 2.5.3
> now also keeps `com.rabbah.mdb.**` from its own embedded rules, so even that mistake
> recovers the bridge — but REPLACE BOTH FILES anyway: the old hardware-lib predates the
> vend-cancel callback, RS232 codes, detach, and the log-mute fix.

## Why no code is needed

mqtt-lib 2.3.0+ CAN auto-attach hardware-lib on the first successful broker
connection (`MqttConfig.autoAttachHardware`, default true). That one step wires:

- every hardware-lib log line (MDB exchanges, RS232 events) -> `devices/<id>/logs`
- every remote command (`open`, `close`, `getConfig`, `getRs232Rules`, ...) via
  `devices/<id>/passthrough`

In the current build (1.0.231-uat) hardware-lib was never attached — that's why
the dashboard saw `[remote] unknown command: open/close/getConfig` and zero MDB
logs, while `ping` still answered `PONG` (mqtt-lib answers that itself).

## How we verify after deploy (from the dashboard)

Send these on the passthrough bar (or press the toolbar buttons):

| Send | Expect |
|---|---|
| `version` | `[remote] mqtt-lib 2.6.0, hardware-lib 8.0.0` |
| `help` | the full command list |
| `open` | `VMC_STATUS` + MDB logs start flowing |

If `version` still says "unknown command", the old mqtt-lib AAR is still in the
APK (check for a duplicate/renamed AAR in libs/).

## Log schema note (2.4.0)

MDB log envelopes now carry message codes **110-136** — unified with the command/exchange
codes (the backend's MdbLogSchema enum keyed 110-136 works as-is). RS232 stays 137-143.
Builds on mqtt-lib <= 2.3.0 emitted 0-26 for the same MDB events; `getCodebook` always
returns the codes the running build actually emits.

Already verified end-to-end on a test device against uat-api.rabbah.sa:1883.

## Remote debug controls (2.5.0 / 7.19.0)

The dashboard has toggle switches for both: **HW** (attachHardware / detachHardware - wire or
fully unwire hardware-lib remotely) and **Logs** (setMqttLogging:on|off - stream or mute the
hardware logs; commands and status stay alive while muted). All remote, no builds needed once
these AARs are deployed.

## Defaults changed in 7.23.0 / 2.6.0 - nothing turns on by itself

- `autoAttachHardware` now defaults to **false**: a device boots UNATTACHED. Attach on demand
  with the dashboard HW toggle (`attachHardware`); a restart drops it again.
- `mqttLogsEnabled` now defaults to **false**: no remote log stream until the dashboard Logs
  toggle (`setMqttLogging:on`) turns it on - persisted per device once `HardwareLib.init()`
  has been called.
- Settings commands (`getSettings`, `setMqttLogging`, ...) now work even if the app never calls
  `HardwareLib.init(context)` (previously they threw and showed as "unknown command"); the
  device warns once that such settings are in-memory only. CALL `HardwareLib.init(context)`
  AT APP START in every mode (MDB and RS232) so the switches persist across restarts.

## 7.23.1 - vend decision visibility (field case D-0117, 2026-09-20)

`approveVend()` / `cancelVend()` now report what they did on the log stream:
`[app] approveVend armed - VEND APPROVED goes out on the next POLL` or
`[app] approveVend IGNORED - no VEND REQUEST pending (state=...)`. If your gateway approves but
the machine never gets VEND APPROVED, this line tells you whether the engine ever saw the call.
ALWAYS log the Boolean these functions return. The vend flags are now @Volatile (written from
gateway callback threads, read on the bus thread).

## mqtt-lib 2.7.0 - presence (online/offline) fixes, connection counters, takeover detection (no code change)

Field case D-0130, 2026-10-07: the status topic flipped offline/online every 3 s. Pattern = online for 3.1 s,
offline for 60 ms = two live sessions with the SAME client id kicking each other (MQTT session takeover),
not a network problem. Fixed on our side as far as the library can, and made visible:

**Presence fixes**
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

**Counters you can see in the dashboard** (kept since app start, nothing persisted)

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

Demo/test APK: **MDB-Slave-2 v2.15.0 build 102** bundles hardware-lib 8.1.0 + mqtt-lib 2.7.0 (replaces build 101).

What the library cannot fix: two physical units provisioned with the same device code, or a second process
on the unit that connects with a fixed client id. The WARNING line above is how you spot that from the dashboard.

## 8.1.0 - RS232 rules fire the VendListener; ready-feedback gate over several inputs (additive, no breaking change)

Nothing in the MDB path changed. Two additions, both off unless you use them:

### RS232: a rule can carry an `event`

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

### Pulse: ready feedback on more than one digital input

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

### Direct vend reports ENABLED_STATE on the state listener

Some machines in direct-vend mode never send READER ENABLE, so the bus stays INACTIVE/DISABLED although
vends work. Apps that gate their ready screen on the state listener saying `ENABLED_STATE` waited forever.
With direct vend ON the state listener (and `VMC_STATUS.state`) now report `ENABLED_STATE` whenever the
bus state is INACTIVE or DISABLED; the real bus state travels alongside as `VMC_STATUS.busState` with
`"directVend": true`. The listener fires immediately when `setDirectVend(true)` is called, and goes back to
the real state when it is turned off. VEND_STATE and a real ENABLED_STATE are reported as before.

Not yet run on a real CM30 - compiled and API-checked only. Dashboard Ready FB control is still single-channel.

## 8.0.0 - VendListener is THREE callbacks: onVendRequest / onVendSuccess / onVendFailure (BREAKING)

Field case: some machines never send VEND CANCEL or VEND FAILURE - a customer selects an item, walks
away, and the VMC just ends the session. The app got no cancel/failure and left the payment UI on screen.

The listener is now exactly three functions, and `onVendFailure()` is THE non-success outcome:

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

**Breaking:** `onVendCancelled()`, `onSessionEnded()` and the short-lived 7.29.0 `onVendAborted()` are
REMOVED from `VendListener` - delete those overrides (the compiler will point at them) and move any
UI-reset code into `onVendFailure`. Nothing else in the API changed.

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

The log stream shows `[mdb] vend failed: <reason> - onVendFailure fires` each time. Demo/test APK: build 101.
react-native-mdb: `onVendFailure` now carries `{ reason }`; `onSessionEnded` is no longer emitted.

## 7.28.0 - direct vend: accept VEND REQUEST without the handshake

Some VMCs never run the setup / READER ENABLE / SESSION BEGIN sequence and send `13 00` (VEND REQUEST)
straight away; per spec the engine ignored it outside a session. New persisted setting **direct vend**
(default OFF): when ON, a VEND REQUEST is accepted in INACTIVE, DISABLED and ENABLED state - the engine
ACKs, captures price/item, jumps to the session state, logs
`[mdb] VEND REQUEST accepted directly in <STATE> ...` and fires `onVendRequest`. `approveVend()` /
`cancelVend()` and the rest of the vend flow (VEND SUCCESS/FAILURE, SESSION COMPLETE, END SESSION) work
exactly as usual.

- Remote: `setDirectVend:on|off`. Dashboard: **Direct Vend** toggle next to the cancel-mode selector.
- Kotlin: `HardwareLib.setDirectVend(Boolean)` / `HardwareLib.isDirectVend`. SETTINGS_JSON: `directVend`.
- Leave it OFF on spec-compliant machines: with it ON, a stray VEND REQUEST during setup is treated as a
  real sale request.

Demo/test APK: build 99.

## 7.27.0 - pulse polarity persisted

A successful `PulseLib.initPulse(true|false)` (or remote `initPulse:true|false`) is now remembered
(`pulseMode` = high | low | unset in SETTINGS_JSON). `HardwareLib.init(context)` re-drives the same idle
level at the next app start, so `sendPulse` no longer answers "call initPulse first" after a restart.
A device that was never initialised stays "unset" and still refuses to pulse - nothing is driven that an
operator or the app did not choose once. Dashboard: a "mode: HIGH / LOW / unset" label next to Init High /
Init Low. Pulse test bench: `pulse-sample-v1.5.apk`; demo/test APK build 98.

## 7.26.0 - persisted ready-feedback gate, no more doubled log lines

- **Ready feedback is persisted.** `PulseLib.setReadyFeedback(...)` (Kotlin) and
  `setReadyFeedback:[yes,]value[,channel]` / `setReadyFeedback:off` (remote) now survive restarts
  once `HardwareLib.init(context)` has run. New short form `setReadyFeedback:on` re-arms with the
  last persisted value/channel. Dashboard: **Ready FB** toggle + val/ch fields in the Pulse group.
  SETTINGS_JSON carries `readyFeedbackEnabled`, `readyFeedbackValue`, `readyFeedbackChannel`.
  Last writer wins: if your app calls setReadyFeedback from the backend model at boot, that call
  overwrites what the dashboard set.
- **Every MDB exchange was logged twice** (once directly, once via the ordered delivery path) - the
  direct dispatch is gone. Side effect: with empty-session suppression on (the default) an empty
  BEGIN -> COMPLETE -> END cycle now logs nothing at all, as documented; send
  `setEmptySessionVisibility:on` to see them.
- Pulse test bench `pulse-sample-v1.5.apk` rebuilt on this library (calls HardwareLib.init so the
  gate persists). Demo/test APK is now build 97.

## 7.25.0 - auto session mode no longer deadlocks after a denied vend (field case D-0222, 2026-09-20)

Symptom: in auto session mode, after `VEND REQUEST -> VEND DENIED / SESSION CANCEL REQUEST ->
SESSION COMPLETE -> END SESSION` the log filled with `UNHANDLED rx=14 01 15` forever and the
machine was dead until Close/Open. Manual mode worked.

Cause: auto mode re-armed SESSION BEGIN on the very first POLL after END SESSION. Some VMCs
(Sielaff) send their post-session READER ENABLE (`14 01`) *after* that POLL, so it landed while
the engine was already in the session state, which had no READER handler -> no ACK -> the VMC
retried READER ENABLE forever and never POLLed again.

Fixes (both in the engine, no app code needed):

1. **Auto-begin cooldown.** After END SESSION, auto mode waits N idle POLLs (default 3, ~300-600 ms)
   before arming SESSION BEGIN. A READER ENABLE arriving during the cooldown arms immediately, as
   before. Configurable and persisted: dashboard field **cooldown: [N] polls** next to the session
   mode selector, remote command `setAutoBeginCooldown:0-50`, Kotlin
   `HardwareLib.setAutoBeginCooldown(polls)` / `HardwareLib.autoBeginCooldown`, reported in
   SETTINGS_JSON as `autoBeginCooldownPolls`. `0` restores the old next-POLL behavior.
2. **READER ENABLE / DISABLE / CANCEL are now answered inside a session** (VEND_STATE): ENABLE -> ACK;
   DISABLE -> ACK and the session is closed with END SESSION on the next POLL; CANCEL -> same reply
   as outside a session plus the session is cancelled per the configured cancel mode (and
   `onVendCancelled` fires if a VEND REQUEST was pending).

Test APK for this scenario: `MDB-Slave-2-v2.14.0-build101-debug.apk` (demo app on 8.0.0 / 2.6.0).

## 7.24.0 - blocked VendListener callbacks no longer freeze the pipeline

Vend callbacks now run on their own threads. Previously a blocking `onVendRequest` (waiting for
the gateway result inside the callback) froze every log line, exchange event and later callback -
including `onVendCancelled`, so the app never learned the machine had given up. Now cancel /
success / failure are delivered even while `onVendRequest` is stuck, and a callback running
longer than 3 s produces `[mdb] WARNING: a VendListener callback has been running for 3000 ms`.
Still: RETURN IMMEDIATELY from every callback and do gateway work on your own coroutine.
