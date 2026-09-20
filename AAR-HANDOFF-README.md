# AAR update — mqtt-lib 2.6.0 + hardware-lib 7.23.1

## What to do (2 steps, no code changes)

1. Replace BOTH AARs in your app's `libs/`:
   - `mqtt-lib-2.6.0.aar` (replaces 2.2.0)
   - `hardware-lib-7.23.1.aar` (replace whatever version you bundle now)

   ```gradle
   implementation files('libs/mqtt-lib-2.6.0.aar')
   implementation files('libs/hardware-lib-7.23.1.aar')
   implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
   ```

2. Build and deploy. That's it — **do NOT write any wiring code, do NOT edit proguard.**
   These AARs (7.23.1 / 2.6.0) carry their R8 keep rules INSIDE (consumerProguardFiles),
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
| `version` | `[remote] mqtt-lib 2.6.0, hardware-lib 7.23.1` |
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
