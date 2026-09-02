# RS232 real-machine test plan

Machine: coffee machine ⇄ CM30 as card reader, serial cable.
App: **rs232-sample-v1.4.apk** ("RS232 Test"). Library: hardware-lib 7.13.0.

## Setup (2 minutes)

1. Install `rs232-sample-v1.4.apk` on the CM30 and open **RS232 Test**.
2. Tap **LOAD RULES** — the correct rule table for this machine is already pre-filled
   (7 rules: CONNECT, HEARTBEAT, PAYMENT_REQUEST, PAYMENT_TYPED, PRODUCTION_OK,
   PRODUCTION_FAIL, CANCEL). Status line must say `rules: 7/20`.
3. Leave **CRC check: off** (important — see "known issue" below).
4. Baud is pre-filled 9600 → tap **OPEN PORT**. Log must show
   `[rs232] port open - baud=9600 8N1, 7 rule(s) active`.
   - If it shows `open failed`, screenshot the line and send it — that means the CM30
     vendor serial API needs different parameters, nothing else will work until this line.
5. Connect the serial cable to the machine.

## What should happen, in order

| Machine does | Log on CM30 shows | Sent back automatically |
|---|---|---|
| powers up / connects | `rx=A0 04 00 03 43 4F 4E E5 matched=CONNECT` | `A1 05 00 02 4F 4B A2` (Device Ready) |
| every ~30 s | `rx=A0 06 00 02 48 42 .. matched=HEARTBEAT` | `A1 06 00 02 4F 4B D3` (Heartbeat OK) |
| customer starts a vend | `matched=PAYMENT_REQUEST price=999` + `>> VEND REQUEST price=999` | `SUCCESS` frame (bench table auto-approves) |
| makes the coffee | `matched=PRODUCTION_OK` (or `PRODUCTION_FAIL`) | nothing (per protocol) |
| cancels | `matched=CANCEL` | nothing |

Success = machine stays online (heartbeats answered), a vend runs end-to-end,
and the coffee is made. The bench table approves every payment without charging —
that is intentional for this test.

## If something is off — what to record

- **`UNMATCHED (no rule)` lines** → screenshot them. The machine sends a frame the
  documents didn't list; the hex in the log is exactly what we need to add a rule.
- **Machine says reader offline / keeps reconnecting** → heartbeat reply not accepted.
  Note the exact heartbeat rx line — especially its LAST byte (the doc claims `A4`,
  the XOR math says `AE`; whichever the machine really sends decides the CRC question).
- **Frames look glued together or cut in half** (one log line holding two frames, or
  half a frame) → the 20 ms silence framing needs tuning. Fixable remotely.
- **Wrong amount** → screenshot the `price=` line plus what the machine display said.
- Buttons for manual poking: **SIMULATE RX** (test a rule without the machine),
  **SEND HEX** (raw bytes), **BUILD + SEND FRAME** (header + ASCII → auto length + CRC).

## Known issue to verify: heartbeat CRC

The vendor doc's heartbeat CRCs (`A4` ping / `D3` reply) do not match the XOR rule
every other frame follows. The rule table works either way (`??` on the CRC byte),
but **keep CRC check OFF** until the log shows what the machine really sends.
Turning it on with `A4` heartbeats would silently kill the connection.

## After the bench test passes

Production wiring (in the real app, not the test app): payment rules get `tx:""`,
the app charges in `vendRequestListener`, then sends
`Rs232Lib.sendXorAscii("A1 02", "SUCCESS")` or `"FAILED"`. Full code and the rule
table: `docs/rs232-guide.html` (or the RS232 Card Reader Guide artifact).
Everything is remote-controllable over MQTT: `{"setRs232Rules":[...]}`,
`rs232Open`, `rs232Crc:on|off`, `rs232Simulate:HEX`, `rs232SendAscii:A1 02;SUCCESS`.
