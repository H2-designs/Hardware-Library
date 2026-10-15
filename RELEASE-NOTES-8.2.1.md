# Release notes - hardware-lib 8.2.1 + mqtt-lib 2.7.1

Release: https://github.com/H2-designs/Hardware-Library/releases/tag/v8.2.1
Date: 15 October 2026. Replaces v8.2.0 (8 October). Cumulative against the fleet's hardware-lib 8.0.0 / mqtt-lib 2.6.0.

## TL;DR for the Android app

- Swap both AARs in `libs/` and rebuild. **No code change is required.** Everything since 8.0.0 is additive;
  an app built on 8.0.0 / 2.6.0 compiles and behaves the same.
- 8.2.1 fixes four field cases **inside the library**: duplicated log items on the backend, the health check that
  waited forever for ENABLED_STATE under direct vend, SESSION COMPLETE left UNHANDLED after a reader restart, and
  READER ENABLE not answered in INACTIVE with direct vend on. The app keeps its state listener exactly as it is.
- One thing to check in the app, not to add: register the hardware listeners **once** (Application or a singleton)
  and do not keep a custom MQTT bridge next to `HardwareLib.attachRabbahMqtt()`. The library now ignores a repeat
  registration of the same instance, but a second bridge object is still a second publisher.
- Optional code, only if you want the new features: RS232 vend events through the existing VendListener, and a
  ready-feedback gate on more than one digital input. Steps are in `AAR-HANDOFF-README.md`.

## Files

| file | version |
|---|---|
| `libs/hardware-lib-8.2.1.aar` | 8.2.1 (fleet has 8.0.0) |
| `libs/mqtt-lib-2.7.1.aar` | 2.7.1 (fleet has 2.6.0) |
| `libs/CM30-HardwareLibrary-1.0.9.aar` | unchanged |
| `AAR-Update-latest.zip` | the three AARs + AAR-HANDOFF-README.md + API-REFERENCE.md + PULSE-README.md |
| `MDB-Slave-2-v2.17.0-build104-debug.apk` | demo/test app on the new libraries |
| `Hardware-Dashboard-win32-x64-v8.2.1.zip` | Windows dashboard (Force End toggle, link-health badge) |

```gradle
implementation files('libs/mqtt-lib-2.7.1.aar')
implementation files('libs/hardware-lib-8.2.1.aar')
implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
```

## New in 8.2.1 / mqtt-lib 2.7.1 (15 October)

### Every exchange reaches the backend exactly once (field case D-0961)

The backend showed VEND APPROVED four times within 20 ms and most other exchanges twice. Two causes, both in the
library's contract with the app: listener lists accepted the same instance again on every Activity recreation, and
the sample MQTT bridge (copied into the fleet app) published next to `attachRabbahMqtt`, so one exchange had several
publishers.

- `addStateListener` / `addStatusListener` / `addLogListener` / `addExchangeListener` / `addControlListener` and
  `MqttLib.addCommandListener` ignore a repeat registration of the same instance (return `false`).
- `HardwareLib.attachRabbahMqtt()` is the complete bridge: it publishes the coded MDB exchange items itself and keeps
  the plain exchange text local. `MdbMqttBridge` in `samples/` is now a two-line wrapper around it.
- mqtt-lib 2.7.1: `RabbahLog.log` drops an item identical to the previous one (same code, session and params) that
  arrives within 30 ms and counts it in `RabbahLog.dedupedItems`. This is a safety net for in-process fan-out only;
  two identical bus exchanges 50 ms apart are real traffic and are both kept.

### Health check that can never get stuck (no app change needed)

Field case: with direct vend turned on remotely the app's health check waited for ENABLED_STATE, missed the single
announcement and stayed on the health-check screen forever.

- **The reported state is held.** Any `stateListener` / `addStateListener` / `statusListener` registered at any time
  receives the current state immediately, in every state, with direct vend on or off.
- **Re-announced on every real bus transition.** With direct vend ON the listener fires ENABLED_STATE again on each
  INACTIVE -> DISABLED -> ENABLED step, so the app can simply re-apply it.
- **5-second heartbeat under direct vend.** While direct vend is ON and the bus is still INACTIVE or DISABLED,
  ENABLED_STATE is re-sent to the state listeners every 5 s until the bus is really ENABLED / VEND or direct vend
  goes off. Local listeners only; `VMC_STATUS` over MQTT stays event-driven.
- `HardwareLib.currentState` returns the same reported state; the real bus state is the new `HardwareLib.busState`
  and `VMC_STATUS.busState`.
- Control listeners (dashboard, React Native bridge) get `VMC_STATUS` and `SETTINGS_JSON` on registration.

### Session commands answered in every state

Field case: after a reader restart the machine kept sending SESSION COMPLETE (13 04) and the reader logged it
UNHANDLED forever, because the reader was no longer in VEND_STATE.

- VEND CANCEL / VEND SUCCESS / VEND FAILURE / SESSION COMPLETE (13 01..04) are ACKed in every state. Outside
  VEND_STATE nothing else happens, except that a stray SESSION COMPLETE arms END SESSION for the next POLL so the
  machine can close its side. No VendListener callback, state unchanged.
- RESET wipes every per-session flag (session begin / end / cancel pending, approve pending, request received,
  cooldown), so nothing from the previous session survives a machine restart.

### READER ENABLE in INACTIVE with direct vend on

With direct vend ON the reader answers READER ENABLE (14 01) with ACK and READER CANCEL (14 02) with CAN while still
INACTIVE, without changing state. With direct vend OFF the INACTIVE state stays spec-strict as before.

### Docs

- `AAR-HANDOFF-README.md`: per-state answer table, "Register listeners ONCE", "Health check that can never get stuck".
- `API-REFERENCE.md` (new): every public function of HardwareLib, Rs232Lib and PulseLib plus the remote command
  cheat sheet.
- `PULSE-README.md` (new) and `samples/PulsePaymentSample.kt`: the pulse integration guide and a reference sample.

## Since 8.0.0 - hardware-lib 8.2.0 (8 October) - force session end after vend

Field case: a machine keeps the session open after VEND APPROVED / VEND SUCCESS and never sends SESSION COMPLETE.

Persisted setting **force session end**, default OFF. When ON, as soon as **VEND SUCCESS** is ACKed the reader arms
SESSION CANCEL REQUEST (04) for the next POLL; the machine answers SESSION COMPLETE and the session closes with END
SESSION as usual. A failed vend keeps the spec flow. The VendListener callbacks are unchanged.

- Dashboard: **Force End** toggle next to Direct Vend. Remote: `setForceSessionEnd:on|off`.
- Kotlin: `HardwareLib.setForceSessionEnd(Boolean)` / `HardwareLib.isForceSessionEnd`. SETTINGS_JSON: `forceSessionEndAfterVend`.
- Also: when END SESSION goes out every per-session flag is cleared.

## Since 8.0.0 - hardware-lib 8.1.0 (7 October)

**RS232: rules can fire the VendListener.** A rule may carry `"event"`: `vendRequest`, `vendSuccess`, `vendFailure`
or `vendCancel`. On match the same three callbacks the MDB engine uses fire - `onVendRequest(amount, minorUnits, -1)`
with the price the rule extracted, then exactly one `onVendSuccess` or `onVendFailure` (reason FAILED for
vendFailure, CANCELLED_BY_VMC for vendCancel). Rules without `event` behave exactly as before.

**Pulse: ready feedback on several inputs.** `PulseLib.setReadyFeedbackChannels(mapOf(0 to 1, 2 to 0))`, or remote
`setReadyFeedback:0=1,2=0`: every listed input must show its ready value before a pulse train goes out.

**MDB: direct vend reports ENABLED_STATE.** With `setDirectVend(true)` the state listener and `VMC_STATUS.state` say
`ENABLED_STATE` while the bus is INACTIVE or DISABLED; the real state is in `VMC_STATUS.busState`.

## Since 2.6.0 - mqtt-lib 2.7.0 (7 October)

Field case D-0130: the status topic flipped online/offline every 3 seconds - two live sessions sharing one client
id kicking each other.

- **Stable client id per process** (`<deviceId>-<random>`, reused on every reconnect). A `clientId` the app passes
  in `MqttConfig` is used exactly as given - never share one id between two live clients.
- **Graceful stop sends DISCONNECT** after the retained `offline`.
- **Reconnect backoff with jitter**: 3, 6, 12, 24, 48, 60 s; back to 3 s after a session lasts 30 s.
- **Connection counters** since app start: `[mqtt] reconnected ...` + `MQTT_STATS:{...}` on every connect, a WARNING
  after three short sessions, command `mqttStats`, `version` prints the client id and the counters, dashboard link badge.

## Verify after deploy (dashboard passthrough)

| send | expect |
|---|---|
| `version` | `[remote] mqtt-lib 2.7.1, hardware-lib 8.2.1 - client id D-xxxx-..., sessions=1 losses=0 failed attempts=0` |
| `getSettings` | `SETTINGS_JSON` containing `forceSessionEndAfterVend` and `readyFeedbackChannels` |
| `setDirectVend:on` then `status` | `VMC_STATUS` with `"state":"ENABLED_STATE"` and the real `busState` |
| `mqttStats` | `MQTT_STATS:{...}` and the link badge turns green |
| backend logs after one sale | each exchange once; VEND APPROVED once |

If `version` still reports 8.2.0 / 8.1.0 / 8.0.0 or 2.7.0 / 2.6.0, an old AAR is still in `libs/`.

## Known limits

- Not yet run on a real CM30: compiled, API-checked (javap) and dex-checked. First field checks: D-0961 for the
  duplicates, the direct-vend health check, a reader restart mid-session.
- The dashboard's Ready FB control is still single-channel; use `setReadyFeedback:0=1,2=0` on the passthrough bar.
- Force End acts on VEND SUCCESS only. A machine that sends neither VEND SUCCESS nor VEND FAILURE after approval
  needs a different fix (a timeout) - send a log of one sale if you see that.
- RS232 has no approve/deny command; the app answers the machine with bytes as before.
