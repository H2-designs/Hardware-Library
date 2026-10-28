# Release notes - hardware-lib 8.2.11 + mqtt-lib 2.8.0 + dashboard 8.2.11

Release: https://github.com/RabbahSystems/hardware-library/releases/tag/v8.2.11 (and https://github.com/H2-designs/Hardware-Library/releases/tag/v8.2.11)
Date: 28 October 2026. Replaces v8.2.7 (27 October); 8.2.8, 8.2.9 and 8.2.10 were built the same day and never
released, their content is below. Cumulative against the fleet's hardware-lib 8.0.0 / mqtt-lib 2.6.0.

## TL;DR for the Android app

- Swap `hardware-lib-8.2.11.aar`; mqtt-lib stays 2.8.0. Rebuild. No API change required.
- **Vend event gap, ON by default at 500 ms.** Two `VendListener` callbacks never reach the app closer together than the
  gap: a callback that would follow the previous one sooner waits for the remainder, in order, on the callback thread.
  The app's screen always has the gap to draw one event before the next arrives. Configure it from the dashboard
  (Event gap field, or `setVendEventGap:MS`), from Kotlin (`HardwareLib.setVendEventGap(ms)`) or from React Native
  (`Mdb.setVendEventGap(ms)`); 0 = off, max 5000; persisted on the device.
- Cancel grace delay 500 ms (8.2.10). A cancelled, failed or ended vend never leaves anything behind, and a new VEND
  REQUEST clears every flag of the previous vend (8.2.8 / 8.2.9, field case B11): `approveVend()` returns **false** when
  the vend is already over - void the hold, reverse if captured.
- Everything from 8.2.7 (cancel grace) and 8.2.6 (ordered callbacks, `onVendFailure(reason)`) applies.

## Files

| file | version |
|---|---|
| `libs/hardware-lib-8.2.11.aar` | 8.2.11 (fleet has 8.0.0) |
| `libs/mqtt-lib-2.8.0.aar` | 2.8.0, unchanged (fleet has 2.6.0) |
| `libs/CM30-HardwareLibrary-1.0.9.aar` | unchanged |
| `AAR-Update-latest.zip` | the three AARs + the eight guides |
| `react-native-mdb` 1.4.0 | bundles hardware-lib 8.2.11; adds `setVendEventGap` / `getVendEventGap` / `setCancelGrace` / `getCancelGrace` |
| `Hardware-Dashboard-win32-x64-v8.2.11.zip` | dashboard with the Event gap field |
| `MDB-Slave-2-v2.26.0-build113-debug.apk` | demo/test app on 8.2.11 (private release only) |

```gradle
implementation files('libs/mqtt-lib-2.8.0.aar')
implementation files('libs/hardware-lib-8.2.11.aar')
implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
```

## New in 8.2.11 (28 October) - vend event gap

| | |
|---|---|
| what | the minimum time between two `VendListener` callbacks reaching the app, whatever they are (request, success, failure) |
| how | measured from the START of the previous callback; the next one waits for the remainder on the single callback thread, so order is kept and the bus replies are never delayed |
| default | 500 ms, ON |
| range | 0 (off) .. 5000 ms |
| dashboard | **Event gap** field next to Skip 00 00 Vend (Enter or leave the field sends it); or `setVendEventGap:MS`, `setVendEventGap:on` (500), `setVendEventGap:off` on the passthrough bar |
| Kotlin | `HardwareLib.setVendEventGap(ms): Boolean`, `HardwareLib.vendEventGap` |
| React Native | `Mdb.setVendEventGap(ms)`, `Mdb.getVendEventGap()` (react-native-mdb 1.4.0; also `setCancelGrace(window, delay)` / `getCancelGrace()`) |
| SETTINGS_JSON | `vendEventGapMs` |
| backend key | `mdb_vend_event_gap_ms` (one number) |
| log | `[mdb] VendListener.onVendFailure waits 312 ms - vend event gap 500 ms since the previous callback` |
| vendStats | `eventsSpaced` - callbacks that waited |

Relation to the cancel grace: the grace adds a fixed delay to a failure that arrives right after its request; the gap
spaces every pair of events. Both are on by default; they overlap on the fast-cancel case and the later of the two
wins. Turn either off independently (`setCancelGrace:off`, `setVendEventGap:off`).

A normal sale is unaffected: VEND SUCCESS comes seconds after the request. The gap only shows when the machine
cancels, fails or re-requests within half a second of the previous event.

## New in 8.2.10 (28 October, never released) - cancel grace delay 500 ms

The held `onVendFailure` of the 8.2.7 cancel grace is delivered 500 ms after a failure that came within 200 ms of its
request (was 350 ms). `setCancelGrace:on` = 200,500. A device that stored the old 350 ms default moves to 500 ms once
on first start; any other stored value is kept.

## New in 8.2.9 (28 October, never released) - a new VEND REQUEST clears every flag of the previous vend

| flag of the previous vend | before | now |
|---|---|---|
| an approval nothing consumed | 8.2.8 dropped it | dropped, logged |
| a cancel reply still armed (VEND DENIED / SESSION CANCEL REQUEST not yet sent) | **answered the NEW vend with the deny** | dropped, the new vend is served |
| END SESSION armed by SESSION COMPLETE | **closed the session the machine had just used again** | dropped, the new vend is served |
| the previous vend still open | the app got a second `onVendRequest` with the first still open | closed first: `onVendFailure(CANCELLED_BY_VMC)`, then `onVendRequest`, in that order |

Same rule on the direct-vend path. `vendStats` `requestSupersededFlags`.

## New in 8.2.8 (28 October, never released) - a cancelled, failed or ended vend never leaves an approval behind

Field case B11 (D-0838, D-0178): the payment approved a moment after the machine's VEND CANCEL, `approveVend()` armed
VEND APPROVED for a dead vend, and the next VEND REQUEST of the same session was approved with nobody paying.

| event | before 8.2.8 | now |
|---|---|---|
| VMC VEND CANCEL / READER CANCEL | approve flag cleared, request flag stays until the reply POLL | same, plus `approveVend()` is refused until the reply went out |
| the POLL that sends VEND DENIED / SESSION CANCEL REQUEST | cleared the request flag, **left the approve flag** | clears the approve flag too |
| VEND FAILURE | closed the vend only | clears approve flag, request flag and price |
| SESSION COMPLETE | armed END SESSION only | clears approve flag and request flag at once; `approveVend()` refused |
| END SESSION | cleared cancel / approve / request flags (8.2.0) | also clears the price - nothing remains |
| app / operator `cancelVend()` | approve flag cleared | same, plus a later `approveVend()` is refused |

`approveVend()` returns `false` with `[app] approveVend IGNORED - a cancel reply is already armed (...) - the machine or
the app cancelled this vend first; void / reverse the payment`. `vendStats` `approveAfterCancel`.

### Verified on the JVM

The Rabbah RN team's bus-trace harness (`source/MdbSlaveApp/hardware-lib/bus-trace/`, the real bus loop against a
scripted VMC through a fake CM30 port) plus `bus-trace/extra/`: 18 scenarios, all pass on 8.2.11, including the gap
timing (600 ms gap: a cancel 250 ms after the request reaches the app 599 ms after it; gap 0: 267 ms) and a normal
sale with the gap on.

## Since 8.0.0 - 8.2.7 and 8.2.6 (27 October)

- Cancel grace (`setCancelGrace`); ordered vend callbacks on one thread; `onVendFailure(reason)` overload.

## Since 8.0.0 - 8.2.5 and earlier (October)

- Every cancel delivered with a reason; `[remote]` replies never muted; session-cancel retry wait and count; skip 00 00
  vend; RS232 leading-`*` patterns; mqtt-lib 2.8.0 ops channel; vendStats; exactly-once publishing; health check that
  cannot get stuck; force session end.

## Verify after deploy (dashboard passthrough)

| send | expect |
|---|---|
| `version` | `[remote] mqtt-lib 2.8.0, hardware-lib 8.2.11 - client id ...` |
| `getSettings` | `"vendEventGapMs":500,"cancelGraceWindowMs":200,"cancelGraceDelayMs":500` |
| `setVendEventGap:800` then `getSettings` | `"vendEventGapMs":800`; the dashboard Event gap field shows 800 |
| a sale the machine cancels right after the request | log `VendListener.onVendFailure waits NNN ms - vend event gap 500 ms`; app: the screen appears, then closes |
| `vendStats` | `eventsSpaced` > 0 after such a sale |
| a normal sale, then a second vend in the same session | both approved as before, no wait lines |

## Known limits

- Not yet run on a real CM30. JVM bus-trace and API checks only.
- The gap delays the app's knowledge of a fast cancel by up to the gap; a payment hold placed meanwhile is voided that
  much later.
- Everything listed for 8.2.7 still holds.
