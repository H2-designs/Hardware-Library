# MDB communication with the VMC, byte by byte, and every configuration file

hardware-lib 8.2.15, 16 November 2026. This document is the **wire-level** reference: what the vending machine
controller (VMC) sends, what the reader answers, every byte of every frame, the handshake per feature level, every
session and vend sequence with real checksums, the timing rules, and then every file and store that configures the
reader (payload bytes, settings, RS232 rules, backend keys, build-time properties, the dashboard and the setup
template). `MDB-README.md` is the overview, `LISTENERS-README.md` explains how frames become app callbacks,
`API-REFERENCE.md` lists the functions.

Everything here is taken from `MdbSlaveWrapper.kt` (bytes and checksum), `HardwareLib.kt` (the state machine),
`MdbConfigStore.kt` (payloads), `MdbSettings.kt` (settings) and `Rs232Lib.kt` (rules).

---

## 1. The bus in one page

| fact | value |
|---|---|
| roles | the VMC is the master and talks first; the reader (hardware-lib on the CM30) only answers |
| our address | Cashless Device #1, `0x10`. Frames for other peripherals (first byte outside `10`-`17`) are ignored |
| physical layer | 9600 baud, 9-bit (mode bit marks the address byte); handled entirely by the vendor `libmdbSlave.so`; the library sees plain bytes |
| block size | at most 36 bytes on the wire: up to 35 data bytes plus the checksum |
| checksum (CHK) | 8-bit sum of all preceding bytes, carry discarded, appended as the last byte. Not a CRC. Example from the spec: `11 01 05 DC 00 64` sums to `0x157`, CHK `57` |
| ACK | a single bare byte `00` sent through `sendAnswer(0x00)`; no CHK. NAK / RET likewise |
| what the library receives | the full frame including the VMC's CHK, e.g. `13 05 00 FA 00 00 12`: `13+05+FA = 0x112` so CHK `12`. A bare POLL is `12 12`, a RESET `10 10` |
| what the library sends | ACK as the bare byte, or a payload from `MdbConfigStore` plus a CHK computed in `withChecksum()` at send time |
| reply window | a few milliseconds. The bytes go out before anything is logged or formatted; the log line is produced afterwards on another thread |
| vend decision window | the reader declares a 232 s max response time, so the VMC keeps polling while the app takes the payment |

### 1.1 Command bytes

The first byte is the address plus the command, the second byte (where present) the subcommand.

| first byte | command | subcommands |
|---|---|---|
| `10` | RESET | - |
| `11` | SETUP | `00` CONFIG DATA, `01` MAX/MIN PRICES |
| `12` | POLL | - |
| `13` | VEND | `00` REQUEST, `01` CANCEL, `02` SUCCESS, `03` FAILURE, `04` SESSION COMPLETE, `05` CASH SALE |
| `14` | READER | `00` DISABLE, `01` ENABLE, `02` CANCEL |
| `15` | REVALUE | `00` REQUEST, `01` LIMIT REQUEST |
| `17` | EXPANSION | `00` REQUEST ID, `04` ENABLE OPTIONS, others logged as EXPANSION (code 134) |

### 1.2 Reply codes the reader can put on a POLL

| code | reply | payload after the code |
|---|---|---|
| `00` | JUST RESET | - |
| `01` | READER CONFIG DATA | 7 bytes (section 3.1) |
| `03` | BEGIN SESSION | 2 bytes at Level 1, 9 bytes at Level 2/3 (section 3.3) |
| `04` | SESSION CANCEL REQUEST | - |
| `05` | VEND APPROVED | price hi, price lo |
| `06` | VEND DENIED | - |
| `07` | END SESSION | - |
| `08` | CANCELLED | - (reply to READER CANCEL) |
| `09` | PERIPHERAL ID | 29 bytes at Level 2, 33 at Level 3 (section 3.2) |
| `0E` | REVALUE DENIED | - |
| `0F` | REVALUE LIMIT AMOUNT | limit hi, limit lo |

## 2. Every VMC command: bytes in, bytes out

`CHK` is always the last byte. Prices and items are 16-bit big-endian. Item numbers are `-1` in the callback when
the VMC omits them.

| VMC sends | frame layout | reader answers | notes |
|---|---|---|---|
| RESET | `10 CHK` | ACK; state INACTIVE; JUST RESET announced on the next POLLs | any state. Open vend closed with `onVendFailure(RESET)`; every armed flag dropped |
| POLL | `12 CHK` | whatever is armed, else ACK | section 4 lists the priority |
| SETUP CONFIG DATA | `11 00 <VMC level> <display columns> <display rows> <display info> CHK` | READER CONFIG DATA (`01` + 7 bytes + CHK) | INACTIVE and DISABLED (retries). Example `11 00 03 10 02 01 27`: Level 3 VMC, 16 x 2 display |
| SETUP MAX/MIN PRICES | `11 01 <max hi> <max lo> <min hi> <min lo> CHK` | ACK | INACTIVE (Level 1: ends setup, DISABLED) and DISABLED (retry). Example `11 01 02 3F 00 64 B7`: max 575, min 100 |
| EXPANSION REQUEST ID | `17 00 <manufacturer 3 ASCII> <serial 12 ASCII> <model 12 ASCII> <software 2 BCD> CHK` | PERIPHERAL ID (`09` + 29 or 33 bytes + CHK) | Level 2 and 3. Level 2: ends setup, DISABLED. Level 3: stays INACTIVE |
| EXPANSION ENABLE OPTIONS | `17 04 <option bytes 4> CHK` | ACK | Level 3 only: ends setup, DISABLED. The option bits are not stored; the reader declares none in its Peripheral ID |
| READER ENABLE | `14 01 15` | ACK | DISABLED -> ENABLED (auto mode arms BEGIN SESSION). ENABLED: re-arms. VEND_STATE: ACK only. INACTIVE: ACK + ENABLED with warm resume (8.2.13), ACK only with direct vend, otherwise UNHANDLED |
| READER DISABLE | `14 00 14` | ACK | ENABLED -> DISABLED. VEND_STATE: END SESSION on the next POLL, open vend -> `onVendFailure(SESSION_ENDED)` |
| READER CANCEL | `14 02 16` | CANCELLED `08 08` | DISABLED, ENABLED, VEND_STATE (then the cancel-mode reply on the next POLL and `onVendFailure(CANCELLED_BY_VMC)`); INACTIVE only with direct vend |
| VEND REQUEST | `13 00 <price hi> <price lo> <item hi> <item lo> CHK` | ACK | VEND_STATE; or any state with direct vend; or ENABLED with Always Idle declared. Example `13 00 01 86 00 33 CD`: price 390, item 51. Price `00 00` dropped when skip-zero is on |
| VEND CANCEL | `13 01 14` | ACK, then SESSION CANCEL REQUEST or VEND DENIED on the next POLL | VEND_STATE. Outside a session: ACK only, logged as stray |
| VEND SUCCESS | `13 02 <item hi> <item lo> CHK` | ACK | VEND_STATE: `onVendSuccess`. Example `13 02 00 33 48`. Force End ON: SESSION CANCEL REQUEST armed |
| VEND FAILURE | `13 03 16` | ACK | VEND_STATE: `onVendFailure(FAILED)` |
| VEND SESSION COMPLETE | `13 04 17` | ACK, then END SESSION on the next POLL | any state; outside a session the END SESSION still goes out and the state does not change |
| CASH SALE | `13 05 <price hi> <price lo> <item hi> <item lo> CHK` | ACK | any state (8.2.14), logged with price and item, no callback. Example `13 05 00 FA 00 00 12`: 250 cash, item 0 |
| REVALUE REQUEST | `15 00 <amount hi> <amount lo> CHK` | REVALUE DENIED `0E 0E` | VEND_STATE, Level 2+ |
| REVALUE LIMIT REQUEST | `15 01 16` | REVALUE LIMIT AMOUNT `0F FF FF 0D` | VEND_STATE, Level 2+ |
| anything else | | no reply, logged UNHANDLED (code 136) when unhandled visibility is on | |

## 3. Every reply payload, byte by byte

The 13 payloads live in `MdbConfigStore`. The defaults below are what ships; section 7.1 says how to change them.
Bytes marked **runtime** are overwritten at send time, so editing them in the store has no effect.

### 3.1 READER CONFIG DATA (8 bytes, reply to SETUP CONFIG)

Default `01 02 19 78 01 02 E8 0B`, sent as `01 <level> 19 78 01 02 E8 0E CHK`.

| byte | default | meaning |
|---|---|---|
| 0 | `01` | reply code |
| 1 | `02` | feature level, **runtime** = the `mdbLevel` setting (1, 2 or 3) |
| 2-3 | `19 78` | country / currency code, ISO 4217 numeric with a leading 1: `1978` = 978 = EUR. For Saudi riyal (682) set `16 82` |
| 4 | `01` | scale factor; prices on the bus are multiplied by it |
| 5 | `02` | decimal places; with scale 1 and 2 decimals, raw 350 = 3.50 |
| 6 | `E8` | application maximum response time, seconds: 232 |
| 7 | `0B` | miscellaneous options, **runtime** = `0E`: bit 1 multi-vend, bit 2 reader has a display, bit 3 reports cash sales, bit 0 (refunds to the media) clear |

Bytes 4 and 5 are also what `priceToAmount` and `priceToMinorUnits` use, so the app and the VMC always agree on the
scale. The wire CHK for the default at Level 2 is `8D` (Level 1 `8C`, Level 3 `8E`).

### 3.2 PERIPHERAL ID (30 bytes at Level 2, 34 at Level 3, reply to EXPANSION REQUEST ID)

`READER_CONFIG_INFO` default:
`09 43 41 53 30 30 30 30 30 30 30 30 30 30 30 31 30 30 30 30 30 30 30 30 30 30 30 31 00 01`, CHK `63`.

| bytes | default | meaning |
|---|---|---|
| 0 | `09` | reply code |
| 1-3 | `43 41 53` | manufacturer code, ASCII `CAS` |
| 4-15 | `30 x11 31` | serial number, ASCII `000000000001` |
| 16-27 | `30 x11 31` | model number, ASCII `000000000001` |
| 28-29 | `00 01` | software version, BCD 00.01 |
| 30-33 (L3 only) | `00 00 00 00` | optional feature bits Z31-Z34, MSB first. All zero = no optional feature claimed. Bit 5 of byte 33 (Z34) = **Always Idle**; the engine reads it live |

`READER_CONFIG_INFO_L3` is the same with the four feature bytes appended; the two are stored separately so switching
levels never loses either.

### 3.3 BEGIN SESSION (reply on a POLL when a session is armed)

| name | default | bytes | wire | used at |
|---|---|---|---|---|
| `SESSION_BEGIN` | `03 FF FF` | 1-35 editable | `03 FF FF 01` | Level 1 |
| `SESSION_BEGIN_L2` | `03 FF FF 00 00 00 01 00 00 00` | 1-35 editable | `03 FF FF 00 00 00 01 00 00 00 02` | Level 2 and 3 |

Layout of the long form: `03` code, `FF FF` funds available (`FFFF` = unknown / unlimited), `00 00 00 01` payment
media id, `00` payment type, `00 00` payment data. If the bus shows more bytes than `03 FF FF` after BEGIN SESSION,
the level is 2 or 3 and the long payload is being sent; edit it or set the level to 1.

### 3.4 Single-code replies and the vend replies

| name | default | wire | runtime bytes |
|---|---|---|---|
| `JUST_RESET` | `00` | `00 00` | - |
| `CAN` (CANCELLED) | `08` | `08 08` | - |
| `SESSION_CANCEL` (SESSION CANCEL REQUEST) | `04` | `04 04` | - |
| `VEND_APPROVED` | `05 00 00` | e.g. `05 01 86 8C` | bytes 1-2 = the requested price |
| `VEND_DENIED` | `06` | `06 06` | - |
| `END_SESSION` | `07` | `07 07` | - |
| `REVALUE_LIMIT` (REVALUE LIMIT AMOUNT) | `0F FF FF` | `0F FF FF 0D` | - (sent as configured) |
| `REVALUE_DENIED` | `0E` | `0E 0E` | - |

## 4. What a POLL gets, in priority order

In VEND_STATE the reader answers the POLL with the first of these that is armed:

1. END SESSION (`endSessionPending`): state -> ENABLED, every flag cleared, auto mode re-arms BEGIN SESSION after
   the cooldown, open vend -> `onVendFailure(SESSION_ENDED)`.
2. SESSION CANCEL REQUEST or VEND DENIED (`sessionCancelPending`, per `pendingCancelResponse`); the retry timer is
   armed for SESSION CANCEL REQUEST.
3. VEND APPROVED at the requested price (`vendApprovePending && vendRequestReceived`).
4. a due SESSION CANCEL REQUEST retry.
5. ACK (idle).

In ENABLED_STATE: BEGIN SESSION when armed (auto mode after READER ENABLE or after the cooldown, manual mode after
`beginSession()`), else ACK. In INACTIVE: JUST RESET on up to 5 POLLs after a RESET, then ACK. A stray END SESSION
(after a SESSION COMPLETE outside a session) is answered in any state without changing it.

## 5. Sequences with real bytes

Every frame below includes its CHK. `->` is VMC to reader, `<-` reader to VMC.

### 5.1 Power-up handshake, Level 1

```
-> 10 10                        RESET                     <- ACK            state INACTIVE
-> 12 12                        POLL                      <- 00 00          JUST RESET (up to 5 times)
-> 11 00 01 10 02 01 25         SETUP CONFIG (L1 VMC)     <- 01 01 19 78 01 02 E8 0E 8C   READER CONFIG DATA
-> 11 01 02 3F 00 64 B7         SETUP MAX/MIN 575 / 100   <- ACK            state DISABLED
-> 14 01 15                     READER ENABLE             <- ACK            state ENABLED, BEGIN SESSION armed (auto)
-> 12 12                        POLL                      <- 03 FF FF 01    BEGIN SESSION, state VEND_STATE
```

### 5.2 Power-up handshake, Level 2 (default)

```
-> 10 10                                      <- ACK                       INACTIVE
-> 12 12                                      <- 00 00                     JUST RESET
-> 11 00 02 10 02 01 26                       <- 01 02 19 78 01 02 E8 0E 8D
-> 11 01 02 3F 00 64 B7                       <- ACK                       still INACTIVE
-> 17 00 <29 bytes of VMC id> CHK             <- 09 43 41 53 30 ... 31 00 01 63   PERIPHERAL ID, state DISABLED
-> 14 01 15                                   <- ACK                       ENABLED
-> 12 12                                      <- 03 FF FF 00 00 00 01 00 00 00 02   BEGIN SESSION, VEND_STATE
```

### 5.3 Power-up handshake, Level 3

Same as Level 2 with `01 03 … 8E` as the config data, the 34-byte Peripheral ID (`09 … 00 01 00 00 00 00 63`), and
one more step before DISABLED:

```
-> 17 04 <4 option bytes> CHK                 <- ACK                       state DISABLED
```

### 5.4 A paid vend

```
-> 12 12                        POLL                 <- 03 FF FF 00 00 00 01 00 00 00 02   BEGIN SESSION
-> 13 00 01 86 00 33 CD         VEND REQUEST 390/51  <- ACK                 onVendRequest(3.90, 390, 51)
-> 12 12 (repeating)            POLL                 <- ACK                 the app is at the gateway
                                                                            app: approveVend()
-> 12 12                        POLL                 <- 05 01 86 8C         VEND APPROVED 390
   (the machine dispenses)
-> 13 02 00 33 48               VEND SUCCESS item 51 <- ACK                 onVendSuccess(51)
-> 13 04 17                     SESSION COMPLETE     <- ACK
-> 12 12                        POLL                 <- 07 07               END SESSION, state ENABLED
-> 12 12 x3                     POLL                 <- ACK                 auto-begin cooldown
-> 12 12                        POLL                 <- 03 FF FF …          next session
```

### 5.5 The machine cancels (customer pressed cancel), cancel mode SESSION CANCEL REQUEST

```
-> 13 00 01 86 00 33 CD         VEND REQUEST         <- ACK                 onVendRequest
-> 13 01 14                     VEND CANCEL          <- ACK                 onVendFailure(CANCELLED_BY_VMC)
-> 12 12                        POLL                 <- 04 04               SESSION CANCEL REQUEST
-> 13 04 17                     SESSION COMPLETE     <- ACK
-> 12 12                        POLL                 <- 07 07               END SESSION
```

With cancel mode VEND DENIED the POLL gets `06 06` instead and the session stays open for another request.

### 5.6 The app declines

```
-> 13 00 …                      VEND REQUEST         <- ACK                 onVendRequest
                                                                            app: cancelVend()  -> onVendFailure(CANCELLED_BY_APP)
-> 12 12                        POLL                 <- 04 04 (or 06 06)
```

### 5.7 Dispense failure after approval

```
-> 12 12                        POLL                 <- 05 01 86 8C         VEND APPROVED
-> 13 03 16                     VEND FAILURE         <- ACK                 onVendFailure(FAILED): refund
-> 13 04 17 / 12 12             SESSION COMPLETE     <- ACK / 07 07
```

### 5.8 Force session end (machines that never send SESSION COMPLETE)

```
-> 13 02 00 33 48               VEND SUCCESS         <- ACK                 onVendSuccess; SESSION CANCEL REQUEST armed
-> 12 12                        POLL                 <- 04 04
-> 13 04 17                     SESSION COMPLETE     <- ACK
-> 12 12                        POLL                 <- 07 07
```

If the machine ignores the `04 04`, the session-cancel retry re-sends it after the wait (default 1000 ms), up to
the count (default 3), then logs a warning and stops.

### 5.9 Reader cancel from the machine, session end with the vend open, reset mid-vend

```
-> 14 02 16   READER CANCEL in VEND_STATE   <- 08 08   CANCELLED; onVendFailure(CANCELLED_BY_VMC); cancel reply next POLL
-> 14 00 14   READER DISABLE in VEND_STATE  <- ACK     next POLL 07 07 END SESSION; onVendFailure(SESSION_ENDED) if open
-> 10 10      RESET in VEND_STATE           <- ACK     INACTIVE; onVendFailure(RESET); JUST RESET on the next POLLs
```

### 5.10 Warm resume (the reader restarted, the machine did not)

```
-> 14 01 15   READER ENABLE in INACTIVE, no RESET since start()   <- ACK   state ENABLED (8.2.13), BEGIN SESSION armed
-> 12 12                                                           <- 03 FF FF …
```

Before 8.2.13 this was UNHANDLED and the machine repeated `14 01` every ~150 ms forever.

### 5.11 Direct vend and Always Idle

With direct vend ON, or at Level 3 with bit 5 of Z34 set, a VEND REQUEST arrives without BEGIN SESSION:

```
-> 13 00 01 86 00 33 CD   VEND REQUEST in ENABLED (or any state with direct vend)   <- ACK   state VEND_STATE, onVendRequest
-> 12 12                  POLL after approveVend()                                   <- 05 01 86 8C
```

### 5.12 Cash sale and revalue

```
-> 13 05 00 FA 00 00 12   CASH SALE 250, item 0   <- ACK            any state, logged, vendStats cashSales
-> 15 00 00 64 79         REVALUE REQUEST 100     <- 0E 0E          REVALUE DENIED
-> 15 01 16               REVALUE LIMIT REQUEST   <- 0F FF FF 0D    REVALUE LIMIT AMOUNT
```

## 6. Timing rules

| rule | value | where |
|---|---|---|
| reply window per frame | a few ms; send first, log later | `MdbSlaveWrapper.sendAndLog` |
| receive loop while idle | ~1000 reads per second, zero allocation on empty reads | `receiveCommand()` |
| JUST RESET announcements | up to 5 POLLs after RESET, stopped early by the first answered setup command | `JUST_RESET_REPEAT_COUNT` |
| auto-begin cooldown | 3 idle POLLs after END SESSION before BEGIN SESSION is re-armed (0-50) | `autoBeginCooldownPolls` |
| vend decision | up to 232 s, declared in READER CONFIG DATA byte 6 | the VMC's timer |
| session-cancel retry | 1000 ms wait (300-10000), 3 tries (1-10), off by default | `sessionCancelRetryMs/Count` |
| bus activity | `recentActivity` true while a frame arrived in the last 5 s | `VMC_ACTIVITY_TIMEOUT_MS` |
| warm resume READER ENABLE | observed every ~150 ms from the VMC until ACKed | field log |
| callback timing (app side) | cancel grace 200 / 500 ms, event gap 500 ms, watchdog 3 s | `LISTENERS-README.md` |

## 7. Every configuration file and store

### 7.1 Reply payloads: `mdb_config`

Android SharedPreferences, file `/data/data/<app package>/shared_prefs/mdb_config.xml`, one string per payload
name, value = space-separated hex. A name that is absent, unparsable or of the wrong length falls back to the
library default at `init()`. Lengths are locked except `SESSION_BEGIN` and `SESSION_BEGIN_L2` (1-35 bytes). The
checksum is never stored; it is computed at send time.

Ways to read and change it (all equivalent, all live on the next send, all persisted):

| how | read | write | reset |
|---|---|---|---|
| Kotlin | `getConfigHex(name)`, `configSnapshotJson()`, `configNames()` | `setConfigHex(name, hex)` -> `null` or an error sentence | `resetConfig(name)` |
| remote, plain | `getConfig` -> `CONFIG_JSON:{"JUST_RESET":"00", …}` | `setConfig:NAME:hex` | `resetConfig:NAME` |
| remote, JSON | `{"getConfig":true}` | `{"setConfig":{"NAME":"hex", …}}` | `{"resetConfig":["NAME", …]}` |
| dashboard | Config panel shows every name with its current bytes | edit and Apply (sends the JSON form) | Reset per name |
| backend | - | machine setting `reader_config_info_l3` etc., applied by the app through `setConfigHex` | - |

Hex input is tolerant: spaces, commas and `0x` prefixes are stripped. Every outcome is answered with a
`[remote] NAME updated -> …` or `[remote] setConfig NAME failed: …` line, and a fresh `CONFIG_JSON`.

A `CONFIG_JSON` snapshot with the defaults:

```json
{"JUST_RESET":"00","CAN":"08","READER_CONFIG_DATA":"01 02 19 78 01 02 E8 0B",
 "READER_CONFIG_INFO":"09 43 41 53 30 30 30 30 30 30 30 30 30 30 30 31 30 30 30 30 30 30 30 30 30 30 30 31 00 01",
 "READER_CONFIG_INFO_L3":"09 43 41 53 30 30 30 30 30 30 30 30 30 30 30 31 30 30 30 30 30 30 30 30 30 30 30 31 00 01 00 00 00 00",
 "VEND_APPROVED":"05 00 00","VEND_DENIED":"06","END_SESSION":"07","SESSION_CANCEL":"04",
 "SESSION_BEGIN":"03 FF FF","SESSION_BEGIN_L2":"03 FF FF 00 00 00 01 00 00 00",
 "REVALUE_LIMIT":"0F FF FF","REVALUE_DENIED":"0E"}
```

### 7.2 Settings: `mdb_settings`

SharedPreferences file `shared_prefs/mdb_settings.xml`. Without `init(context)` the same values live in memory only
and a warning is logged once. Every key is echoed in `SETTINGS_JSON`.

| key | type | default | set by |
|---|---|---|---|
| `sessionBeginMode` | string `auto` / `manual` | `auto` | `setAutoSession`, `setSessionMode:` |
| `autoBeginCooldownPolls` | int 0-50 | 3 | `setAutoBeginCooldown` |
| `mdbLevel` | int 1-3 | 2 | `setMdbLevel` |
| `vmcCancelMode` | string `sessionCancel` / `vendDenied` | `sessionCancel` | `setCancelMode` |
| `directVend` | bool | false | `setDirectVend` |
| `forceSessionEndAfterVend` | bool | false | `setForceSessionEnd` |
| `sessionCancelRetryMs` | int 0 or 300-10000 | 0 | `setSessionCancelRetry` |
| `sessionCancelRetryCount` | int 1-10 | 3 | `setSessionCancelRetry(ms, count)` |
| `cancelGraceWindowMs` | int 0-5000 | 200 | `setCancelGrace` |
| `cancelGraceDelayMs` | int 0-5000 | 500 | `setCancelGrace` |
| `cancelGraceDefaultsV` | int (migration marker) | 2 | the library: a stored 350 from 8.2.7-8.2.9 is raised to 500 once |
| `vendEventGapMs` | int 0-5000 | 500 | `setVendEventGap` |
| `warmResume` | bool | true | `setWarmResume` |
| `skipZeroVend` | bool | false | `setSkipZeroVend` |
| `mqttLogsEnabled` | bool | false | `setMqttLogging` |
| `showPollTraffic` | bool | false | `setPollVisibility` |
| `showUnhandledCmd` | bool | false | `setUnhandledVisibility` |
| `showOtherPeripheral` | bool | false | `setPeripheralVisibility` |
| `showEmptySessions` | bool | false | `setEmptySessionVisibility` |
| `pulseMode` | string `unset` / `high` / `low` | `unset` | `PulseLib.initPulse` |
| `readyFeedbackEnabled` | bool | false | `PulseLib.setReadyFeedback` |
| `readyFeedbackValue` | int | 1 | same |
| `readyFeedbackChannel` | int | 0 | same |
| `readyFeedbackChannels` | string `ch=val,ch=val` | empty | `PulseLib.setReadyFeedbackChannels` |

### 7.3 RS232 rules: `rs232_rules`

SharedPreferences file `shared_prefs/rs232_rules.xml`: `rulesJson` (the rule array as loaded) and `crcCheck`
(bool, default false). Restored by `init()`. The frame gap (`frameGapMs`, default 1000, remote `rs232Gap:MS`) is
not persisted. At most 20 rules; first match wins.

One rule:

| field | meaning |
|---|---|
| `name` | label used in the log and the coded event |
| `rx` | space-separated hex to match; `??` = any one byte; trailing `*` = any remaining bytes (since 7.10.0); leading `*` = match the end of the frame (8.2.3) |
| `tx` | hex to send back; `""` = match, report and fire the event, send nothing |
| `priceHi`, `priceLo` | byte indexes of a binary price (hi*256 + lo); negative counts from the end, -1 = last byte |
| `amountStart`, `amountEnd` | start (inclusive) and end (exclusive) indexes of an ASCII digit price; `amountEnd: -1` skips a trailing CRC byte |
| `event` | `vendRequest` (needs a price), `vendSuccess`, `vendFailure`, `vendCancel`: drives the same VendListener as MDB |

Loaded with `{"setRs232Rules":[…]}` (dashboard RS232 panel, backend or `Rs232Lib.setRulesJson`), read back with
`getRs232Rules` -> `RS232_RULES_JSON:[…]`, cleared with `clearRs232Rules`.

### 7.4 Sample rule file: `samples/loyalsuns-v2-rules.json`

```json
{"setRs232Rules":[
 {"name":"CONNECT",              "rx":"A0 04 00 03 43 4F 4E E5",                 "tx":"A1 05 00 02 4F 4B A2", "event":"connect"},
 {"name":"HEARTBEAT",            "rx":"A0 06 00 02 48 42 ??",                    "tx":"A1 06 00 02 4F 4B A1", "event":"connect"},
 {"name":"PAYMENT_REQUEST",      "rx":"A0 01 *", "tx":"", "amountStart":4, "amountEnd":-1, "event":"vendRequest"},
 {"name":"PAYMENT_TYPED",        "rx":"A0 06 *", "tx":"", "amountStart":5, "amountEnd":-1, "event":"vendRequest"},
 {"name":"PRODUCTION_OK",        "rx":"A0 03 00 07 53 55 43 43 45 53 53 E7 *",   "tx":"A1 03 00 02 4F 4B A4", "event":"vendSuccess"},
 {"name":"PRODUCTION_FAIL",      "rx":"A0 03 00 06 46 41 49 4C 45 44 A6 *",      "tx":"A1 03 00 02 4F 4B A4", "event":"vendFailure"},
 {"name":"CANCEL",               "rx":"A0 08 00 06 43 41 4E 43 45 4C A8",        "tx":"", "event":"vendCancel"},
 {"name":"PRODUCTION_OK_TAIL",   "rx":"* 53 55 43 43 45 53 53 E7",               "tx":"A1 03 00 02 4F 4B A4", "event":"vendSuccess"},
 {"name":"PRODUCTION_OK_TAIL2",  "rx":"* 53 E7",                                 "tx":"A1 03 00 02 4F 4B A4", "event":"vendSuccess"},
 {"name":"PRODUCTION_FAIL_TAIL", "rx":"* 46 41 49 4C 45 44 A6",                  "tx":"A1 03 00 02 4F 4B A4", "event":"vendFailure"},
 {"name":"PRODUCTION_FAIL_TAIL2","rx":"* 44 A6",                                 "tx":"A1 03 00 02 4F 4B A4", "event":"vendFailure"},
 {"name":"RESULT_HEAD",          "rx":"A0 03 *",                                 "tx":""}
]}
```

The `*` on PRODUCTION_OK / FAIL absorbs a heartbeat that the machine glues onto the result frame; the `_TAIL` rules
catch a result that arrives glued after another frame. The reader's own payment-result frames are
`A1 02 00 07 53 55 43 43 45 53 53 E7` (success) and `A1 02 00 06 46 41 49 4C 45 44 A6` (failed), XOR-checked.

### 7.5 Backend machine settings (keys the app applies at start)

| key | applied through |
|---|---|
| `auto_session` | `setAutoSession` |
| `auto_begin_cooldown` | `setAutoBeginCooldown` |
| `feature_level` | `setMdbLevel` |
| `vmc_cancel_mode` | `setCancelMode` |
| `mdb_direct_vend` | `setDirectVend` |
| `mdb_force_session_end` | `setForceSessionEnd` |
| `mdb_skip_zero_vend` | `setSkipZeroVend` |
| `mdb_session_cancel_retry_ms`, `mdb_session_cancel_retry_count` | `setSessionCancelRetry(ms, count)` |
| `mdb_cancel_grace_window_ms`, `mdb_cancel_grace_delay_ms` | `setCancelGrace` |
| `mdb_vend_event_gap_ms` | `setVendEventGap` |
| `mdb_warm_resume` | `setWarmResume` |
| `mdb_mqtt_logging` | `setMqttLogging` |
| `reader_config_info_l3` and the other payload names in lower case | `setConfigHex` |
| `nearpay_ui_dismiss` | app side only |

The same values can be pushed live on the `cmd` topic as the remote commands of section 7.2.

### 7.6 Build-time: `local.properties` (MdbSlaveApp root, git-ignored)

| key | used by |
|---|---|
| `sdk.dir` | Gradle, the Android SDK path |
| `mqttHost`, `mqttPort`, `mqttUsername`, `mqttPassword` | the demo app `app/build.gradle` copies them into `BuildConfig`; the demo APK therefore embeds the broker credentials and is published only on the private release |

hardware-lib itself reads nothing at build time. The sample apps (`rs232-sample`, `pulse-sample`) have no MQTT and
no credentials.

### 7.7 Dashboard

The Hardware Dashboard keeps its broker settings (F2: host, port, user, password, topic prefix, device) locally in
its Electron user-data folder and writes its log files to `<userData>/logs`. It sends everything above through the
`passthrough` topic and reads `logs` + `ops`. It has no configuration file of its own to ship with the library.

### 7.8 Machine setup template (`docs/machine-setup-template.html`)

The form an installer fills per machine: protocol (MDB / RS232 / pulse), feature level, cancel mode, pulse mode
(high / low), up to three ready-feedback channels (`rf0`-`rf2`, channel = expected value), and the RS232 rule table
(rule name, machine sends, we reply, price hi / lo, amount start / end, event). "What gets stored" lists the
backend keys of section 7.5 that the form produces. Fields for cancel grace, event gap and warm resume are not yet
on it; they keep their defaults unless set from the dashboard or the backend.

## 8. Reading a bus log

| log line | meaning | what to do |
|---|---|---|
| `POLL rx=12 12 tx=JUST RESET` repeating | the VMC never answers with SETUP; it may be addressing a different level or the reader is not at `0x10` | check the machine's cashless settings |
| `SETUP CONFIG rx=11 00 … tx=READER CONFIG DATA` repeating | the VMC rejects the config data | fix bytes 2-5 of READER_CONFIG_DATA for this machine's currency and decimals |
| `UNHANDLED rx=14 01` in a loop | reader restarted while the VMC stayed up, warm resume off | `setWarmResume:on` (default on since 8.2.13) |
| `UNHANDLED rx=13 05 …` | cash sale report before 8.2.14 | update the AAR |
| `UNHANDLED rx=17 0x` in ENABLED | expansion command outside setup | known gap, no effect on vends |
| `BEGIN SESSION tx=03 FF FF 00 00 00 01 00 00 00` on a machine that wants 3 bytes | Level 2/3 payload | edit `SESSION_BEGIN_L2` or set level 1 |
| `[app] approveVend IGNORED - a cancel reply is already armed` | the payment finished after the machine cancelled | void; the library refused on purpose |
| `[mdb] WARNING: no SESSION COMPLETE after 3 re-sent SESSION CANCEL REQUESTs` | the machine ignores cancel requests | switch cancel mode to VEND DENIED, or let the machine time out |
| `VEND SUCCESS with no vend open … onVendSuccess NOT fired` | success after a cancel or failure | nothing; the app already voided |
| `OTHER PERIPHERAL rx=…` (with peripheral visibility on) | bill validator, coin mech or another device on the same bus | nothing |
