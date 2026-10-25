# Release notes - hardware-lib 8.2.4 + mqtt-lib 2.8.0

Release: https://github.com/RabbahSystems/hardware-library/releases/tag/v8.2.4 (and https://github.com/H2-designs/Hardware-Library/releases/tag/v8.2.4)
Date: 24 October 2026. Replaces v8.2.3 (same day). Cumulative against the fleet's hardware-lib 8.0.0 / mqtt-lib 2.6.0.

## TL;DR for the Android app

- Swap `hardware-lib-8.2.4.aar`. mqtt-lib stays 2.8.0 (copy all three AARs from `AAR-Update-latest.zip` anyway). Rebuild.
  No app code change. The API only grows; every machine behaves exactly as before until an operator turns a new
  setting on.
- New for MDB: **skip 00 00 vend**. For machines that keep sending VEND REQUEST with price `00 00` until the customer
  selects an item. Operator setting, default OFF: `setSkipZeroVend:on` or the dashboard **Skip 00 00 Vend** toggle.
- Everything from 8.2.3 still applies: session-cancel retry (`setSessionCancelRetry:on`), RS232 leading-`*` rx
  patterns. See `RELEASE-NOTES-8.2.3.md`.

## Files

| file | version |
|---|---|
| `libs/hardware-lib-8.2.4.aar` | 8.2.4 (fleet has 8.0.0) |
| `libs/mqtt-lib-2.8.0.aar` | 2.8.0, unchanged since v8.2.2 (fleet has 2.6.0) |
| `libs/CM30-HardwareLibrary-1.0.9.aar` | unchanged |
| `AAR-Update-latest.zip` | the three AARs + AAR-HANDOFF-README, IMPLEMENTATION-README, VENDLISTENER-README, SESSION-ENDED-README, DUPLICATE-LOGS-README, API-REFERENCE, PULSE-README |
| `react-native-mdb` 1.3.3 | bundles hardware-lib 8.2.4 + mqtt-lib 2.8.0 |
| `Hardware-Dashboard-win32-x64-v8.2.4.zip` | Windows dashboard (not in git, on the release): **Skip 00 00 Vend** and **Cancel Retry** toggles next to Force End, skipped count and session-cancel retries on the **Vend** line, plus everything from v8.2.2 |
| `MDB-Slave-2-v2.19.0-build106-debug.apk` | demo/test app rebuilt on 8.2.4 / 2.8.0 (25 October) |

```gradle
implementation files('libs/mqtt-lib-2.8.0.aar')
implementation files('libs/hardware-lib-8.2.4.aar')
implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
```

## New in 8.2.4 (24 October)

### MDB: skip 00 00 vend requests

Field case: a machine keeps sending VEND REQUEST `13 00 00 00 ...` (price `00 00`) while the customer is still choosing,
and sends a VEND REQUEST with the real price only once an item is selected. Up to 8.2.3 every one of those reached the
app as `onVendRequest(0.0, 0, item)`, so the app started a 0.00 payment over and over.

New persisted setting, default OFF:

```
setSkipZeroVend:on      VEND REQUEST priced 00 00 is ACKed and ignored
setSkipZeroVend:off     every VEND REQUEST reaches the app (as before)
```

With it ON, a VEND REQUEST whose two price bytes are `00 00`:

- is ACKed on the bus, as the protocol requires, and dropped: no `onVendRequest`, no vend opened, no state change;
- leaves everything else as it was: an open vend waiting for approval, a pending `approveVend()`, a session-cancel
  retry - a 00 00 request is not a new vend;
- is handled the same in a session and with direct vend (it does not move the reader into VEND_STATE).

The next VEND REQUEST with a real price is handled exactly as before.

- Log: `[mdb] VEND REQUEST with price 00 00 skipped (skip 00 00 vend ON) - ACK only, no onVendRequest (N so far)`, at
  most one line per 10 s. The dropped exchanges themselves are hidden like idle POLLs (visible with
  `setPollVisibility:on`), so a machine sending 00 00 continuously cannot flood the log or the backend.
- `vendStats` adds `zeroVendSkipped`; SETTINGS_JSON adds `skipZeroVend`.
- Kotlin: `HardwareLib.setSkipZeroVend(Boolean)`, `HardwareLib.isSkipZeroVend`. The VendListener
  callbacks are unchanged.
- MDB only (RS232 rules set their own price positions).
- Leave it OFF on machines that really sell at price 0 (free vend): those vends would be ignored too.

## Since 8.0.0 - 8.2.3 (24 October)

- Session-cancel retry: an unanswered SESSION CANCEL REQUEST is re-sent after 1000 ms, up to 3 times
  (`setSessionCancelRetry:on`, field case D-1637).
- RS232: an rx pattern may start with `*` to match the end of a frame.

## Since 8.0.0 - 8.2.2 / mqtt-lib 2.8.0 (22 October)

- Your own `cancelVend()` is no longer echoed as `onVendFailure`.
- mqtt-lib 2.8.0: only coded items on the backend's `logs` topic; plain and control lines on `devices/<id>/ops`.
- `vendStats` counters, including stuck VendListener callbacks.

## Since 8.0.0 - 8.2.1, 8.2.0, 8.1.0 (October)

- Every exchange reaches the backend exactly once (D-0961); a health check that cannot get stuck.
- Force session end after vend (`setForceSessionEnd:on|off`).
- RS232 rules fire the same VendListener; multi-input ready gate; direct vend reports ENABLED_STATE.

## Verify after deploy (dashboard passthrough)

| send | expect |
|---|---|
| `version` | `[remote] mqtt-lib 2.8.0, hardware-lib 8.2.4 - client id ...` (arrives on the ops channel) |
| `setSkipZeroVend:on` | `[remote] skip 00 00 vend ON ...`; `SETTINGS_JSON` with `"skipZeroVend":true`; the **Skip 00 00 Vend** toggle turns on |
| on the machine: browse without selecting | one `[mdb] VEND REQUEST with price 00 00 skipped ...` line per 10 s, no payment started in the app |
| select an item | normal `VEND REQUEST ... price=<real price>`, one `onVendRequest` in the app |
| `vendStats` | `zeroVendSkipped` > 0 |

## Known limits

- Not yet run on a real CM30. Compiled and API-checked only; no automated test.
- The machine is never answered with VEND DENIED for a 00 00 request: it only gets the ACK. If a machine waits for a
  decision on 00 00 requests, tell us with a log.
- Everything listed for 8.2.3 still holds.
