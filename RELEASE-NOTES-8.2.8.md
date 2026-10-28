# Release notes - hardware-lib 8.2.8 + mqtt-lib 2.8.0

Release: https://github.com/RabbahSystems/hardware-library/releases/tag/v8.2.8 (and https://github.com/H2-designs/Hardware-Library/releases/tag/v8.2.8)
Date: 28 October 2026. Replaces v8.2.7 (27 October). Cumulative against the fleet's hardware-lib 8.0.0 / mqtt-lib 2.6.0.

## TL;DR for the Android app

- Swap `hardware-lib-8.2.8.aar`; mqtt-lib stays 2.8.0. Rebuild. No API change.
- **A cancelled, failed or ended vend can no longer leave an approval behind.** Field case B11 (D-0838, D-0178): the
  payment approved a moment after the machine's VEND CANCEL, `approveVend()` armed VEND APPROVED for a vend that was
  already dead, and the NEXT VEND REQUEST of the same session was approved without a payment. One customer charged
  without a product, the next served without paying.
- `approveVend()` now returns **false** while a cancel reply or a session end is armed. Treat `false` as "the machine
  gave up on this vend": void the hold, reverse if captured. The Rabbah RN app already does.
- Everything from 8.2.7 (cancel grace) and 8.2.6 (ordered callbacks, `onVendFailure(reason)`) applies.

## Files

| file | version |
|---|---|
| `libs/hardware-lib-8.2.8.aar` | 8.2.8 (fleet has 8.0.0) |
| `libs/mqtt-lib-2.8.0.aar` | 2.8.0, unchanged (fleet has 2.6.0) |
| `libs/CM30-HardwareLibrary-1.0.9.aar` | unchanged |
| `AAR-Update-latest.zip` | the three AARs + the eight guides |
| `react-native-mdb` 1.3.7 | bundles hardware-lib 8.2.8, no JS change |
| `Hardware-Dashboard-win32-x64-v8.2.5.zip` | unchanged |
| `MDB-Slave-2-v2.23.0-build110-debug.apk` | demo/test app on 8.2.8 (private release only) |

```gradle
implementation files('libs/mqtt-lib-2.8.0.aar')
implementation files('libs/hardware-lib-8.2.8.aar')
implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
```

## New in 8.2.8 (28 October)

### The rule

Once the machine or the app ends a vend, nothing of it stays armed. Once the session is ended, no flag of it remains.

| event | before 8.2.8 | 8.2.8 |
|---|---|---|
| VMC VEND CANCEL / READER CANCEL | approve flag cleared, request flag stays until the reply POLL | same, plus `approveVend()` is refused until the reply went out |
| the POLL that sends VEND DENIED / SESSION CANCEL REQUEST | cleared the request flag, **left the approve flag** | clears the approve flag too |
| VEND FAILURE | closed the vend only | clears approve flag, request flag and price |
| SESSION COMPLETE | armed END SESSION only | clears approve flag and request flag at once; `approveVend()` refused |
| END SESSION | cleared cancel / approve / request flags (8.2.0) | also clears the price - nothing remains |
| a new VEND REQUEST in the same session | **inherited an approve flag still armed** | clears it first; only an `approveVend()` after its own `onVendRequest` can approve it |
| app / operator `cancelVend()` | approve flag cleared | same, plus a later `approveVend()` is refused |

Why three places and not one: a check at call time cannot catch a thread that passed it just before the cancel
arrived, so the reply POLL and the next request also wipe the flag. The direct-vend path already did this; the
in-session path now matches it.

### What the app sees

- `approveVend()` returns `false` with the log line
  `[app] approveVend IGNORED - a cancel reply is already armed (VEND DENIED goes out on the next POLL) - the machine or the app cancelled this vend first; void / reverse the payment`
  (or `... SESSION COMPLETE already received - END SESSION goes out on the next POLL ...`).
- `vendStats` adds `approveAfterCancel`, the number of those refusals. `approveIgnored` keeps counting the
  "no request pending" case.
- The `VendListener` is unchanged. `onVendFailure(reason)` for the cancelled vend fires as before (CANCELLED_BY_VMC,
  CANCELLED_BY_APP, CANCELLED_BY_OPERATOR, FAILED, SESSION_ENDED); the refusal is the second signal, for the payment
  that finished after it.

### Verified on the JVM

The Rabbah React Native team's bus-trace harness (`source/MdbSlaveApp/hardware-lib/bus-trace/`, the real bus loop
against a scripted VMC through a fake CM30 port) runs 8 scenarios; on 8.2.7 four failed (S2, S3, S4, S8), on 8.2.8
all 8 pass. Three more scenarios (`bus-trace/extra/`) cover SESSION COMPLETE, VEND FAILURE and the operator cancel.
Legitimate sales are untouched: a normal sale, a second vend in the same session (Sielaff multi-vend) and a VMC
re-request after an app decline all pass unchanged.

One edge accepted: a VMC that repeats VEND REQUEST between `approveVend()` and the next POLL now loses that
approval (before, the repeat fired `onVendRequest` twice). The window is one POLL; the spec polls instead.

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
| `version` | `[remote] mqtt-lib 2.8.0, hardware-lib 8.2.8 - client id ...` |
| a sale the machine cancels after the payment approved | log `approveVend IGNORED - a cancel reply is already armed`; the next request is NOT approved by itself |
| `vendStats` | `approveAfterCancel` > 0 after such a sale |
| a normal sale, then a second vend in the same session | both approved as before |

## Known limits

- Not yet run on a real CM30. JVM bus-trace and API checks only.
- About 530 devices still run app builds older than 1.0.243 (hardware-lib 7.23.0) where even the END SESSION path leaks;
  only an app upgrade fixes those.
- Everything listed for 8.2.7 still holds.
