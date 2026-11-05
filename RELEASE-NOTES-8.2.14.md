# Release notes - hardware-lib 8.2.14 + mqtt-lib 2.8.0 + dashboard 8.2.13

Release: https://github.com/RabbahSystems/hardware-library/releases/tag/v8.2.14 (and https://github.com/H2-designs/Hardware-Library/releases/tag/v8.2.14)
Date: 5 November 2026. Replaces v8.2.13 (4 November). Cumulative against the fleet's hardware-lib 8.0.0 / mqtt-lib 2.6.0.

## TL;DR for the Android app

- Swap `hardware-lib-8.2.14.aar`; mqtt-lib stays 2.8.0. Rebuild. No API change.
- **CASH SALE (`13 05`) is answered.** The machine reports every cash sale (price, item) to the cashless reader so it
  can be logged; the reader now ACKs it in every state and logs one line. It used to be UNHANDLED (no reply), so the
  machine retried it a few times after every cash sale (field log 5 November: `rx=13 05 00 FA 00 00 12 tx=UNHANDLED`).
  No VendListener callback: no money moves through the reader.
- Everything from 8.2.13 applies: warm resume, vend event gap, cancel grace, stale-approve fix, the review fixes.

## Files

| file | version |
|---|---|
| `libs/hardware-lib-8.2.14.aar` | 8.2.14 (fleet has 8.0.0) |
| `libs/mqtt-lib-2.8.0.aar` | 2.8.0, unchanged (fleet has 2.6.0) |
| `libs/CM30-HardwareLibrary-1.0.9.aar` | unchanged |
| `AAR-Update-latest.zip` | the three AARs + the eight guides |
| `react-native-mdb` 1.4.3 | bundles hardware-lib 8.2.14, no JS change |
| `Hardware-Dashboard-win32-x64-v8.2.13.zip` | unchanged (Warm Resume toggle, Event gap field) |
| `MDB-Slave-2-v2.29.0-build116-debug.apk` | demo/test app on 8.2.14 (private release only) |

```gradle
implementation files('libs/mqtt-lib-2.8.0.aar')
implementation files('libs/hardware-lib-8.2.14.aar')
implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
```

## New in 8.2.14 (5 November) - CASH SALE answered

| | |
|---|---|
| frame | `13 05 <price hi> <price lo> <item hi> <item lo>` - e.g. `13 05 00 FA 00 00` = price 250, item 0 |
| meaning | a customer paid in cash; the VMC informs the cashless reader for its audit log (spec: reader replies ACK) |
| before | unhandled in every state: no reply, `tx=UNHANDLED`, the VMC retried the command |
| now | ACK in INACTIVE, DISABLED, ENABLED and VEND_STATE; state unchanged; no callback |
| log | `[mdb] CASH SALE price=250 (250 minor units) item=0 - ACK (cash sale reported by the VMC, nothing to do)` |
| exchange line | `CASH SALE rx=13 05 00 FA 00 00 12 tx=ACK (CASH SALE price=250 item=0)` - coded item 132 (`MDB_CASH_SALE`) with price and item for the backend |
| vendStats | `cashSales` |

## Since 8.0.0 - 8.2.13 and earlier

- 8.2.13 warm resume (`setWarmResume`); 8.2.12 eight review fixes; 8.2.11 vend event gap (`setVendEventGap`); 8.2.10
  cancel grace 200/500; 8.2.9 a new VEND REQUEST clears every flag of the previous vend; 8.2.8 a cancelled, failed or
  ended vend never leaves an approval behind (`approveVend()` false when the vend is over); 8.2.7 cancel grace; 8.2.6
  ordered callbacks + `onVendFailure(reason)`; 8.2.5 every cancel with a reason; session-cancel retry; skip 00 00 vend;
  RS232 leading-`*`; mqtt-lib 2.8.0 ops channel; vendStats; health check that cannot get stuck; force session end.

## Verified on the JVM

Bus-trace harness (`source/MdbSlaveApp/hardware-lib/bus-trace/`): **28 scenarios, all pass on 8.2.14**. New: S28, a
CASH SALE in each of the four states is ACKed, nothing reaches the VendListener, the state does not change, and a real
VEND REQUEST afterwards still reaches the app. Not yet run on a real CM30.

## Verify after deploy (dashboard passthrough)

| send | expect |
|---|---|
| `version` | `[remote] mqtt-lib 2.8.0, hardware-lib 8.2.14 - client id ...` |
| a cash sale on the machine | `CASH SALE rx=13 05 ... tx=ACK (CASH SALE price=N item=M)`, no `UNHANDLED` |
| `vendStats` | `cashSales` counts them |

## Known limits

- Not yet run on a real CM30.
- Still open: SETUP / EXPANSION commands in ENABLED and VEND state are unanswered; no timeout for a vend that gets
  neither VEND SUCCESS nor VEND FAILURE after approval.
- Everything listed for 8.2.13 still holds.
