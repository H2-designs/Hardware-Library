# Release notes - hardware-lib 8.2.6 + mqtt-lib 2.8.0

Release: https://github.com/RabbahSystems/hardware-library/releases/tag/v8.2.6 (and https://github.com/H2-designs/Hardware-Library/releases/tag/v8.2.6)
Date: 27 October 2026. Replaces v8.2.5 (25 October). Cumulative against the fleet's hardware-lib 8.0.0 / mqtt-lib 2.6.0.

## TL;DR for the Android app

- Swap `hardware-lib-8.2.6.aar`; mqtt-lib stays 2.8.0 (copy all three AARs from `AAR-Update-latest.zip`). Rebuild. No
  existing signature changes.
- **Ordered callbacks.** For one vend, `onVendRequest` always finishes before its `onVendSuccess` / `onVendFailure` is
  delivered. Until 8.2.5 each callback ran on its own thread, so an app that blocked inside `onVendRequest` could get
  the failure delivered and finished first, then paint a payment screen for a vend that was already dead (field case,
  27 October).
- **`onVendFailure(reason)`.** New overload with the reason as a parameter, captured when the vend was closed. Override
  it instead of reading `lastVendFailureReason`. The default calls the old `onVendFailure()`, so nothing breaks; Java
  implementers now only override what they use.
- **Still mandatory:** return from every callback immediately and do gateway work on your own thread. With ordered
  delivery a request handler that blocks for 10 s now delays the cancel by 10 s; the 3 s watchdog names the offender
  and `vendStats` counts it.
- Everything from 8.2.5 applies: every cancel delivered with CANCELLED_BY_VMC / CANCELLED_BY_APP / CANCELLED_BY_OPERATOR,
  `[remote]` replies never muted, session-cancel retry `MS,COUNT`, skip 00 00 vend, RS232 leading-`*` patterns.

## Files

| file | version |
|---|---|
| `libs/hardware-lib-8.2.6.aar` | 8.2.6 (fleet has 8.0.0) |
| `libs/mqtt-lib-2.8.0.aar` | 2.8.0, unchanged since v8.2.2 (fleet has 2.6.0) |
| `libs/CM30-HardwareLibrary-1.0.9.aar` | unchanged |
| `AAR-Update-latest.zip` | the three AARs + AAR-HANDOFF-README, IMPLEMENTATION-README, VENDLISTENER-README, CANCEL-FLOW-README, SESSION-ENDED-README, DUPLICATE-LOGS-README, API-REFERENCE, PULSE-README |
| `react-native-mdb` 1.3.5 | bundles hardware-lib 8.2.6; the native bridge passes the captured reason |
| `Hardware-Dashboard-win32-x64-v8.2.5.zip` | Windows dashboard, unchanged since 8.2.5 |
| `MDB-Slave-2-v2.21.0-build108-debug.apk` | demo/test app on 8.2.6 / 2.8.0 (private release only) |

```gradle
implementation files('libs/mqtt-lib-2.8.0.aar')
implementation files('libs/hardware-lib-8.2.6.aar')
implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
```

## New in 8.2.6 (27 October)

### Ordered vend callbacks

Field case: the app called its gateway inside `onVendRequest` (about 300 ms); the machine sent VEND CANCEL 57 ms after
the request. The library delivered `onVendFailure` on a second thread, it ran to completion, then `onVendRequest`
returned and the app showed "tap your card" for a vend that no longer existed. Reproduced on a plain JVM with the same
executor: with the 8.2.5 cached pool the failure finishes first; with one thread the request finishes first.

The three vend callbacks now run on ONE ordered thread. For a vend, `onVendRequest` completes before its
`onVendSuccess` or `onVendFailure` is delivered, on MDB and on RS232 alike. The 7.24.0 property that a cancel reached
a stuck request handler at once is gone: a blocking handler now delays the outcome by as long as it blocks. The 3 s
watchdog still logs `WARNING: VendListener.onVendRequest has been running for 3000 ms (stuck #N)` and `vendStats`
still counts `callbackStuck`. Logs, exchange events and bus replies are unaffected either way; they never ran on the
callback thread.

### `onVendFailure(reason: VendFailureReason)`

```kotlin
override fun onVendFailure(reason: HardwareLib.VendFailureReason) {
    when (reason) {
        HardwareLib.VendFailureReason.CANCELLED_BY_VMC,
        HardwareLib.VendFailureReason.CANCELLED_BY_OPERATOR -> if (approved) gateway.reverse() else gateway.voidHold()
        HardwareLib.VendFailureReason.CANCELLED_BY_APP -> {}
        HardwareLib.VendFailureReason.FAILED -> gateway.reverse()
        HardwareLib.VendFailureReason.SESSION_ENDED,
        HardwareLib.VendFailureReason.RESET -> if (approved) gateway.reverse() else gateway.voidHold()
    }
    ui.resetToIdle()
}
```

The reason is captured in the library at the moment the vend is closed and travels with the callback, so a second
failure or a `stop()` before the callback runs cannot overwrite it. `lastVendFailureReason` stays for code that still
reads it; it is written at the same moment. Java: the interface methods are real default methods now
(`-Xjvm-default=all`), override `onVendFailure(VendFailureReason)` only. React Native: unchanged event, the bridge
passes the captured reason.

## Since 8.0.0 - 8.2.5 (25 October)

- Every cancel reaches `onVendFailure` with a reason: CANCELLED_BY_VMC, CANCELLED_BY_APP, CANCELLED_BY_OPERATOR.
- `[remote]` replies never muted by the Logs switch; session-cancel retry wait and count (`setSessionCancelRetry:MS,COUNT`).

## Since 8.0.0 - 8.2.4 and 8.2.3 (24 October)

- Skip 00 00 vend (`setSkipZeroVend:on`); session-cancel retry (D-1637); RS232 leading-`*` rx patterns.

## Since 8.0.0 - 8.2.2 / mqtt-lib 2.8.0 and earlier (October)

- mqtt-lib 2.8.0: only coded items on the backend's `logs` topic; plain and control lines on `devices/<id>/ops`.
- `vendStats` counters; exactly-once publishing (D-0961); health check that cannot get stuck; force session end;
  RS232 rules fire the VendListener; multi-input ready gate; direct vend reports ENABLED_STATE.

## Verify after deploy (dashboard passthrough)

| send | expect |
|---|---|
| `version` | `[remote] mqtt-lib 2.8.0, hardware-lib 8.2.6 - client id ...` |
| a sale the machine cancels right after the request | app: `onVendRequest` returns, THEN one `onVendFailure(CANCELLED_BY_VMC)`; the payment screen closes |
| a sale with a slow gateway inside `onVendRequest` (do not ship this) | `[mdb] WARNING: VendListener.onVendRequest has been running for 3000 ms`, `vendStats` `callbackStuck` rises, the cancel arrives after the handler returns |
| `vendStats` | `STUCK callbacks=0` on a correctly written app |

## Known limits

- Not yet run on a real CM30. Compiled, API-checked (javap: the executor is a single thread, the overload is a default
  method) and reproduced on the JVM only.
- Everything listed for 8.2.5 still holds.
