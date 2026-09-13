# RS232 + MDB Log Schema — backend integration spec

Schema id: `"RS232"` · codes **137–143** (continue the MDB schema 110–136, no collisions)
Emitted by: hardware-lib 7.19.0 + mqtt-lib 2.2.0+ (mqtt-lib 2.3.0+ wires it automatically)

## MDB codes — unified at 110–136 (mqtt-lib 2.4.0)

Since **mqtt-lib 2.4.0**, MDB log envelopes (`"s":"MDB"`) carry message codes **110–136** —
the SAME numbers as the command/exchange table, so one code space covers everything:
MDB 110–136, RS232 137–143. The backend `MdbLogSchema` enum keyed 110–136 works as-is
(110 EXCHANGE, 111 RESET, 113 SETUP CONFIG [3 params], 121 VEND REQUEST [4 params:
rx, tx, price, item — THE money event], 124 VEND SUCCESS [3 params], 132 CASH SALE
[4 params], 133 idle POLL, 135 OTHER PERIPHERAL, 136 UNHANDLED). Severity: 136 UNHANDLED
and 125 VEND FAILURE arrive with `k:"e"`; 133 POLL and 135 OTHER PERIPHERAL with `k:"d"`.

Builds on mqtt-lib <= 2.3.0 emitted codes 0–26 for the same MDB events. `getCodebook`
always returns exactly the codes the running build emits — build decode tables from it
and version skew becomes a non-issue.

## Transport

Devices publish to:

- `devices/{deviceCode}/logs` — one envelope per message
- `devices/{deviceCode}/logs/bulk` — JSON array of the same envelopes, oldest first

## Envelope (same as MDB)

```json
{
  "t": "2026-09-13T10:19:23.101426Z",
  "s": "RS232",
  "m": "137",
  "a": "vending-app",
  "v": "1.0.231-uat",
  "k": "i",
  "d": 1,
  "p": ["PAYMENT_REQUEST", "A0 01 00 06 31 35 30 30 30 30 A3", "-", "150000"]
}
```

| Key | Meaning |
|---|---|
| t | timestamp |
| s | schema — `"RS232"` for these events |
| m | message code, string — see table below |
| a / v | emitting app name + version |
| k | severity: `i` info, `e` error, `d` debug |
| d | 1 = buffered, 2 = instant |
| p | positional params, meaning per code |

## Codes

| Code | Event | p[] params | Meaning |
|---|---|---|---|
| 137 | RS232_RX_MATCHED | `[ruleName, rxHex, txHex or "-", price or "-1"]` | Received frame matched a rule. txHex = auto-reply sent ("-" = rule has no reply). price = extracted amount in MINOR UNITS ("-1" = rule extracts no price). **A payment event is code 137 with price >= 0.** |
| 138 | RS232_RX_UNMATCHED | `[rxHex]` | Frame matched no rule — nothing replied. |
| 139 | RS232_CRC_DISCARDED | `[rxHex, expectedCrc]` | Frame failed XOR-CRC validation, dropped (no reply, no listeners). |
| 140 | RS232_TX | `[txHex]` | Manual/remote transmit (sendHex / sendXorFrame / sendXorAscii / dashboard). Rule auto-replies are NOT duplicated here — they live inside 137. |
| 141 | RS232_PORT_OPEN | `[portParams, ruleCount]` | Serial port opened, e.g. `["9600,8,1,N", "6"]`. |
| 142 | RS232_PORT_CLOSED | `[]` | Serial port closed. |
| 143 | RS232_RULES_LOADED | `[ruleCount]` | New rule table loaded/persisted. |

## Self-serving decode dictionary

Publish `getCodebook` to `devices/{code}/passthrough`; the device answers on `/logs`:

```
CODEBOOK_JSON:{"MDB":{...0-26...},"RS232":{"137":{"eventName":"RS232_RX_MATCHED","template":"...","paramCount":4}, ...},"INFO":{...}}
```

Render sentences via the `template` with `{0}..{n}` substitution — no hardcoded tables, no drift
between backend and device build.

## Real wire examples

```json
{"s":"RS232","m":"137","p":["HEARTBEAT","A0 06 00 02 48 42 AE","A1 06 00 02 4F 4B A1","-1"]}
{"s":"RS232","m":"137","p":["PAYMENT_REQUEST","A0 01 00 06 31 35 30 30 30 30 A3","-","150000"]}
{"s":"RS232","m":"139","p":["A0 01 00 03 30 30 36 99","94"]}
{"s":"RS232","m":"141","p":["9600,8,1,N","6"]}
{"s":"RS232","m":"143","p":["6"]}
```

## Drop-in Kotlin enum (matches the MdbLogSchema style)

Templates verbatim from the device library (`RabbahLogEvent.kt`) — renders identical text to
what `getCodebook` serves. Route on the envelope's `s` field first: `"MDB"` -> MdbLogSchema,
`"RS232"` -> this enum.

```kotlin
enum class Rs232LogSchema(
    val messageCode: String,
    val template: String,
    val paramCount: Int
) {
    RS232_RX_MATCHED(
        messageCode = "137",
        // {0}=ruleName {1}=rxHex {2}=txHex or "-" {3}=price minor units or "-1"
        // THE MONEY EVENT: payment = this code with {3} != "-1" ("150000" = 1500.00)
        template = "RS232 {0} rx={1} tx={2} price={3}",
        paramCount = 4
    ),
    RS232_RX_UNMATCHED(
        messageCode = "138",
        // {0}=rxHex - matched no rule, nothing replied (arrives with k:"e")
        template = "RS232 UNMATCHED rx={0}",
        paramCount = 1
    ),
    RS232_CRC_DISCARDED(
        messageCode = "139",
        // {0}=rxHex {1}=expected CRC - frame dropped (arrives with k:"e")
        template = "RS232 CRC FAIL rx={0} expected={1} - discarded",
        paramCount = 2
    ),
    RS232_TX(
        messageCode = "140",
        // {0}=txHex - manual/remote transmit only; rule auto-replies ride RX_MATCHED's {2}
        template = "RS232 TX {0}",
        paramCount = 1
    ),
    RS232_PORT_OPEN(
        messageCode = "141",
        // {0}=port params e.g. "baud=9600 8N1"  {1}=active rule count
        template = "RS232 port open {0}, {1} rule(s) active",
        paramCount = 2
    ),
    RS232_PORT_CLOSED(
        messageCode = "142",
        template = "RS232 port closed",
        paramCount = 0
    ),
    RS232_RULES_LOADED(
        messageCode = "143",
        // {0}=rule count
        template = "RS232 {0} rule(s) loaded",
        paramCount = 1
    );
}
```

## Backend heuristics

- **Money**: code 137 with `p[3] != "-1"` → amount = `parseInt(p[3])` minor units (150000 = 1500.00).
- **Line health**: rising 139 count = noise/wiring/CRC problem on the serial line.
- **Coverage gap**: 138 = machine sent a frame the rule table doesn't cover — capture `p[0]` for analysis.
- **Session bracketing**: 141/142 bracket a port session; 143 marks rule-table changes.
