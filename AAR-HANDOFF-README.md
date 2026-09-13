# AAR update — mqtt-lib 2.5.1 + hardware-lib 7.22.0

## What to do (3 steps, no code changes)

1. Replace BOTH AARs in your app's `libs/`:
   - `mqtt-lib-2.5.1.aar` (replaces 2.2.0)
   - `hardware-lib-7.22.0.aar` (replace whatever version you bundle now)

   ```gradle
   implementation files('libs/mqtt-lib-2.5.1.aar')
   implementation files('libs/hardware-lib-7.22.0.aar')
   implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
   ```

2. Add these to `proguard-rules.pro` — REQUIRED for minified (release/uat) builds.
   mqtt-lib finds hardware-lib via reflection, so without them R8 deletes hardware-lib
   from the APK and the dashboard reports
   `attachHardware FAILED: hardware-lib absent ... (bundled: absent)` — seen live on D-0416:

   ```proguard
   -keep class com.rabbah.mdb.** { *; }
   -keep class com.rabbah.mqtt.** { *; }
   ```

3. Build and deploy. That's it — **do NOT write any wiring code.**
   Verify the APK BEFORE deploying: Android Studio > Build > Analyze APK > search
   `com.rabbah.mdb` — HardwareLib must be present in the dex.

## Why no code is needed

mqtt-lib 2.3.0+ auto-attaches hardware-lib on the first successful broker
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
| `version` | `[remote] mqtt-lib 2.5.1, hardware-lib 7.22.0` |
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
