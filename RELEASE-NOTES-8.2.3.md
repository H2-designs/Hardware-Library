# Release notes - hardware-lib 8.2.3 + mqtt-lib 2.8.0

Release: https://github.com/RabbahSystems/hardware-library/releases/tag/v8.2.3
Date: 24 October 2026. Replaces v8.2.2 (22 October). Cumulative against the fleet's hardware-lib 8.0.0 / mqtt-lib 2.6.0.

## TL;DR for the Android app

- Swap `hardware-lib-8.2.3.aar`. mqtt-lib stays 2.8.0 (copy all three AARs from `AAR-Update-latest.zip` anyway). Rebuild.
  No app code change. The API only grows; every machine behaves exactly as on 8.2.2 until an operator turns a new
  setting on.
- New for MDB: **session-cancel retry** (field case D-1637). When the machine ignores a SESSION CANCEL REQUEST, the
  reader sends it again after 1000 ms instead of the machine stalling 20-30 s. Operator setting, default OFF:
  `setSessionCancelRetry:on` or the dashboard **Cancel Retry** toggle.
- New for RS232: an `rx` pattern may START with `*` to match the END of a frame (`"* 53 E7"`), for machines that send a
  frame in two pieces. Rule table only, no app code.
- Everything from 8.2.2 still applies: no `onVendFailure` echo for your own `cancelVend()`, reverse on FAILED,
  SESSION_ENDED and RESET when approved, `vendStats`, mqtt-lib 2.8.0 `ops` channel.

## Files

| file | version |
|---|---|
| `libs/hardware-lib-8.2.3.aar` | 8.2.3 (fleet has 8.0.0) |
| `libs/mqtt-lib-2.8.0.aar` | 2.8.0, unchanged since v8.2.2 (fleet has 2.6.0) |
| `libs/CM30-HardwareLibrary-1.0.9.aar` | unchanged |
| `AAR-Update-latest.zip` | the three AARs + AAR-HANDOFF-README, IMPLEMENTATION-README, VENDLISTENER-README, SESSION-ENDED-README, DUPLICATE-LOGS-README, API-REFERENCE, PULSE-README |
| `react-native-mdb` 1.3.2 | bundles hardware-lib 8.2.3 + mqtt-lib 2.8.0 |
| `MDB-Slave-2-v2.18.0-build105-debug.apk` | demo/test app, NOT rebuilt for this release (still on 8.2.2 / 2.8.0) |
| `dashboard-app/dashboard.html` | **Cancel Retry** toggle next to Force End, retry counters on the **Vend** line; the packaged `Hardware-Dashboard-win32-x64` zip is NOT rebuilt yet (`npm run package`) |

```gradle
implementation files('libs/mqtt-lib-2.8.0.aar')
implementation files('libs/hardware-lib-8.2.3.aar')
implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
```

## New in 8.2.3 (24 October)

### MDB: session-cancel retry

Field case D-1637 (22 October, cancel mode `sessionCancel`). The machine sends VEND CANCEL, the reader ACKs it and
answers SESSION CANCEL REQUEST on the next POLL, the machine should answer SESSION COMPLETE. In the log 47 requests went
out; 44 were answered within 0.36 s. Three were ignored:

| request sent | machine did | stall |
|---|---|---|
| 11:20:38.594 | nothing until VEND CANCEL again at 11:21:05.632 | 27 s |
| 11:21:14.644 | nothing until VEND CANCEL again at 11:21:43.960 | 29 s |
| 11:23:31.387 | nothing until VEND CANCEL again at 11:23:52.707 | 21 s |

Each time the second SESSION CANCEL REQUEST (our answer to the repeated VEND CANCEL) was answered at once. Until then
the session stayed open and the next customer could not buy. Up to 8.2.2 the reader sent the request once and waited
forever; Force End has the same gap after VEND SUCCESS.

New persisted setting, default OFF:

```
setSessionCancelRetry:on        wait 1000 ms (about 3x the slowest answer seen), then re-send
setSessionCancelRetry:1500      any wait from 300 to 10000 ms
setSessionCancelRetry:off       spec behaviour: sent once
```

- Covers EVERY SESSION CANCEL REQUEST the reader sends: the answer to the machine's VEND CANCEL or READER CANCEL, the
  app's `cancelVend()`, and Force End.
- Re-sent on the next POLL after the wait, up to 3 times. Then one line
  `[mdb] WARNING: no SESSION COMPLETE after 3 re-sent SESSION CANCEL REQUESTs ...` and the session is left to the machine.
- Stops as soon as SESSION COMPLETE arrives, and on END SESSION, RESET and `start()`.
- **A new VEND REQUEST stops it.** If the machine keeps the session and the customer picks again, that vend is served
  normally, never cancelled: `[mdb] VEND REQUEST while waiting for SESSION COMPLETE - the machine kept the session; ...`.
- With cancel mode `vendDenied` the reader sends VEND DENIED, not SESSION CANCEL REQUEST, so nothing is retried: the
  spec lets the session stay open after a denial.
- The re-send is a normal `POLL tx=SESSION CANCEL REQUEST` exchange (same coded log item as the first send), preceded by
  `[mdb] no SESSION COMPLETE 1012 ms after SESSION CANCEL REQUEST - sent again (retry 1/3)`.
- `vendStats` adds `sessionCancelRetries` and `sessionCancelGaveUp`; SETTINGS_JSON adds `sessionCancelRetryMs` (0 = off).
- Kotlin: `HardwareLib.setSessionCancelRetry(enabled: Boolean)`, `setSessionCancelRetry(ms: Int)`,
  `isSessionCancelRetry`, `sessionCancelRetryWaitMs`. The VendListener callbacks are unchanged.
- Force End or retry? Force End decides WHEN the reader asks to close (after VEND SUCCESS). The retry makes sure a
  request the machine ignored is asked again. They are independent; a machine can need either or both. D-1637 needs the
  retry.

### RS232: a leading `*` matches the end of a frame

RS232 has no frame markers: the library cuts frames by silence (`frameGapMs`). A machine that pauses in the middle of
a frame for longer than the gap arrives as two frames. The head piece matched no rule (`[rs232] ... UNMATCHED`, code
138) and the tail piece matched nothing either, so the result the machine sent was lost.

An `rx` pattern may now start with `*`: the remaining tokens are matched against the frame's LAST bytes, and any number
of bytes (including none) may come before them.

| pattern | matches |
|---|---|
| `A0 03 00 07 53 55 43 43 45 53 53 E7` | exactly that 12-byte frame (unchanged) |
| `A0 01 *` | every frame STARTING `A0 01` (unchanged) |
| `* 53 E7` | every frame ENDING `53 E7` (new) |
| `* ?? 53 E7` | every frame of 3+ bytes whose last two are `53 E7` (`??` works as before) |
| `* A0 *` | rejected: `*` at both ends would be a contains-match, not supported |

Example - the Loyalsuns Making Success frame arrives split, its tail carrying `... 45 53 53 E7`:

```json
{"setRs232Rules":[
  {"name":"PRODUCTION_OK",      "rx":"A0 03 00 07 53 55 43 43 45 53 53 E7", "tx":"A1 03 00 02 4F 4B A4", "event":"vendSuccess"},
  {"name":"PRODUCTION_OK_TAIL", "rx":"* 45 53 53 E7",                       "tx":"A1 03 00 02 4F 4B A4", "event":"vendSuccess"}
]}
```

Rules:

- **First match wins.** Put tail rules AFTER the exact rules, so a whole frame still hits its exact rule.
- **Use enough tail bytes to be unique.** A short tail like `* E7` can match other frames that happen to end the same way.
- **Price positions** (`priceHi`/`priceLo`, `amountStart`/`amountEnd`) work on tail rules too. As with trailing-`*`
  rules they are not checked at load time; they are bounds-checked against each frame, and a position outside the
  frame extracts no price.
- The head piece of a split frame still logs as UNMATCHED. That is expected.
- Rule tables without a leading `*` behave exactly as before; the dashboard and `getRs232Rules` show the `*` as sent.

Code: `Rs232Lib` pattern parser and matcher. Docs updated: `API-REFERENCE.md` (rule fields), `LIBRARY_README.md`,
`docs/rs232-guide.html`, `docs/mdb-library-manual.html`, `docs/machine-setup-template.html`.

## Since 8.0.0 - 8.2.2 / mqtt-lib 2.8.0 (22 October)

- Your own `cancelVend()` is no longer echoed as `onVendFailure` (reason CANCELLED_BY_APP is still recorded).
- mqtt-lib 2.8.0: only coded items on the backend's `logs` topic; plain and control lines on `devices/<id>/ops` (D-0554).
- `vendStats` counters, including stuck VendListener callbacks.
- RS232 Loyalsuns protocol v2: PRODUCTION_OK / PRODUCTION_FAIL rules ACK the making result.

## Since 8.0.0 - 8.2.1 / mqtt-lib 2.7.1 (15 October)

- Every exchange reaches the backend exactly once (D-0961).
- Health check that can never get stuck; `currentState` = reported state, `busState` = real.
- SESSION COMPLETE / VEND CANCEL / SUCCESS / FAILURE answered in every state.

## Since 8.0.0 - 8.2.0 and 8.1.0 (October)

- 8.2.0 force session end after vend (`setForceSessionEnd:on|off`).
- 8.1.0 RS232 rules carry `"event"` and fire the same VendListener; ready-feedback gate on several inputs; direct vend
  reports ENABLED_STATE.

## Verify after deploy (dashboard passthrough)

| send | expect |
|---|---|
| `version` | `[remote] mqtt-lib 2.8.0, hardware-lib 8.2.3 - client id D-xxxx-..., sessions=1 ...` (arrives on the ops channel) |
| `setSessionCancelRetry:on` | `[remote] session-cancel retry ON - ... after 1000 ms ...`; `SETTINGS_JSON` with `"sessionCancelRetryMs":1000`; the **Cancel Retry** toggle turns on |
| sales on D-1637 for a while, then `vendStats` | `sessionCancelRetries` > 0 where the machine ignored a request, no 20-30 s stalls after VEND CANCEL in the log, `sessionCancelGaveUp` = 0 |
| `{"setRs232Rules":[{"name":"TAIL","rx":"* 53 E7","tx":""}]}` | `[rs232] 1 rule(s) loaded` |
| `rs232Simulate:45 53 53 E7` | the frame matched rule `TAIL` (code 137) |
| `rs232Simulate:53 E7 00` | UNMATCHED (code 138) - the tail must be the frame's last bytes |
| `{"setRs232Rules":[{"name":"BAD","rx":"* A0 *","tx":""}]}` | rejected: `rule BAD: rx is not valid hex/??/* tokens` |
| afterwards | send the machine's real rule table again - the test tables above replace it |

## Known limits

- Not yet run on a real CM30. Compiled only; neither the session-cancel retry nor the leading-`*` matcher has an
  automated test.
- The retry assumes the machine eventually answers a repeated request, as D-1637 did. If it never answers, the reader
  gives up after 3 retries and the session stays open exactly as on 8.2.2; the reader never sends END SESSION on its
  own (the spec only allows it as the answer to SESSION COMPLETE).
- `simulateExchange` does not drive the state machine, so the retry cannot be exercised without a machine.
- A tail rule cannot see the head piece: it fires on the tail alone.
- Everything listed for 8.2.2 still holds (Ready FB control single-channel on the dashboard, Force End on VEND SUCCESS
  only, no RS232 approve/deny command, `simulateExchange` drives the log pipeline only).
