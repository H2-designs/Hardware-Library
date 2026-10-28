# Release notes - hardware-lib 8.2.9 + mqtt-lib 2.8.0

Release: https://github.com/RabbahSystems/hardware-library/releases/tag/v8.2.9 (and https://github.com/H2-designs/Hardware-Library/releases/tag/v8.2.9)
Date: 28 October 2026. Replaces v8.2.7 (27 October); 8.2.8 was built the same day and never released, its content is
below. Cumulative against the fleet's hardware-lib 8.0.0 / mqtt-lib 2.6.0.

## TL;DR for the Android app

- Swap `hardware-lib-8.2.9.aar`; mqtt-lib stays 2.8.0. Rebuild. No API change.
- **A cancelled, failed or ended vend can no longer leave anything behind, and a new VEND REQUEST clears every flag of
  the previous vend.** Field case B11 (D-0838, D-0178): the payment approved a moment after the machine's VEND CANCEL,
  `approveVend()` armed VEND APPROVED for a vend that was already dead, and the NEXT VEND REQUEST of the same session was
  approved without a payment.
- `approveVend()` now returns **false** while a cancel reply or a session end is armed. Treat `false` as "the machine
  gave up on this vend": void the hold, reverse if captured. The Rabbah RN app already does.
- If the machine starts a new vend while the previous one is still open, the app gets `onVendFailure(CANCELLED_BY_VMC)`
  for the old one first, then `onVendRequest` for the new one. One open vend at a time, always.
- Everything from 8.2.7 (cancel grace) and 8.2.6 (ordered callbacks, `onVendFailure(reason)`) applies.

## Files

| file | version |
|---|---|
| `libs/hardware-lib-8.2.9.aar` | 8.2.9 (fleet has 8.0.0) |
| `libs/mqtt-lib-2.8.0.aar` | 2.8.0, unchanged (fleet has 2.6.0) |
| `libs/CM30-HardwareLibrary-1.0.9.aar` | unchanged |
| `AAR-Update-latest.zip` | the three AARs + the eight guides |
| `react-native-mdb` 1.3.8 | bundles hardware-lib 8.2.9, no JS change |
| `Hardware-Dashboard-win32-x64-v8.2.5.zip` | unchanged |
| `MDB-Slave-2-v2.24.0-build111-debug.apk` | demo/test app on 8.2.9 (private release only) |

```gradle
implementation files('libs/mqtt-lib-2.8.0.aar')
implementation files('libs/hardware-lib-8.2.9.aar')
implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
```

## New in 8.2.9 (28 October) - a new VEND REQUEST clears every flag of the previous vend

| flag of the previous vend | before | 8.2.9 |
|---|---|---|
| an approval nothing consumed | 8.2.8 dropped it | dropped, logged |
| a cancel reply still armed (VEND DENIED / SESSION CANCEL REQUEST not yet sent) | **answered the NEW vend with the deny** | dropped, the new vend is served |
| END SESSION armed by SESSION COMPLETE | **closed the session the machine had just used again** | dropped, the new vend is served ("the machine kept the session") |
| the previous vend still open (no cancel / success / failure for it) | the app got a second `onVendRequest` with the first still open | closed first: `onVendFailure(CANCELLED_BY_VMC)`, then `onVendRequest` for the new one, in that order |

Same rule on the direct-vend path (a VEND REQUEST outside a session). Each drop is one log line
(`[mdb] VEND REQUEST while a cancel reply was still armed (VEND DENIED) - dropped, the new vend is served`, ...) and
`vendStats` counts them in `requestSupersededFlags`. A normal sale, a second vend in the same session and a VMC
re-request after an app decline are untouched.

## New in 8.2.8 (28 October, never released) - a cancelled, failed or ended vend never leaves an approval behind

| event | before 8.2.8 | now |
|---|---|---|
| VMC VEND CANCEL / READER CANCEL | approve flag cleared, request flag stays until the reply POLL | same, plus `approveVend()` is refused until the reply went out |
| the POLL that sends VEND DENIED / SESSION CANCEL REQUEST | cleared the request flag, **left the approve flag** | clears the approve flag too |
| VEND FAILURE | closed the vend only | clears approve flag, request flag and price |
| SESSION COMPLETE | armed END SESSION only | clears approve flag and request flag at once; `approveVend()` refused |
| END SESSION | cleared cancel / approve / request flags (8.2.0) | also clears the price - nothing remains |
| app / operator `cancelVend()` | approve flag cleared | same, plus a later `approveVend()` is refused |

Why in several places and not one: a check at call time cannot catch a thread that passed it just before the cancel
arrived, so the reply POLL and the next request also wipe the flag.

### What the app sees

- `approveVend()` returns `false` with
  `[app] approveVend IGNORED - a cancel reply is already armed (VEND DENIED goes out on the next POLL) - the machine or the app cancelled this vend first; void / reverse the payment`
  (or `... SESSION COMPLETE already received - END SESSION goes out on the next POLL ...`).
- `vendStats` adds `approveAfterCancel` (those refusals) and `requestSupersededFlags` (flags a new request dropped).
  `approveIgnored` keeps counting the "no request pending" case.
- The `VendListener` is unchanged: three callbacks, one `onVendSuccess` or `onVendFailure` per `onVendRequest`.

### Verified on the JVM

The Rabbah RN team's bus-trace harness (`source/MdbSlaveApp/hardware-lib/bus-trace/`: the real bus loop against a
scripted VMC through a fake CM30 port) plus `bus-trace/extra/`: 15 scenarios, all pass on 8.2.9. On 8.2.7 four of the
team's eight failed. Covered: the B11 replay with and without END SESSION, SESSION CANCEL REQUEST ignored, approve while
the cancel reply is armed, the thread race, app decline then VMC retry, Sielaff multi-vend, SESSION COMPLETE then late
approve, VEND FAILURE before the approve POLL, operator cancel then late approve, VEND CANCEL then a new request before
any POLL, a second request while the first is open, SESSION COMPLETE then a new request, a plain sale.

One edge accepted: a VMC that repeats VEND REQUEST between `approveVend()` and the next POLL now closes the first vend
(`onVendFailure(CANCELLED_BY_VMC)`) and asks again; before, the repeat fired `onVendRequest` twice with the first vend
still open. The window is one POLL; the spec polls instead of repeating.

## Since 8.0.0 - 8.2.7 and 8.2.6 (27 October)

- Cancel grace: an `onVendFailure` within 200 ms of its `onVendRequest` is delivered 350 ms later (`setCancelGrace`).
- Ordered vend callbacks on one thread; `onVendFailure(reason)` overload.

## Since 8.0.0 - 8.2.5 and earlier (October)

- Every cancel delivered with a reason; `[remote]` replies never muted; session-cancel retry wait and count; skip 00 00
  vend; RS232 leading-`*` patterns; mqtt-lib 2.8.0 ops channel; vendStats; exactly-once publishing; health check that
  cannot get stuck; force session end.

## Verify after deploy (dashboard passthrough)

| send | expect |
|---|---|
| `version` | `[remote] mqtt-lib 2.8.0, hardware-lib 8.2.9 - client id ...` |
| a sale the machine cancels after the payment approved | log `approveVend IGNORED - a cancel reply is already armed`; the next request is NOT approved by itself |
| `vendStats` | `approveAfterCancel` > 0 after such a sale; `requestSupersededFlags` > 0 if the machine ever re-requested with something armed |
| a normal sale, then a second vend in the same session | both approved as before |

## Known limits

- Not yet run on a real CM30. JVM bus-trace and API checks only.
- About 530 devices still run app builds older than 1.0.243 (hardware-lib 7.23.0) where even the END SESSION path leaks;
  only an app upgrade fixes those.
- Everything listed for 8.2.7 still holds.
