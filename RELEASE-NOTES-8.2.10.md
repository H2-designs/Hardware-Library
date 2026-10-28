# Release notes - hardware-lib 8.2.10 + mqtt-lib 2.8.0

Release: https://github.com/RabbahSystems/hardware-library/releases/tag/v8.2.10 (and https://github.com/H2-designs/Hardware-Library/releases/tag/v8.2.10)
Date: 28 October 2026. Replaces v8.2.7 (27 October); 8.2.8 and 8.2.9 were built the same day and never released, their
content is below. Cumulative against the fleet's hardware-lib 8.0.0 / mqtt-lib 2.6.0.

## TL;DR for the Android app

- Swap `hardware-lib-8.2.10.aar`; mqtt-lib stays 2.8.0. Rebuild. No API change.
- **Cancel grace delay is now 500 ms** (was 350 ms): a vend failure within 200 ms of its VEND REQUEST is delivered
  500 ms later, so the app's UI has drawn the request before the failure clears it. A device that stored the old 350 ms
  default moves to 500 ms once on first start; a value an operator set explicitly is kept.
- **A cancelled, failed or ended vend can no longer leave anything behind, and a new VEND REQUEST clears every flag of
  the previous vend** (8.2.8 / 8.2.9, field case B11). `approveVend()` returns **false** while a cancel reply or a
  session end is armed: void the hold, reverse if captured. If the machine starts a new vend while the previous one is
  still open, the app gets `onVendFailure(CANCELLED_BY_VMC)` for the old one first, then `onVendRequest` for the new one.
- Everything from 8.2.7 (cancel grace) and 8.2.6 (ordered callbacks, `onVendFailure(reason)`) applies.

## Files

| file | version |
|---|---|
| `libs/hardware-lib-8.2.10.aar` | 8.2.10 (fleet has 8.0.0) |
| `libs/mqtt-lib-2.8.0.aar` | 2.8.0, unchanged (fleet has 2.6.0) |
| `libs/CM30-HardwareLibrary-1.0.9.aar` | unchanged |
| `AAR-Update-latest.zip` | the three AARs + the eight guides |
| `react-native-mdb` 1.3.9 | bundles hardware-lib 8.2.10, no JS change |
| `Hardware-Dashboard-win32-x64-v8.2.5.zip` | unchanged |
| `MDB-Slave-2-v2.25.0-build112-debug.apk` | demo/test app on 8.2.10 (private release only) |

```gradle
implementation files('libs/mqtt-lib-2.8.0.aar')
implementation files('libs/hardware-lib-8.2.10.aar')
implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
```

## New in 8.2.10 (28 October) - cancel grace delay 500 ms

| | 8.2.7 - 8.2.9 | 8.2.10 |
|---|---|---|
| window (failure counted as "right after the request") | 200 ms | 200 ms |
| delay before the held `onVendFailure` is delivered | 350 ms | **500 ms** |
| `setCancelGrace:on` | 200,350 | 200,500 |
| stored 350 from an earlier build | kept | migrated to 500 once (`cancelGraceDefaultsV` = 2); any other stored value is kept |

Everything else about the grace is unchanged: a new VEND REQUEST flushes a held failure first (order kept), the bus
replies are never delayed, all reasons are covered, `setCancelGrace:WINDOW,DELAY` / `off` still work, SETTINGS_JSON
`cancelGraceWindowMs` / `cancelGraceDelayMs`, `vendStats` `failureDelayed`. The log line now reads
`... delivered 500 ms later (cancel grace)`.

## New in 8.2.9 (28 October, never released) - a new VEND REQUEST clears every flag of the previous vend

| flag of the previous vend | before | now |
|---|---|---|
| an approval nothing consumed | 8.2.8 dropped it | dropped, logged |
| a cancel reply still armed (VEND DENIED / SESSION CANCEL REQUEST not yet sent) | **answered the NEW vend with the deny** | dropped, the new vend is served |
| END SESSION armed by SESSION COMPLETE | **closed the session the machine had just used again** | dropped, the new vend is served |
| the previous vend still open | the app got a second `onVendRequest` with the first still open | closed first: `onVendFailure(CANCELLED_BY_VMC)`, then `onVendRequest`, in that order |

Same rule on the direct-vend path. Each drop is one log line; `vendStats` `requestSupersededFlags`.

## New in 8.2.8 (28 October, never released) - a cancelled, failed or ended vend never leaves an approval behind

Field case B11 (D-0838, D-0178): the payment approved a moment after the machine's VEND CANCEL, `approveVend()` passed
its only check (a request had arrived) and armed VEND APPROVED for a dead vend; the POLL that sent VEND DENIED cleared
the request flag but not the approval; the next VEND REQUEST of the same session was approved with nobody paying.

| event | before 8.2.8 | now |
|---|---|---|
| VMC VEND CANCEL / READER CANCEL | approve flag cleared, request flag stays until the reply POLL | same, plus `approveVend()` is refused until the reply went out |
| the POLL that sends VEND DENIED / SESSION CANCEL REQUEST | cleared the request flag, **left the approve flag** | clears the approve flag too |
| VEND FAILURE | closed the vend only | clears approve flag, request flag and price |
| SESSION COMPLETE | armed END SESSION only | clears approve flag and request flag at once; `approveVend()` refused |
| END SESSION | cleared cancel / approve / request flags (8.2.0) | also clears the price - nothing remains |
| app / operator `cancelVend()` | approve flag cleared | same, plus a later `approveVend()` is refused |

### What the app sees

- `approveVend()` returns `false` with
  `[app] approveVend IGNORED - a cancel reply is already armed (VEND DENIED goes out on the next POLL) - the machine or the app cancelled this vend first; void / reverse the payment`
  (or `... SESSION COMPLETE already received - END SESSION goes out on the next POLL ...`).
- `vendStats` adds `approveAfterCancel` and `requestSupersededFlags`. `approveIgnored` keeps counting the "no request
  pending" case.
- The `VendListener` is unchanged: three callbacks, one `onVendSuccess` or `onVendFailure` per `onVendRequest`.

### Verified on the JVM

The Rabbah RN team's bus-trace harness (`source/MdbSlaveApp/hardware-lib/bus-trace/`, the real bus loop against a
scripted VMC through a fake CM30 port) plus `bus-trace/extra/`: 15 scenarios, all pass on 8.2.10. On 8.2.7 four of the
team's eight failed. Covered: the B11 replay with and without END SESSION, SESSION CANCEL REQUEST ignored, approve while
the cancel reply is armed, the thread race, app decline then VMC retry, Sielaff multi-vend, SESSION COMPLETE then late
approve, VEND FAILURE before the approve POLL, operator cancel then late approve, VEND CANCEL then a new request before
any POLL, a second request while the first is open, SESSION COMPLETE then a new request, a plain sale.

One edge accepted: a VMC that repeats VEND REQUEST between `approveVend()` and the next POLL now closes the first vend
(`onVendFailure(CANCELLED_BY_VMC)`) and asks again; before, the repeat fired `onVendRequest` twice with the first vend
still open. The window is one POLL; the spec polls instead of repeating.

## Since 8.0.0 - 8.2.7 and 8.2.6 (27 October)

- Cancel grace (`setCancelGrace`); ordered vend callbacks on one thread; `onVendFailure(reason)` overload.

## Since 8.0.0 - 8.2.5 and earlier (October)

- Every cancel delivered with a reason; `[remote]` replies never muted; session-cancel retry wait and count; skip 00 00
  vend; RS232 leading-`*` patterns; mqtt-lib 2.8.0 ops channel; vendStats; exactly-once publishing; health check that
  cannot get stuck; force session end.

## Verify after deploy (dashboard passthrough)

| send | expect |
|---|---|
| `version` | `[remote] mqtt-lib 2.8.0, hardware-lib 8.2.10 - client id ...` |
| `getSettings` | `"cancelGraceWindowMs":200,"cancelGraceDelayMs":500` |
| a sale the machine cancels right after the request | log `onVendFailure came NN ms after onVendRequest - delivered 500 ms later`; app: the screen appears, then closes |
| a sale the machine cancels after the payment approved | log `approveVend IGNORED - a cancel reply is already armed`; the next request is NOT approved by itself |
| `vendStats` | `failureDelayed`, `approveAfterCancel`, `requestSupersededFlags` as applicable |
| a normal sale, then a second vend in the same session | both approved as before |

## Known limits

- Not yet run on a real CM30. JVM bus-trace and API checks only.
- About 530 devices still run app builds older than 1.0.243 (hardware-lib 7.23.0) where even the END SESSION path leaks;
  only an app upgrade fixes those.
- A held failure is delivered 500 ms late by design; a payment gateway hold placed in that window is voided 500 ms
  later than it would otherwise be.
- Everything listed for 8.2.7 still holds.
