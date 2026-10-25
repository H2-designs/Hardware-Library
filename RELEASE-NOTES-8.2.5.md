# Release notes - hardware-lib 8.2.5 + mqtt-lib 2.8.0

Release: https://github.com/RabbahSystems/hardware-library/releases/tag/v8.2.5 (and https://github.com/H2-designs/Hardware-Library/releases/tag/v8.2.5)
Date: 25 October 2026. Replaces v8.2.4 (24 October, never cut as a GitHub release). Cumulative against the fleet's
hardware-lib 8.0.0 / mqtt-lib 2.6.0.

## TL;DR for the Android app

- Swap `hardware-lib-8.2.5.aar`; mqtt-lib stays 2.8.0 (copy all three AARs from `AAR-Update-latest.zip`). Rebuild.
- **One handler change to check:** every cancel now arrives as `onVendFailure`, and the reason says who cancelled:
  CANCELLED_BY_VMC (machine), CANCELLED_BY_APP (your own `cancelVend()`, delivered again), **CANCELLED_BY_OPERATOR**
  (new: dashboard Vend Cancel or a remote command). Branch on the reason: CANCELLED_BY_APP needs no gateway action,
  CANCELLED_BY_OPERATOR must void the hold (reverse if you had approved). A Java `switch` without `default` must add
  the new case. Full tables: `CANCEL-FLOW-README.md`.
- Operator commands always answer now: `[remote]` reply lines such as the answer to `help` are no longer muted by the
  MQTT Logs switch.
- Everything from 8.2.3 / 8.2.4 is included: session-cancel retry, skip 00 00 vend, RS232 leading-`*` patterns.

## Files

| file | version |
|---|---|
| `libs/hardware-lib-8.2.5.aar` | 8.2.5 (fleet has 8.0.0) |
| `libs/mqtt-lib-2.8.0.aar` | 2.8.0, unchanged since v8.2.2 (fleet has 2.6.0) |
| `libs/CM30-HardwareLibrary-1.0.9.aar` | unchanged |
| `AAR-Update-latest.zip` | the three AARs + AAR-HANDOFF-README, IMPLEMENTATION-README, VENDLISTENER-README, CANCEL-FLOW-README, SESSION-ENDED-README, DUPLICATE-LOGS-README, API-REFERENCE, PULSE-README |
| `react-native-mdb` 1.3.4 | bundles hardware-lib 8.2.5 + mqtt-lib 2.8.0; the `reason` union gains `'CANCELLED_BY_OPERATOR'` |
| `Hardware-Dashboard-win32-x64-v8.2.4.zip` | Windows dashboard, unchanged since 8.2.4 (Cancel Retry and Skip 00 00 Vend toggles, Vend counters line) |
| `MDB-Slave-2-v2.20.0-build107-debug.apk` | demo/test app on 8.2.5 / 2.8.0 (private release only) |

```gradle
implementation files('libs/mqtt-lib-2.8.0.aar')
implementation files('libs/hardware-lib-8.2.5.aar')
implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
```

## New in 8.2.5 (25 October)

### Every cancel reaches onVendFailure, with a reason that says who cancelled

| who | how | reason |
|---|---|---|
| the machine | VEND CANCEL 13 01, READER CANCEL 14 02, RS232 `event: vendCancel` | CANCELLED_BY_VMC |
| the app | `cancelVend()` / `cancelVend(response)` | CANCELLED_BY_APP |
| an operator | dashboard Vend Cancel, remote `cancelVend[:sessionCancel|:vendDenied]`, remote `setSessionMode` mid-session | CANCELLED_BY_OPERATOR |

The 8.2.2 rule that the app's own cancel was silent is withdrawn: it also hid the dashboard's cancel from the app, so
an operator cancel left the payment screen open and a hold in place. One rule for the three sources is simpler.
The wire replies are unchanged (VEND DENIED or SESSION CANCEL REQUEST per the cancel mode). A cancel while the
session is open but before any VEND REQUEST still fires nothing, because no vend is open.

Handler rule: CANCELLED_BY_APP = you already declined, nothing at the gateway, reset the UI. CANCELLED_BY_OPERATOR =
void the hold, reverse if approved, reset the UI. `vendStats` adds `operatorCancels`; `vendFailuresByReason` now
carries all three cancel reasons. Log lines: `[app] cancelVend armed ...` / `[operator] cancelVend armed ...` followed by
`[mdb] vend failed: CANCELLED_BY_APP|CANCELLED_BY_OPERATOR - onVendFailure fires`.

### `[remote]` replies are never muted

Until 8.2.4 the answers to operator commands went through the same gate as the MDB log stream, so with the Logs
toggle off `help`, `getSettings` acknowledgements and the `vendStats` summary line were executed but never published.
Now any line starting with `[remote]` goes out regardless. Since mqtt-lib 2.8.0 these lines travel on the `ops`
channel, so the backend sees nothing new. If a reply is still missing, the dashboard is older than v8.2.2 and does not
read `ops`.

## Since 8.0.0 - 8.2.4 and 8.2.3 (24 October)

- Skip 00 00 vend (`setSkipZeroVend:on`, default off): a VEND REQUEST priced 00 00 is ACKed and dropped.
- Session-cancel retry (`setSessionCancelRetry:on|off|MS`, default off): an unanswered SESSION CANCEL REQUEST is
  re-sent after 1000 ms, up to 3 times (field case D-1637).
- RS232: an rx pattern may start with `*` to match the end of a frame.

## Since 8.0.0 - 8.2.2 / mqtt-lib 2.8.0 (22 October)

- mqtt-lib 2.8.0: only coded items on the backend's `logs` topic; plain and control lines on `devices/<id>/ops`.
- `vendStats` counters, including stuck VendListener callbacks.
- RS232 Loyalsuns protocol v2: PRODUCTION_OK / PRODUCTION_FAIL rules ACK the making result.

## Since 8.0.0 - 8.2.1, 8.2.0, 8.1.0 (October)

- Every exchange reaches the backend exactly once (D-0961); a health check that cannot get stuck.
- Force session end after vend (`setForceSessionEnd:on|off`).
- RS232 rules fire the same VendListener; multi-input ready gate; direct vend reports ENABLED_STATE.

## Verify after deploy (dashboard passthrough)

| send | expect |
|---|---|
| `version` | `[remote] mqtt-lib 2.8.0, hardware-lib 8.2.5 - client id ...` on the ops channel, even with Logs off |
| `help` | the command list, even with Logs off |
| a sale, then dashboard Vend Cancel | app: one `onVendFailure` with CANCELLED_BY_OPERATOR; log: `[operator] cancelVend armed` then `[mdb] vend failed: CANCELLED_BY_OPERATOR` |
| a sale the app declines | app: one `onVendFailure` with CANCELLED_BY_APP |
| a sale the machine cancels | app: one `onVendFailure` with CANCELLED_BY_VMC |
| `vendStats` | `appCancels=.. operatorCancels=..` and the reasons in `vendFailuresByReason` |

## Known limits

- Not yet run on a real CM30. Compiled and API-checked only.
- Everything listed for 8.2.4 still holds (dashboard Ready FB single-channel, Force End on VEND SUCCESS only, no RS232
  approve/deny command, `simulateExchange` drives the log pipeline only, the retry gives up after 3 re-sends).
