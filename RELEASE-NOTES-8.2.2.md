# Release notes - hardware-lib 8.2.2 + mqtt-lib 2.7.1

Release: https://github.com/H2-designs/Hardware-Library/releases/tag/v8.2.2 (company copy: https://github.com/RabbahSystems/hardware-library/releases/tag/v8.2.2)
Date: 22 October 2026. Replaces v8.2.1 (15 October). Cumulative against the fleet's hardware-lib 8.0.0 / mqtt-lib 2.6.0.

## TL;DR for the Android app

- Swap `hardware-lib-8.2.2.aar` (mqtt-lib stays 2.7.1) and rebuild. No API change.
- **One behaviour change you must know:** your own `cancelVend()` no longer comes back as `onVendFailure`. Delete any
  branch that handled CANCELLED_BY_APP; handle the decline where you call `cancelVend()`.
- **One thing to check in your handler:** reverse the charge on FAILED, SESSION_ENDED and RESET when you had approved,
  not only on FAILED. `VENDLISTENER-README.md` has the complete handler; `SESSION-ENDED-README.md` explains why.
- New: `vendStats` counters (dashboard **Vend** button), including how many times a listener callback got stuck.
- The MQTT log stream is OFF at every app start (D-0554 flood of `device.log.unknown_source`); the dashboard Logs toggle
  is per-run now. Send `setMqttLogging:off` once to devices still on the old library.
- RS232 Loyalsuns protocol v2: PRODUCTION_OK / PRODUCTION_FAIL rules now ACK the making result. Rule table only.

## Files

| file | version |
|---|---|
| `libs/hardware-lib-8.2.2.aar` | 8.2.2 (fleet has 8.0.0) |
| `libs/mqtt-lib-2.7.1.aar` | 2.7.1, unchanged since v8.2.1 (fleet has 2.6.0) |
| `libs/CM30-HardwareLibrary-1.0.9.aar` | unchanged |
| `AAR-Update-latest.zip` | the three AARs + AAR-HANDOFF-README, IMPLEMENTATION-README, VENDLISTENER-README, SESSION-ENDED-README, DUPLICATE-LOGS-README, API-REFERENCE, PULSE-README |
| `MDB-Slave-2-v2.18.0-build105-debug.apk` | demo/test app on 8.2.2 / 2.7.1 |
| `Hardware-Dashboard-win32-x64-v8.2.2.zip` | Windows dashboard: Vend button for the counters, plus everything from v8.2.1 (device tabs, log recording, History, Export) |

```gradle
implementation files('libs/mqtt-lib-2.7.1.aar')
implementation files('libs/hardware-lib-8.2.2.aar')
implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
```

## New in 8.2.2 (22 October)

### Your own cancelVend() is no longer echoed as onVendFailure

Until 8.2.1 `HardwareLib.cancelVend()` (and the dashboard's `cancelVend`) closed the open vend and fired `onVendFailure`
with reason CANCELLED_BY_APP, so the app heard its own cancel back. Now a cancel the app asked for closes the vend
silently: the deny reply still goes out on the next POLL, `lastVendFailureReason` still records CANCELLED_BY_APP, no
callback. Log: `[mdb] vend closed by cancelVend - no onVendFailure (the app's own decision)`.

Everything the machine does still reaches the listener exactly once: VEND CANCEL / READER CANCEL (CANCELLED_BY_VMC),
VEND FAILURE (FAILED), a session closed with the vend open (SESSION_ENDED), RESET / stop() (RESET).

### The MQTT log stream is OFF at every start (8.2.2)

Field case D-0554: a device left with the dashboard **Logs** toggle on kept publishing every plain report line to
the backend, which files them as `device.log.unknown_source`, thousands per day. Until 8.2.1 the switch was
persisted, so one debugging session stayed on forever. Since 8.2.2 the stream starts OFF at every app start and is
never restored from persistence: the dashboard Logs toggle (`setMqttLogging:on`) turns it on for the current run
only, and the device answers `[mdb] MQTT log publishing enabled (until the next app restart)`. Coded exchange items,
control lines (VMC_STATUS, SETTINGS_JSON, MQTT_STATS, VEND_STATS) and remote commands are never gated by it. The
**HW** toggle (attachHardware) was never persisted; an app restart drops it unless the app attaches itself at boot.
To silence a device on the old library today, send `setMqttLogging:off` once.

### Vend counters - `vendStats`

Since app start, not persisted. Remote `vendStats` (dashboard **Vend** button) answers `VEND_STATS:{...}` and one
readable line: vend requests, successes, failures and failures per reason, app cancels, ignored approves,
`callbackStuck` (a VendListener callback still running after 3 s, with its name and when), callbacks that threw,
events with no listener, whether a listener is registered, whether a vend is open. The watchdog line now reads
`[mdb] WARNING: VendListener.onVendRequest has been running for 3000 ms (stuck #N) ...`. Code:
`HardwareLib.vendStatsJson()`, `vendRequestCount`, `vendSuccessCount`, `vendFailureCount`, `vendFailuresByReason`,
`vendCallbackStuckCount`.

### RS232: Loyalsuns protocol v2 making-result ACK

The reader must answer Making Success / Making Failed with `A1 03 00 02 4F 4B A4`. The PRODUCTION_OK and
PRODUCTION_FAIL rules carry that `tx` in every sample table (guide, README, template, samples). Rule table only, no
library change. Send the table once from the dashboard; it is persisted.

### Documents added

`IMPLEMENTATION-README.md` (the whole app, end to end), `VENDLISTENER-README.md` (the handler in Kotlin, Java and
React Native, the fix for every field mistake, the counters, a bench test through the RS232 path),
`SESSION-ENDED-README.md`, `DUPLICATE-LOGS-README.md`. All in the zip.

## Since 8.0.0 - 8.2.1 / mqtt-lib 2.7.1 (15 October)

- Every exchange reaches the backend exactly once (D-0961): add*Listener ignores a repeat registration of the same
  instance, `attachRabbahMqtt()` is the complete bridge, RabbahLog drops an identical item within 30 ms.
- Health check that can never get stuck: the reported state is held and replayed to any state/status listener on
  registration, re-announced on every real transition, re-sent every 5 s under direct vend while the bus is
  INACTIVE/DISABLED; `currentState` = reported state, `busState` = real.
- SESSION COMPLETE / VEND CANCEL / SUCCESS / FAILURE answered in every state; a stray SESSION COMPLETE gets END SESSION;
  RESET wipes every per-session flag; READER ENABLE / CANCEL answered in INACTIVE with direct vend ON.

## Since 8.0.0 - 8.2.0 and 8.1.0 (October)

- 8.2.0 force session end after vend (`setForceSessionEnd:on|off`, dashboard Force End).
- 8.1.0 RS232 rules carry `"event"` and fire the same VendListener; ready-feedback gate on several inputs
  (`setReadyFeedback:0=1,2=0`); direct vend reports ENABLED_STATE.

## Since 2.6.0 - mqtt-lib 2.7.0 / 2.7.1

Stable client id per process (D-0130 presence flapping), DISCONNECT on stop, reconnect backoff with jitter,
connection counters (`mqttStats`, dashboard link badge), RabbahLog 30 ms dedupe.

## Verify after deploy (dashboard passthrough)

| send | expect |
|---|---|
| `version` | `[remote] mqtt-lib 2.7.1, hardware-lib 8.2.2 - client id D-xxxx-..., sessions=1 ...` |
| `vendStats` | `[vend stats] requests=0 ... STUCK callbacks=0 ... listener registered` |
| restart the app, then `getSettings` | `mqttLogsEnabled: false` whatever it was before |
| `getSettings` | `SETTINGS_JSON` with `forceSessionEndAfterVend`, `directVend`, `readyFeedbackChannels` |
| one sale declined by the app | `[mdb] vend closed by cancelVend - no onVendFailure`, no failure callback in the app |
| one sale the machine cancels | one `onVendFailure`, reason CANCELLED_BY_VMC |
| backend logs after one sale | each exchange once |

## Known limits

- Not yet run on a real CM30. Compiled, API-checked (javap) and dex-checked. First field checks: the no-echo cancel,
  the counters after a day, D-0961 duplicates, the direct-vend health check, a reader restart mid-session.
- The dashboard's Ready FB control is still single-channel; use `setReadyFeedback:0=1,2=0` on the passthrough bar.
- Force End acts on VEND SUCCESS only.
- RS232 has no approve/deny command; the app answers the machine with bytes.
- `simulateExchange` exercises the log pipeline only, not the VendListener; use the RS232 bench test in
  `VENDLISTENER-README.md` section 8 to exercise the handler without a machine.
