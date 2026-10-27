# Release notes - hardware-lib 8.2.7 + mqtt-lib 2.8.0

Release: https://github.com/RabbahSystems/hardware-library/releases/tag/v8.2.7 (and https://github.com/H2-designs/Hardware-Library/releases/tag/v8.2.7)
Date: 27 October 2026. Replaces v8.2.6 (same day). Cumulative against the fleet's hardware-lib 8.0.0 / mqtt-lib 2.6.0.

## TL;DR for the Android app

- Swap `hardware-lib-8.2.7.aar`; mqtt-lib stays 2.8.0. Rebuild. No API change.
- **Cancel grace, ON by default.** When a vend fails within 200 ms of its VEND REQUEST, `onVendFailure` is delivered
  350 ms later. The request callback had already returned in 8.2.6, but an app that hands the request to its UI thread
  had not drawn the screen yet; the failure cleared nothing, the screen appeared a moment later and stayed. The delay
  gives the UI time to draw before the failure clears it. Operator setting: `setCancelGrace:WINDOW,DELAY`,
  `setCancelGrace:off`.
- Everything from 8.2.6 applies: ordered callbacks on one thread, `onVendFailure(reason)`.

## Files

| file | version |
|---|---|
| `libs/hardware-lib-8.2.7.aar` | 8.2.7 (fleet has 8.0.0) |
| `libs/mqtt-lib-2.8.0.aar` | 2.8.0, unchanged (fleet has 2.6.0) |
| `libs/CM30-HardwareLibrary-1.0.9.aar` | unchanged |
| `AAR-Update-latest.zip` | the three AARs + the eight guides |
| `react-native-mdb` 1.3.6 | bundles hardware-lib 8.2.7, no JS change |
| `Hardware-Dashboard-win32-x64-v8.2.5.zip` | unchanged |
| `MDB-Slave-2-v2.22.0-build109-debug.apk` | demo/test app on 8.2.7 (private release only) |

```gradle
implementation files('libs/mqtt-lib-2.8.0.aar')
implementation files('libs/hardware-lib-8.2.7.aar')
implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
```

## New in 8.2.7 (27 October)

### Cancel grace

Field case, continued: with 8.2.6 the callbacks were ordered, but the stuck screen still appeared. The app's
`onVendRequest` returns at once and posts the screen to the UI thread; the machine's VEND CANCEL arrived 57 ms after
the request, `onVendFailure` ran and reset a screen that was not there yet, then the UI thread drew "tap your card"
and nothing ever cleared it. Ordering between callbacks cannot fix a race with the app's own UI thread; a short delay
can.

Rule: if a vend fails less than **200 ms** after its `onVendRequest` was queued, the `onVendFailure` delivery is held
back **350 ms**. Delivery stays in order: a new VEND REQUEST flushes a held failure first. Failures that arrive later
than the window are delivered at once as before. All reasons are covered (machine cancel, app cancel, operator cancel,
VEND FAILURE, session ended, reset).

- Persisted setting, defaults ON (200, 350): `setCancelGrace:WINDOW,DELAY` in ms, each 0..5000; `setCancelGrace:off`
  = 0,0; `setCancelGrace:on` = the defaults. Kotlin: `HardwareLib.setCancelGrace(windowMs, delayMs)`,
  `cancelGraceWindow`, `cancelGraceDelay`. SETTINGS_JSON: `cancelGraceWindowMs`, `cancelGraceDelayMs`. Backend keys:
  `mdb_cancel_grace_window_ms`, `mdb_cancel_grace_delay_ms`, one number each.
- Log line: `[mdb] onVendFailure came 57 ms after onVendRequest - delivered 350 ms later (cancel grace)`.
  `vendStats` adds `failureDelayed`.
- The bus side is unchanged: the ACK and the cancel reply go out immediately; only the app callback waits.
- The app should still clear its screen from `onVendFailure` and never assume the request screen is up when the
  failure arrives; the grace makes that assumption true in practice, it does not replace the check.

## Since 8.0.0 - 8.2.6 (27 October)

- Ordered vend callbacks on one thread; `onVendFailure(reason)` overload; Java default methods.

## Since 8.0.0 - 8.2.5 and earlier (October)

- Every cancel delivered with a reason (CANCELLED_BY_VMC / CANCELLED_BY_APP / CANCELLED_BY_OPERATOR); `[remote]` replies
  never muted; session-cancel retry wait and count; skip 00 00 vend; RS232 leading-`*` patterns; mqtt-lib 2.8.0 ops
  channel; vendStats; exactly-once publishing; health check that cannot get stuck; force session end.

## Verify after deploy (dashboard passthrough)

| send | expect |
|---|---|
| `version` | `[remote] mqtt-lib 2.8.0, hardware-lib 8.2.7 - client id ...` |
| `getSettings` | `"cancelGraceWindowMs":200,"cancelGraceDelayMs":350` |
| a sale the machine cancels right after the request | log: `onVendFailure came NN ms after onVendRequest - delivered 350 ms later`; app: the screen appears, then closes |
| `vendStats` | `failureDelayed` > 0 after such a sale |
| `setCancelGrace:off` then `getSettings` | both values 0; failures delivered at once |

## Known limits

- Not yet run on a real CM30. Compiled and API-checked only.
- A held failure is delivered 350 ms late by design; a payment gateway hold placed in that window is voided 350 ms
  later than it would otherwise be.
- Everything listed for 8.2.6 still holds.
