# Release notes - hardware-lib 8.2.12 + mqtt-lib 2.8.0 + dashboard 8.2.11

Release: https://github.com/RabbahSystems/hardware-library/releases/tag/v8.2.12 (and https://github.com/H2-designs/Hardware-Library/releases/tag/v8.2.12)
Date: 28 October 2026. Replaces v8.2.7 (27 October); 8.2.8 to 8.2.11 were built the same day and never released,
their content is below. Cumulative against the fleet's hardware-lib 8.0.0 / mqtt-lib 2.6.0.

## TL;DR for the Android app

- Swap `hardware-lib-8.2.12.aar`; mqtt-lib stays 2.8.0. Rebuild. No API change required.
- **Vend event gap, ON at 500 ms** (8.2.11): two `VendListener` callbacks never reach the app closer together than the
  gap. Configure from the dashboard (Event gap field / `setVendEventGap:MS`), Kotlin (`setVendEventGap`) or React
  Native (`Mdb.setVendEventGap`).
- **Cancel grace delay 500 ms** (8.2.10).
- **A cancelled, failed or ended vend never leaves anything behind; a new VEND REQUEST clears every flag of the
  previous vend** (8.2.8 / 8.2.9, field case B11): `approveVend()` returns **false** when the vend is already over.
- **Eight review fixes** (8.2.12): a stray VEND SUCCESS after a cancel no longer fires `onVendSuccess`; VEND SUCCESS
  and READER DISABLE wipe the vend's flags; `beginSession()` is refused until the reader is enabled; a cancel from the
  app and from the machine in the same instant fires `onVendFailure` once; `stop()` then `start()` back to back runs
  one bus loop; the cancel-grace hand-over is atomic and a success flushes a held failure; RS232 uses CANCELLED_BY_VMC
  when a new request supersedes an open vend.
- Everything from 8.2.7 (cancel grace) and 8.2.6 (ordered callbacks, `onVendFailure(reason)`) applies.

## Files

| file | version |
|---|---|
| `libs/hardware-lib-8.2.12.aar` | 8.2.12 (fleet has 8.0.0) |
| `libs/mqtt-lib-2.8.0.aar` | 2.8.0, unchanged (fleet has 2.6.0) |
| `libs/CM30-HardwareLibrary-1.0.9.aar` | unchanged |
| `AAR-Update-latest.zip` | the three AARs + the eight guides |
| `react-native-mdb` 1.4.1 | bundles hardware-lib 8.2.12; 1.4.0 added `setVendEventGap` / `getVendEventGap` / `setCancelGrace` / `getCancelGrace` |
| `Hardware-Dashboard-win32-x64-v8.2.11.zip` | dashboard with the Event gap field |
| `MDB-Slave-2-v2.27.0-build114-debug.apk` | demo/test app on 8.2.12 (private release only) |

```gradle
implementation files('libs/mqtt-lib-2.8.0.aar')
implementation files('libs/hardware-lib-8.2.12.aar')
implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
```

## New in 8.2.12 (28 October) - the eight fixes of the code review

| # | what was wrong | what 8.2.12 does |
|---|---|---|
| 1 | VEND SUCCESS fired `onVendSuccess` even for a vend already cancelled or failed (the app captured a payment it had voided), and left the request flag set, so a late `approveVend()` sent VEND APPROVED after the sale | `onVendSuccess` only for an open vend; otherwise ACK, log `VEND SUCCESS with no vend open ... onVendSuccess NOT fired`, `vendStats` `successIgnored`. VEND SUCCESS clears the approve flag, the request flag and the price |
| 2 | a cancel-grace held failure followed by a VEND SUCCESS within the delay could deliver the success first | any later callback (request or success) flushes the held failure first |
| 3 | the grace hand-over ran outside its lock: a VEND REQUEST at the exact expiry could be queued before the old failure | hand-over and enqueue happen under one lock |
| 4 | the app's `cancelVend()` and the machine's VEND CANCEL in the same instant could both close the vend: `onVendFailure` twice | the vend is closed with one compare-and-set; exactly one `onVendFailure` |
| 5 | `stop()` then `start()` back to back could leave the old bus loop running next to the new one (two readers on one port) | a loop generation ends the old loops; `stop()` waits up to 1.5 s for the old bus loop to leave the port |
| 6 | RS232 closed a superseded vend with SESSION_ENDED while MDB used CANCELLED_BY_VMC for the same case | both paths: CANCELLED_BY_VMC |
| 7 | `beginSession()` (manual mode "card tap") armed in any state, so a tap before READER ENABLE opened a session whenever the reader was enabled later | refused unless the reader is ENABLED (`beginSession IGNORED - the reader is not enabled`) |
| 8 | READER DISABLE mid-session left the request flag set | clears request flag and price too |

No API change. Behaviour that changes for an app: `beginSession()` can now return false before READER ENABLE (log and
retry on ENABLED), and `onVendSuccess` no longer arrives for a vend that already got `onVendFailure`.

## New in 8.2.11 (28 October, never released) - vend event gap

| | |
|---|---|
| what | the minimum time between two `VendListener` callbacks reaching the app, whatever they are |
| how | measured from the start of the previous callback; the next one waits for the remainder on the single callback thread, so order is kept and the bus replies are never delayed |
| default | 500 ms, ON; range 0 (off) .. 5000 ms; persisted |
| dashboard | **Event gap** field next to Skip 00 00 Vend; or `setVendEventGap:MS`, `on` (500), `off` |
| Kotlin | `HardwareLib.setVendEventGap(ms)`, `HardwareLib.vendEventGap` |
| React Native | `Mdb.setVendEventGap(ms)`, `Mdb.getVendEventGap()`; also `setCancelGrace(window, delay)` / `getCancelGrace()` |
| SETTINGS_JSON / backend key | `vendEventGapMs` / `mdb_vend_event_gap_ms` |
| log / vendStats | `VendListener.onVendFailure waits 312 ms - vend event gap 500 ms since the previous callback` / `eventsSpaced` |

Independent of the cancel grace; both on by default, the later of the two wins. A normal sale is unaffected.

## New in 8.2.10 (28 October, never released) - cancel grace delay 500 ms

Was 350 ms. `setCancelGrace:on` = 200,500. A stored 350 is migrated to 500 once; any other stored value is kept.

## New in 8.2.9 (28 October, never released) - a new VEND REQUEST clears every flag of the previous vend

A stale approval, a cancel reply still armed (it used to deny the NEW vend), an END SESSION armed by SESSION COMPLETE
(it used to close the session the machine had just used again) are dropped, and a previous vend still open is closed
first with `onVendFailure(CANCELLED_BY_VMC)` before `onVendRequest` for the new one. `vendStats` `requestSupersededFlags`.

## New in 8.2.8 (28 October, never released) - a cancelled, failed or ended vend never leaves an approval behind

Field case B11 (D-0838, D-0178): the payment approved a moment after the machine's VEND CANCEL, `approveVend()` armed
VEND APPROVED for a dead vend, and the next VEND REQUEST of the same session was approved with nobody paying. Now
`approveVend()` returns **false** while a cancel reply or a session end is armed (`approveVend IGNORED - a cancel reply
is already armed ...`; `vendStats` `approveAfterCancel`); the cancel-reply POLL, VEND FAILURE, SESSION COMPLETE and END
SESSION wipe the approve flag. Treat `false` as "the machine gave up": void / reverse.

### Verified on the JVM

The Rabbah RN team's bus-trace harness (`source/MdbSlaveApp/hardware-lib/bus-trace/`, the real bus loop against a
scripted VMC through a fake CM30 port) plus `bus-trace/extra/`: **24 scenarios, all pass on 8.2.12**. 8.2.12 adds: a
stray VEND SUCCESS after a cancel, VEND SUCCESS before the approve POLL, READER DISABLE mid-session, `beginSession()`
before and after READER ENABLE, three quick `stop()`/`start()` cycles (one bus loop), and a simultaneous app + machine
cancel (one `onVendFailure`).

## Since 8.0.0 - 8.2.7 and 8.2.6 (27 October)

- Cancel grace (`setCancelGrace`); ordered vend callbacks on one thread; `onVendFailure(reason)` overload.

## Since 8.0.0 - 8.2.5 and earlier (October)

- Every cancel delivered with a reason; `[remote]` replies never muted; session-cancel retry wait and count; skip 00 00
  vend; RS232 leading-`*` patterns; mqtt-lib 2.8.0 ops channel; vendStats; exactly-once publishing; health check that
  cannot get stuck; force session end.

## Verify after deploy (dashboard passthrough)

| send | expect |
|---|---|
| `version` | `[remote] mqtt-lib 2.8.0, hardware-lib 8.2.12 - client id ...` |
| `getSettings` | `"vendEventGapMs":500,"cancelGraceWindowMs":200,"cancelGraceDelayMs":500` |
| `setVendEventGap:800` then `getSettings` | `"vendEventGapMs":800`; the dashboard Event gap field shows 800 |
| a sale the machine cancels right after the request | log `VendListener.onVendFailure waits NNN ms - vend event gap 500 ms`; app: the screen appears, then closes |
| a sale the machine cancels after the payment approved | log `approveVend IGNORED - a cancel reply is already armed`; the next request is NOT approved by itself |
| `vendStats` | `eventsSpaced`, `approveAfterCancel`, `requestSupersededFlags`, `successIgnored` as applicable |
| a normal sale, then a second vend in the same session | both approved as before, no wait lines |

## Known limits

- Not yet run on a real CM30. JVM bus-trace and API checks only.
- The gap delays the app's knowledge of a fast cancel by up to the gap; a payment hold placed meanwhile is voided that
  much later.
- Still open (unchanged): SETUP / EXPANSION commands in ENABLED and VEND state are unanswered, CASH SALE 13 05 is
  unhandled, no timeout for a vend that gets neither VEND SUCCESS nor VEND FAILURE after approval.
