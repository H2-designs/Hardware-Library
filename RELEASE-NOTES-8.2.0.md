# Release notes - hardware-lib 8.2.0 + mqtt-lib 2.7.0

Release: https://github.com/H2-designs/Hardware-Library/releases/tag/v8.2.0
Date: 8 October 2026. Replaces v8.1.0 (7 October). Cumulative against the fleet's hardware-lib 8.0.0 / mqtt-lib 2.6.0.

## TL;DR for the Android app

- Swap both AARs in `libs/` and rebuild. **No code change is required.** Everything since 8.0.0 is additive;
  an app built on 8.0.0 / 2.6.0 compiles and behaves the same.
- Optional code, only if you want the new features: RS232 vend events through the existing VendListener, and a
  ready-feedback gate on more than one digital input. Steps are in `AAR-HANDOFF-README.md`, section
  "Android: what changes from 8.0.0".
- Two behaviour switches operators turn on per machine from the dashboard, nothing for the app: **Force End**
  (new in 8.2.0) and **Direct Vend** reporting ENABLED_STATE (8.1.0).

## Files

| file | version |
|---|---|
| `libs/hardware-lib-8.2.0.aar` | 8.2.0 (fleet has 8.0.0) |
| `libs/mqtt-lib-2.7.0.aar` | 2.7.0 (fleet has 2.6.0) |
| `libs/CM30-HardwareLibrary-1.0.9.aar` | unchanged |
| `AAR-Update-latest.zip` | the three AARs + the handoff README |
| `MDB-Slave-2-v2.16.0-build103-debug.apk` | demo/test app on the new libraries |
| `Hardware-Dashboard-win32-x64-v8.2.0.zip` | Windows dashboard with the Force End toggle and the link-health badge |

```gradle
implementation files('libs/mqtt-lib-2.7.0.aar')
implementation files('libs/hardware-lib-8.2.0.aar')
implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
```

## New in 8.2.0 - force session end after vend

Field case: a machine keeps the session open after VEND APPROVED / VEND SUCCESS and never sends SESSION COMPLETE,
so the reader never gets to send END SESSION and the next customer cannot start.

Persisted setting **force session end**, default OFF. When ON, as soon as **VEND SUCCESS** is ACKed the reader arms
SESSION CANCEL REQUEST (04) for the next POLL; the machine answers SESSION COMPLETE and the session closes with END
SESSION as usual. A failed vend keeps the spec flow. Nothing extra is sent if SESSION COMPLETE already arrived. The
VendListener callbacks are unchanged - only the wire-level close is forced.

- Dashboard: **Force End** toggle next to Direct Vend. Remote: `setForceSessionEnd:on|off`.
- Kotlin: `HardwareLib.setForceSessionEnd(Boolean)` / `HardwareLib.isForceSessionEnd`. SETTINGS_JSON: `forceSessionEndAfterVend`.
- Log: `[mdb] force session end: SESSION CANCEL REQUEST goes out on the next POLL (after VEND SUCCESS)`.
- Also: when END SESSION goes out every per-session flag is cleared (a forced cancel still armed, an approve that
  arrived after the machine cancelled, the pending-request flag), so nothing leaks into the next session.

## Since 8.0.0 - hardware-lib 8.1.0 (7 October)

**RS232: rules can fire the VendListener.** A rule may carry `"event"`: `vendRequest`, `vendSuccess`, `vendFailure`
or `vendCancel`. On match the same three callbacks the MDB engine uses fire - `onVendRequest(amount, minorUnits, -1)`
with the price the rule extracted, then exactly one `onVendSuccess` or `onVendFailure` (reason FAILED for
vendFailure, CANCELLED_BY_VMC for vendCancel). PRODUCTION FAIL after a paid sale now reaches the app as
`onVendFailure`. Rules without `event` behave exactly as before. The app still answers the machine with
`Rs232Lib.sendHex` / `sendXorFrame`.

**Pulse: ready feedback on several inputs.** `PulseLib.setReadyFeedbackChannels(mapOf(0 to 1, 2 to 0))`, or remote
`setReadyFeedback:0=1,2=0`: every listed input must show its ready value before a pulse train goes out. The old
single-channel forms still work. `getSettings` adds `readyFeedbackChannels`.

**MDB: direct vend reports ENABLED_STATE.** With `setDirectVend(true)` the state listener and `VMC_STATUS.state` say
`ENABLED_STATE` while the bus is INACTIVE or DISABLED; the real state is in `VMC_STATUS.busState`.

## Since 2.6.0 - mqtt-lib 2.7.0 (7 October)

Field case D-0130: the status topic flipped online/offline every 3 seconds - two live sessions sharing one client
id kicking each other, not a network fault.

- **Stable client id per process** (`<deviceId>-<random>`, reused on every reconnect): a late Will from an old
  half-open session can no longer write a retained `offline` over a fresh `online`. A `clientId` the app passes in
  `MqttConfig` is used exactly as given - never share one id between two live clients.
- **Graceful stop sends DISCONNECT** after the retained `offline`.
- **Reconnect backoff with jitter**: 3, 6, 12, 24, 48, 60 s; back to 3 s after a session lasts 30 s.
- **Connection counters** since app start (sessions, losses, failed retries, short sessions in a row, last loss
  reason): one `[mqtt] reconnected ...` log line per reconnect plus `MQTT_STATS:{...}`; a WARNING after three short
  sessions naming the client id; new command `mqttStats`; `version` prints the client id and the counters; dashboard
  link badge.

No code change for mqtt-lib.

## Verify after deploy (dashboard passthrough)

| send | expect |
|---|---|
| `version` | `[remote] mqtt-lib 2.7.0, hardware-lib 8.2.0 - client id D-xxxx-..., sessions=1 losses=0 failed attempts=0` |
| `getSettings` | `SETTINGS_JSON` containing `forceSessionEndAfterVend` and `readyFeedbackChannels` |
| `mqttStats` | `MQTT_STATS:{...}` and the link badge turns green |
| `open` | `VMC_STATUS` + MDB logs |

If `version` still reports 8.0.0 / 8.1.0 or 2.6.0, an old AAR is still in `libs/`.

## Known limits

- Not yet run on a real CM30: compiled, API-checked (javap) and dex-checked. First field checks: the force-end
  machine, and D-0130 for the presence fix.
- The dashboard's Ready FB control is still single-channel; use `setReadyFeedback:0=1,2=0` on the passthrough bar.
- Force End acts on VEND SUCCESS only. A machine that sends neither VEND SUCCESS nor VEND FAILURE after approval
  needs a different fix (a timeout) - send a log of one sale if you see that.
- RS232 has no approve/deny command; the app answers the machine with bytes as before.
