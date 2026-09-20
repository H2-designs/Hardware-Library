# AAR update — mqtt-lib 2.6.0 + hardware-lib 7.25.0

## What to do (2 steps, no code changes)

1. Replace BOTH AARs in your app's `libs/`:
   - `mqtt-lib-2.6.0.aar` (replaces 2.2.0)
   - `hardware-lib-7.25.0.aar` (replace whatever version you bundle now)

   ```gradle
   implementation files('libs/mqtt-lib-2.6.0.aar')
   implementation files('libs/hardware-lib-7.25.0.aar')
   implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
   ```

2. Build and deploy. That's it — **do NOT write any wiring code, do NOT edit proguard.**
   These AARs (7.25.0 / 2.6.0) carry their R8 keep rules INSIDE (consumerProguardFiles),
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
| `version` | `[remote] mqtt-lib 2.6.0, hardware-lib 7.25.0` |
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

Test APK for this scenario: `MDB-Slave-2-v2.13.48-build96-debug.apk` (demo app on 7.25.0 / 2.6.0).

## 7.24.0 - blocked VendListener callbacks no longer freeze the pipeline

Vend callbacks now run on their own threads. Previously a blocking `onVendRequest` (waiting for
the gateway result inside the callback) froze every log line, exchange event and later callback -
including `onVendCancelled`, so the app never learned the machine had given up. Now cancel /
success / failure are delivered even while `onVendRequest` is stuck, and a callback running
longer than 3 s produces `[mdb] WARNING: a VendListener callback has been running for 3000 ms`.
Still: RETURN IMMEDIATELY from every callback and do gateway work on your own coroutine.
