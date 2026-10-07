# Release notes - hardware-lib 8.1.0 + mqtt-lib 2.7.0

Release: https://github.com/H2-designs/Hardware-Library/releases/tag/v8.1.0
Date: 7 October 2026. Replaces the fleet's hardware-lib 8.0.0 / mqtt-lib 2.6.0.

## TL;DR for the Android app

- Swap both AARs in `libs/` and rebuild. **No code change is required.** Both libraries are additive; an
  app built on 8.0.0 / 2.6.0 compiles and behaves the same.
- Optional code, only if you want the new features: RS232 vend events through the existing VendListener,
  and a ready-feedback gate on more than one digital input. Steps are in `AAR-HANDOFF-README.md`,
  section "Android: what changes from 8.0.0 to 8.1.0 / 2.7.0".
- One behaviour change to know: with direct vend ON the state listener now reports `ENABLED_STATE` even
  while the bus is still INACTIVE/DISABLED, so the health-check screen passes on machines that never send
  READER ENABLE.

## Files

| file | version |
|---|---|
| `libs/hardware-lib-8.1.0.aar` | 8.1.0 (was 8.0.0) |
| `libs/mqtt-lib-2.7.0.aar` | 2.7.0 (was 2.6.0) |
| `libs/CM30-HardwareLibrary-1.0.9.aar` | unchanged |
| `AAR-Update-latest.zip` | the three AARs + the handoff README |
| `MDB-Slave-2-v2.15.0-build102-debug.apk` | demo/test app on the new libraries |
| `Hardware-Dashboard-win32-x64-v8.1.0.zip` | Windows dashboard, now with a link-health badge |

```gradle
implementation files('libs/mqtt-lib-2.7.0.aar')
implementation files('libs/hardware-lib-8.1.0.aar')
implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
```

## hardware-lib 8.1.0

**RS232: rules can fire the VendListener.** A rule may carry `"event"`: `vendRequest`, `vendSuccess`,
`vendFailure` or `vendCancel`. On match the same three callbacks the MDB engine uses fire -
`onVendRequest(amount, minorUnits, -1)` with the price the rule extracted, then exactly one
`onVendSuccess` or `onVendFailure` (reason FAILED for vendFailure, CANCELLED_BY_VMC for vendCancel).
PRODUCTION FAIL after a paid sale now reaches the app as `onVendFailure` instead of a log line. Rules
without `event` behave exactly as before. The app still answers the machine with `Rs232Lib.sendHex` /
`sendXorFrame`.

**Pulse: ready feedback on several inputs.** `PulseLib.setReadyFeedbackChannels(mapOf(0 to 1, 2 to 0))`,
or remote `setReadyFeedback:0=1,2=0`: every listed input must show its ready value before a pulse train goes
out. The old single-channel `setReadyFeedback(value, channel)` / `setReadyFeedback:yes,value,channel` still
work. `getSettings` adds `readyFeedbackChannels`.

**MDB: direct vend reports ENABLED_STATE.** With `setDirectVend(true)` the state listener and
`VMC_STATUS.state` say `ENABLED_STATE` while the bus is INACTIVE or DISABLED; the real state is in
`VMC_STATUS.busState`. Fires immediately when direct vend is switched on, returns to the real state when off.

Everything else - the MDB engine, the three-callback VendListener, every remote command - is unchanged.

## mqtt-lib 2.7.0

Field case D-0130: the status topic flipped online/offline every 3 seconds. That pattern (online 3.1 s,
offline 60 ms) is two live sessions sharing one client id and kicking each other, not a network fault.

- **Stable client id per process.** The id is now `<deviceId>-<random>` and reused on every reconnect. Before,
  each reconnect took a new id, so after a drop the broker kept the old half-open session alive for up to 45 s
  with its Will armed, and that late Will wrote a retained `offline` over the new session's `online`. If the app
  passes its own `clientId` in `MqttConfig`, it is used exactly as given - never share one id between two live
  clients.
- **Graceful stop sends DISCONNECT** after the retained `offline`, so the broker does not fire the Will on top of it.
- **Reconnect backoff with jitter**: 3, 6, 12, 24, 48, 60 s instead of a flat 3 s; back to 3 s after a session
  lasts 30 s.
- **Connection counters** since app start: sessions established, connection losses, failed connect attempts,
  short sessions in a row, last loss reason. Every reconnect logs one line
  (`[mqtt] reconnected as D-0130-3f2a - session #7, losses=6, failed attempts=0, ...`) plus `MQTT_STATS:{...}`.
  Three short sessions in a row log a WARNING naming the client id (session takeover). New command `mqttStats`;
  `version` now also prints the client id and the counters. The dashboard shows them in a link badge.

No code change for mqtt-lib.

## Verify after deploy (dashboard passthrough)

| send | expect |
|---|---|
| `version` | `[remote] mqtt-lib 2.7.0, hardware-lib 8.1.0 - client id D-xxxx-..., sessions=1 losses=0 failed attempts=0` |
| `getSettings` | `SETTINGS_JSON` containing `readyFeedbackChannels` |
| `mqttStats` | `MQTT_STATS:{...}` and the link badge turns green |
| `open` | `VMC_STATUS` + MDB logs |

If `version` still reports 8.0.0 or 2.6.0, an old AAR is still in `libs/`.

## Known limits

- Not yet run on a real CM30: compiled, API-checked (javap) and dex-checked. D-0130 is the first field check.
- The dashboard's Ready FB control is still single-channel; use `setReadyFeedback:0=1,2=0` on the passthrough bar
  for multi-input.
- RS232 has no approve/deny command; the app answers the machine with bytes as before.
