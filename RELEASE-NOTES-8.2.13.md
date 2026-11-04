# Release notes - hardware-lib 8.2.13 + mqtt-lib 2.8.0 + dashboard 8.2.13

Release: https://github.com/RabbahSystems/hardware-library/releases/tag/v8.2.13 (and https://github.com/H2-designs/Hardware-Library/releases/tag/v8.2.13)
Date: 4 November 2026. Replaces v8.2.12 (28 October). Cumulative against the fleet's hardware-lib 8.0.0 / mqtt-lib 2.6.0.

## TL;DR for the Android app

- Swap `hardware-lib-8.2.13.aar`; mqtt-lib stays 2.8.0. Rebuild. No API change required.
- **Warm resume, ON by default.** When the reader restarts (app restart or crash, dashboard Close / Open) the machine
  does not notice: it never sends RESET or SETUP again, only READER ENABLE, every 150 ms, waiting for an ACK. Strict
  INACTIVE answered nothing and both sides waited forever (field log 4 November: `UNHANDLED rx=14 01` in a loop, the
  app's setup timed out after 40 s). Now the reader ACKs that READER ENABLE and resumes as ENABLED; the app's health
  check passes at once and the next POLL opens the session. A machine that sends RESET first is never affected.
- Dashboard **Warm Resume** toggle; `setWarmResume:on|off`; Kotlin `HardwareLib.setWarmResume(enabled)` /
  `isWarmResume`; SETTINGS_JSON `warmResume`; backend key `mdb_warm_resume`.
- Everything from 8.2.12 applies: vend event gap, cancel grace 200/500, stale-approve fix, the eight review fixes.

## Files

| file | version |
|---|---|
| `libs/hardware-lib-8.2.13.aar` | 8.2.13 (fleet has 8.0.0) |
| `libs/mqtt-lib-2.8.0.aar` | 2.8.0, unchanged (fleet has 2.6.0) |
| `libs/CM30-HardwareLibrary-1.0.9.aar` | unchanged |
| `AAR-Update-latest.zip` | the three AARs + the eight guides |
| `react-native-mdb` 1.4.2 | bundles hardware-lib 8.2.13, no JS change |
| `Hardware-Dashboard-win32-x64-v8.2.13.zip` | dashboard with the Warm Resume toggle (and the Event gap field) |
| `MDB-Slave-2-v2.28.0-build115-debug.apk` | demo/test app on 8.2.13 (private release only) |

```gradle
implementation files('libs/mqtt-lib-2.8.0.aar')
implementation files('libs/hardware-lib-8.2.13.aar')
implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
```

## New in 8.2.13 (4 November) - warm resume

| | |
|---|---|
| trigger | READER ENABLE (`14 01`) arrives while the reader is INACTIVE and no RESET has been seen since `start()` |
| meaning | the machine was set up before the reader restarted and never saw the restart; its view is the truth |
| action | ACK, resume as ENABLED with the persisted MDB level, arm SESSION BEGIN in auto mode (no JUST RESET announcement - the machine did not reset us) |
| log | `[mdb] READER ENABLE while INACTIVE and no RESET since start - the VMC was set up before this restart; resuming as ENABLED (warm resume, level 2)` |
| exchange line | `READER ENABLE rx=14 01 tx=ACK (warm resume -> ENABLED)` |
| not affected | a machine that sends RESET after the restart: from that RESET on, INACTIVE is spec-strict and the normal SETUP handshake runs |
| OFF | `setWarmResume:off`: INACTIVE stays spec-strict, READER ENABLE unanswered until the machine runs SETUP (the 8.2.12 behaviour) |
| vendStats | `warmResumes` |

Direct Vend ON already ACKed READER ENABLE in INACTIVE (8.2.1) but stayed INACTIVE; warm resume takes precedence and
moves to ENABLED.

## Since 8.0.0 - 8.2.12 (28 October)

- Eight review fixes (stray VEND SUCCESS ignored, VEND SUCCESS / READER DISABLE wipe the vend flags, `beginSession()`
  only when ENABLED, one `onVendFailure` on a simultaneous app + machine cancel, one bus loop after `stop()`/`start()`,
  atomic cancel-grace hand-over, RS232 superseded vend = CANCELLED_BY_VMC).
- Vend event gap (default 500 ms, `setVendEventGap`); cancel grace 200/500 (`setCancelGrace`); a cancelled, failed or
  ended vend never leaves an approval behind and a new VEND REQUEST clears every flag of the previous vend
  (`approveVend()` returns false when the vend is over - void / reverse).

## Since 8.0.0 - 8.2.7 and earlier (October)

- Ordered vend callbacks; `onVendFailure(reason)`; every cancel delivered with a reason; `[remote]` replies never
  muted; session-cancel retry; skip 00 00 vend; RS232 leading-`*` patterns; mqtt-lib 2.8.0 ops channel; vendStats;
  exactly-once publishing; health check that cannot get stuck; force session end.

## Verified on the JVM

Bus-trace harness (`source/MdbSlaveApp/hardware-lib/bus-trace/`): **27 scenarios, all pass on 8.2.13**. New: S25
(Close / Open, then only READER ENABLE from the machine: ACK, ENABLED, session begins, a sale works), S26 (warm resume
OFF: unanswered, still INACTIVE), S27 (the machine sends RESET first: strict handshake, no warm resume). Not yet run on
a real CM30.

## Verify after deploy (dashboard passthrough)

| send | expect |
|---|---|
| `version` | `[remote] mqtt-lib 2.8.0, hardware-lib 8.2.13 - client id ...` |
| `getSettings` | `"warmResume":true` |
| `close` then `open` on a live machine | within a second: `READER ENABLE rx=14 01 tx=ACK (warm resume -> ENABLED)`, then `SESSION BEGIN`; no `UNHANDLED rx=14 01` loop; the app's setup does not time out |
| `vendStats` | `warmResumes` = 1 after that |

## Known limits

- Not yet run on a real CM30.
- Warm resume trusts the machine's READER ENABLE: if a machine enabled the reader before completing SETUP after a
  genuine power-up without a RESET on the bus (not seen in any capture), the reader would resume as ENABLED with the
  persisted level. Turn warm resume off on such a machine.
- Everything listed for 8.2.12 still holds.
