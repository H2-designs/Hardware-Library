# Implementation guide - putting hardware-lib into the Android app

hardware-lib 8.2.7 + mqtt-lib 2.8.0, 27 October 2026. This is the one document to follow when wiring the libraries
into a payment app for the CM30 terminal, for MDB, RS232 and pulse machines. The companion files go deeper:
`API-REFERENCE.md` (every function), `AAR-HANDOFF-README.md` (what changed per release), `PULSE-README.md`,
`DUPLICATE-LOGS-README.md`, `VENDLISTENER-README.md` (the listener in full, with the fixes and the counters), `SESSION-ENDED-README.md`, `CANCEL-FLOW-README.md` (machine / app / operator cancel side by side), `samples/`.

## 1. What the library does, and what stays in the app

The library is the reader on the vending machine's bus. It does the whole protocol by itself: handshake, session,
vend request, approve or deny, dispense result, session close, resets, and every machine deviation we have met in
the field (persisted settings, never app code). It talks to the backend and the dashboard over mqtt-lib.

The app does three things and nothing else:

1. starts the libraries once at boot;
2. implements the three-callback `VendListener`: authorize the card on a vend request, capture on success, void or
   reverse on failure;
3. calls `approveVend()` or `cancelVend()` with the result of the authorization.

Everything else (which MDB level, session mode, direct vend, force session end, hex payloads, RS232 rules, pulse
polarity) is a per-machine setting that an operator sets from the dashboard or the backend, and the library
persists it on the device.

## 2. Files and Gradle

Copy the three AARs from `AAR-Update-latest.zip` into the app's `libs/`:

```gradle
implementation files('libs/mqtt-lib-2.8.0.aar')
implementation files('libs/hardware-lib-8.2.7.aar')
implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
```

- `minSdk` 30 (the CM30 runs Android 11), ABI armeabi-v7a.
- No ProGuard rules in the app: both AARs ship their own consumer keep rules.
- The broker password goes into `local.properties` and reaches the app through `BuildConfig` (see
  `source/MdbSlaveApp/app/build.gradle` for the four `buildConfigField` lines). Never in source, never in git.

## 3. Startup, once per process

Put this in the `Application` class (or a singleton called from it), never in an Activity. Listeners are process-wide.

```kotlin
class PaymentApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val deviceId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID).takeLast(6).uppercase()

        // 1. transport (optional - everything below works without it, logs just stay on the device)
        MqttLib.init(MqttConfig(
            topicPrefix = "devices", deviceId = deviceId,
            brokerHost = BuildConfig.MQTT_HOST, brokerPort = BuildConfig.MQTT_PORT,
            username = BuildConfig.MQTT_USERNAME.ifEmpty { null }, password = BuildConfig.MQTT_PASSWORD.ifEmpty { null },
            logTopicSuffix = "logs", commandTopicSuffix = "cmd", statusTopicSuffix = "status"
        ))
        MqttLib.start()

        // 2. the ONE bridge between the libraries - idempotent, never add your own forwarder next to it
        HardwareLib.attachRabbahMqtt()

        // 3. the engine: persistence first, then the payment hook, then the bus
        HardwareLib.init(applicationContext)
        HardwareLib.vendListener = PaymentFlow          // section 4
        HardwareLib.addStateListener(PaymentFlow::onState)
        HardwareLib.start()
    }
}
```

Order matters in one place: `init` publishes the first settings snapshot through the bridge, so attach before init.
`HardwareLib.init` is also what loads the persisted settings and payloads; an app that skips it runs with defaults
and forgets every operator setting at the next restart.

Without MQTT: drop steps 1 and 2. Nothing throws, the MDB engine runs fully offline.

## 4. The payment flow - `VendListener`

Three callbacks, and that is the whole listener. Since 8.2.6 they run on one ordered thread: for a vend, onVendRequest
completes before its outcome arrives. Return at once and do gateway work on your own coroutine or thread; a blocking
handler delays the outcome, and a callback running longer than 3 s logs a warning.

```kotlin
object PaymentFlow : HardwareLib.VendListener {
    private val scope = CoroutineScope(Dispatchers.IO)
    @Volatile private var approved = false      // did WE approve the vend that is open now

    override fun onVendRequest(amount: Double, minorUnits: Int, itemNumber: Int) {
        approved = false
        ui.showPaying(amount)
        scope.launch {
            val hold = gateway.authorize(minorUnits)          // exact integer minor units - never the Double
            if (hold != null) {
                approved = HardwareLib.approveVend()            // false = the machine already cancelled / timed out
                if (!approved) gateway.voidHold(hold)
            } else {
                ui.resetToIdle()
                HardwareLib.cancelVend()                        // onVendFailure(CANCELLED_BY_APP) follows (8.2.5); nothing left to do there
            }
        }
    }

    override fun onVendSuccess(itemNumber: Int) {               // product came out
        scope.launch { gateway.capture(); ui.showThanks() }
    }

    override fun onVendFailure(reason: HardwareLib.VendFailureReason) {   // 8.2.6: reason comes with the callback
        scope.launch {
            when (reason) {
                HardwareLib.VendFailureReason.CANCELLED_BY_VMC,        // the MACHINE cancelled: VEND CANCEL 13 01 / READER CANCEL 14 02
                HardwareLib.VendFailureReason.CANCELLED_BY_OPERATOR -> // the DASHBOARD cancelled (8.2.5)
                    if (approved) gateway.reverse() else gateway.voidHold()
                HardwareLib.VendFailureReason.CANCELLED_BY_APP -> {}   // our own cancelVend(): the decline was handled where we called it
                HardwareLib.VendFailureReason.FAILED ->                // VEND FAILURE after approval: product NOT dispensed
                    gateway.reverse()
                HardwareLib.VendFailureReason.SESSION_ENDED,           // machine closed the session with the vend open
                HardwareLib.VendFailureReason.RESET ->                 // bus RESET / stop() with the vend open
                    if (approved) gateway.reverse() else gateway.voidHold()
                null -> gateway.voidHold()
            }
            approved = false
            ui.resetToIdle()
        }
    }

    fun onState(state: String) { ui.showReader(state) }          // section 5
}
```

The contract the code above relies on:

- `onVendRequest` carries `minorUnits` (exact integer, use it for money) and `amount` (decimal, display only).
  Scale factor and decimals from READER CONFIG DATA are already applied. `itemNumber` is -1 when the machine sent
  none (always on RS232).
- Every VEND REQUEST the machine ends is reported exactly once, as `onVendSuccess` or `onVendFailure`.
- **Every cancel is delivered (8.2.5):** the machine's as CANCELLED_BY_VMC, your own `cancelVend()` as
  CANCELLED_BY_APP, a dashboard or remote cancel as CANCELLED_BY_OPERATOR. The reason tells you whether the money
  needs anything; the UI reset is the same for all. `CANCEL-FLOW-README.md` has the full table.
- **Reversal rule:** reverse the charge whenever you had approved and the vend did not reach `onVendSuccess`. That
  is three reasons, not one: FAILED, SESSION_ENDED and RESET. A handler that reverses only on FAILED leaks money
  on machines that close the session without any VEND FAILURE, and on resets mid-vend.
- Take the reason as the `onVendFailure(reason)` parameter (8.2.6). `lastVendFailureReason` still exists but is a global
  slot the next failure overwrites.

## 5. State, and a health check that cannot get stuck

The reader state is `INACTIVE_STATE`, `DISABLED_STATE`, `ENABLED_STATE`, `VEND_STATE`. The app shows it, nothing
more. Three guarantees since 8.2.1 make a "wait for ENABLED" screen safe:

- a state listener registered at any time receives the current state immediately;
- with direct vend ON the listener reports ENABLED_STATE while the bus is still INACTIVE or DISABLED, re-announces
  it on every real transition and re-sends it every 5 s until the bus is really enabled;
- `HardwareLib.currentState` returns the same reported state; `busState` is the real one.

```kotlin
fun waitForReader(onReady: () -> Unit) {
    if (HardwareLib.currentState == "ENABLED_STATE" || HardwareLib.currentState == "VEND_STATE") { onReady(); return }
    val l: (String) -> Unit = { s -> if (s == "ENABLED_STATE" || s == "VEND_STATE") onReady() }
    HardwareLib.addStateListener(l)        // replays the current state at once; remove with the SAME reference
}
```

## 6. Approve and cancel - the two calls

| call | when | returns false when | what the listener sees |
|---|---|---|---|
| `approveVend()` | after the gateway authorized | no VEND REQUEST is pending (machine cancelled or timed out first) | later `onVendSuccess`, or `onVendFailure` (FAILED / SESSION_ENDED / RESET) |
| `cancelVend()` | gateway declined, or you want to abort the session | no session live | `onVendFailure` with CANCELLED_BY_APP if a vend was open (8.2.5); the deny goes out on the next POLL |
| `cancelVend(VEND_DENIED)` / `cancelVend(SESSION_CANCEL_REQUEST)` | same, choosing the wire reply this once | same | nothing |
| `beginSession()` | manual session mode only, the "card tap" | not in ENABLED | - |

Always log the Boolean. `approveVend()` returning false means the money must be voided, because the machine will
never dispense.

## 7. Settings per machine

Set from the dashboard or the backend; the app may set them too, through the same functions. All persisted,
all echoed in `SETTINGS_JSON` after `getSettings`.

| backend key | function | remote command | SETTINGS_JSON |
|---|---|---|---|
| `auto_session` | `setAutoSession(Boolean)` | `setSessionMode:auto|manual` | `sessionBeginMode` |
| `auto_begin_cooldown` | `setAutoBeginCooldown(0..50)` | `setAutoBeginCooldown:N` | `autoBeginCooldownPolls` |
| `feature_level` (number 1..3) | `setMdbLevel(n)` | `setMdbLevel:N` | `mdbLevel` |
| `vmc_cancel_mode` | `setCancelMode(VEND_DENIED / SESSION_CANCEL_REQUEST)` | `setCancelMode:vendDenied|sessionCancel` | `vmcCancelMode` |
| `mdb_direct_vend` | `setDirectVend(Boolean)` | `setDirectVend:on|off` | `directVend` |
| `mdb_force_session_end` | `setForceSessionEnd(Boolean)` | `setForceSessionEnd:on|off` | `forceSessionEndAfterVend` |
| none yet (8.2.3) | `setSessionCancelRetry(ms)` / `setSessionCancelRetry(Boolean)` | `setSessionCancelRetry:on|off|MS` | `sessionCancelRetryMs` |
| `mdb_skip_zero_vend` | `setSkipZeroVend(Boolean)` | `setSkipZeroVend:on|off` | `skipZeroVend` |
| `mdb_session_cancel_retry_ms` (0 = off) | `setSessionCancelRetry(ms)` | `setSessionCancelRetry:MS` | `sessionCancelRetryMs` |
| `mdb_session_cancel_retry_count` (1..10) | `setSessionCancelRetry(ms, count)` | `setSessionCancelRetry:MS,COUNT` | `sessionCancelRetryCount` |
| `mdb_cancel_grace_window_ms` (0 = off, default 200) | `setCancelGrace(window, delay)` | `setCancelGrace:WINDOW,DELAY` | `cancelGraceWindowMs` |
| `mdb_cancel_grace_delay_ms` (0 = off, default 350) | same call | same command | `cancelGraceDelayMs` |
| `mdb_mqtt_logging` | `setMqttLogging(Boolean)` | `setMqttLogging:on|off` | `mqttLogsEnabled` |
| `nearpay_ui_dismiss` | app-side only | - | - |
| `reader_config_info_l3` etc. | `setConfigHex(name, hex)` | `{"setConfig":{"NAME":"hex"}}` | `CONFIG_JSON` |

What the switches mean in the field:

- **Direct vend ON** for machines that send VEND REQUEST without a session (log shows `rx=13 00 ... tx=UNHANDLED`
  with it off). The request is accepted in any state.
- **Force session end ON** for machines that never send SESSION COMPLETE after a sale: the reader sends SESSION
  CANCEL REQUEST after every VEND SUCCESS.
- **Session-cancel retry ON** (8.2.3) for machines that sometimes ignore a SESSION CANCEL REQUEST (log shows
  `tx=SESSION CANCEL REQUEST` and then nothing for 20-30 s until the machine sends VEND CANCEL again): the reader
  re-sends it after 1000 ms without SESSION COMPLETE, up to 3 times. Works with Force End and with the VEND CANCEL
  reply alike. Machines that answer never see a retry.
- **Skip 00 00 vend ON** (8.2.4) for machines that keep sending VEND REQUEST with price `00 00` until the customer
  selects an item (log shows `VEND REQUEST ... price=0` over and over, the app sees a 0.00 sale each time): those
  requests are ACKed and dropped, and only the request with the real price reaches `onVendRequest`.
- **Auto session** for machines that expect the reader to open the session; **cooldown** for machines (Sielaff)
  that send READER ENABLE after their first POLL.
- **Always idle** is not a setting: it is bit 5 of the last byte of `READER_CONFIG_INFO_L3` (`20`), Level 3 only,
  and the backend must turn auto session off with it.

Hex payloads have locked lengths (READER_CONFIG_INFO 30 bytes, READER_CONFIG_INFO_L3 34, SESSION_BEGIN 1..35).
A wrong length is rejected with an error line, never truncated.

## 8. RS232 machines

Same `VendListener`, same approve-or-decline decision, different wire: the machine sends serial frames, a rule
table answers them. The app never parses bytes.

```kotlin
Rs232Lib.setRulesJson(RULES)            // once; persisted and hot-reloaded. Also from the dashboard: {"setRs232Rules":[...]}
Rs232Lib.setCrcCheck(true)              // XOR protocols only
Rs232Lib.open(baud = 9600)              // 8-N-1 defaults; the ONLY thing in the app that touches the port
```

Rules that carry `"event"` fire the VendListener exactly like MDB. The table for the Loyalsuns coffee machine
(protocol v2, making result must be ACKed):

```json
[
 {"name":"CONNECT",         "rx":"A0 04 00 03 43 4F 4E E5",  "tx":"A1 05 00 02 4F 4B A2"},
 {"name":"HEARTBEAT",       "rx":"A0 06 00 02 48 42 ??",     "tx":"A1 06 00 02 4F 4B A1"},
 {"name":"PAYMENT_REQUEST", "rx":"A0 01 *", "tx":"", "amountStart":4, "amountEnd":-1, "event":"vendRequest"},
 {"name":"PAYMENT_TYPED",   "rx":"A0 06 *", "tx":"", "amountStart":5, "amountEnd":-1, "event":"vendRequest"},
 {"name":"PRODUCTION_OK",   "rx":"A0 03 00 07 53 55 43 43 45 53 53 E7", "tx":"A1 03 00 02 4F 4B A4", "event":"vendSuccess"},
 {"name":"PRODUCTION_FAIL", "rx":"A0 03 00 06 46 41 49 4C 45 44 A6",    "tx":"A1 03 00 02 4F 4B A4", "event":"vendFailure"},
 {"name":"CANCEL",          "rx":"A0 08 00 06 43 41 4E 43 45 4C A8",    "tx":"", "event":"vendCancel"}
]
```

The one difference from MDB: there is no `approveVend()` on RS232. The app answers the machine with bytes after
the authorization, inside `onVendRequest`:

```kotlin
override fun onVendRequest(amount: Double, minorUnits: Int, itemNumber: Int) {
    scope.launch {
        val ok = gateway.authorize(minorUnits) != null
        Rs232Lib.sendXorAscii("A1 02", if (ok) "SUCCESS" else "FAILED")
    }
}
```

Then PRODUCTION_OK arrives as `onVendSuccess`, PRODUCTION_FAIL as `onVendFailure` (FAILED, reverse), CANCEL as
`onVendFailure` (CANCELLED_BY_VMC, void). Rule fields, patterns (`??`, trailing `*`, leading `*` for a frame's tail), price extraction
(`amountStart/End` for ASCII, `priceHi/Lo` for binary) and the port commands are in `API-REFERENCE.md` section 2.
For a new machine, send the vendor protocol document; the rule table is the whole integration.

## 9. Pulse machines

Credit is paid as coin pulses on a digital output. Set polarity once, then one blocking call per sale, never on the
UI thread. Optional ready gate on the digital inputs. Full guide with a complete sample: `PULSE-README.md` and
`samples/PulsePaymentSample.kt`.

```kotlin
PulseLib.initPulse(highPulse = true)                   // persisted, re-driven at every start
PulseLib.setReadyFeedbackChannels(mapOf(0 to 1))       // optional gate: input 0 must read 1
withContext(Dispatchers.IO) {
    val sent = PulseLib.sendPulse(widthMs = 50, periodMs = 100, count = pulses)   // true only if every pulse went out
    if (sent) gateway.capture() else gateway.voidHold()
}
```

## 10. Logging rules that keep the backend clean

- Register every listener once per process. Keep a lambda in a field and remove it with the same reference if a
  screen must listen. The library ignores a repeat registration of the same instance, but a new lambda is a new
  instance.
- One `attachRabbahMqtt()`, no custom bridge next to it. Two publishers mean every exchange twice on the backend
  (`DUPLICATE-LOGS-README.md`).
- A local log view must skip lines with `showOnScreen == false` (per-poll noise) and must be capped; redrawing a
  growing TextView on every POLL froze the app on real hardware.
- Do not enqueue log lines to MQTT yourself; the bridge already does. Since mqtt-lib 2.8.0 only coded items reach the
  backend's `logs` topic; plain lines and control lines travel on `devices/<id>/ops` for the dashboard.

## 11. Test without a machine, then verify on the bus

On the device, with no machine attached:

```
HardwareLib.simulateExchange("10 10")        // a fake RESET through the whole pipeline -> code 111 on the dashboard
Rs232Lib.simulateFrame("A0 01 00 06 31 35 30 30 30 30 A3")   // a fake payment request -> onVendRequest(1500.00)
```

From the dashboard passthrough bar after deploy:

| send | expect |
|---|---|
| `version` | `[remote] mqtt-lib 2.8.0, hardware-lib 8.2.3 - client id ...` |
| `getSettings` | `SETTINGS_JSON` with every key in section 7 |
| `status` | `VMC_STATUS` with `state` and `busState` |
| one real sale | each exchange once on the backend, one `onVendSuccess` in the app |
| `mqttStats` | link badge green |
| `vendStats` | `[vend stats] requests=.. successes=.. failures=.. STUCK callbacks=0 .. listener registered` |

## 12. Troubleshooting

| what you see | cause | fix |
|---|---|---|
| `rx=13 00 ... tx=UNHANDLED` | machine sends VEND REQUEST without a session, direct vend off | `setDirectVend:on` |
| health check waits forever for ENABLED | app registered its listener after the event, old library | 8.2.1+ replays and heartbeats; see section 5 |
| `approveVend IGNORED - no VEND REQUEST pending` | the machine cancelled or timed out before the gateway answered | void the hold; speed up the gateway or raise the machine's timeout |
| `cancelVend IGNORED - no session live` | nothing to cancel | nothing |
| onVendFailure after your own cancel shows an error screen | the handler treats CANCELLED_BY_APP like a machine cancel | branch on the reason: CANCELLED_BY_APP = UI reset only (8.2.5) |
| session never closes after a sale | machine sends no SESSION COMPLETE | `setForceSessionEnd:on` |
| `tx=SESSION CANCEL REQUEST`, then silence for 20-30 s until VEND CANCEL again | machine sometimes ignores the request | `setSessionCancelRetry:on` |
| `VEND REQUEST ... price=0` repeating, `onVendRequest(0.0, 0, ..)` in the app | machine sends 00 00 until an item is selected | `setSkipZeroVend:on` |
| every line 2x or 4x on the backend | second publisher in the app | one attach, delete the app bridge |
| every line 10x on the device screen | listener registered per Activity | register once, remove with the same reference |
| `[rs232] ... UNMATCHED` | frame not in the rule table, or CRC check on with a non-XOR protocol | add the rule; `rs232Crc:off` |
| `sendPulse` returns false | polarity not set, gate not ready, bad width/period | `initPulse` first; `checkMachineReady`; period > width |

## 13. React Native apps

The same libraries ship inside `react-native-mdb` (package 1.3.x): `Mdb.initMqtt`, `Mdb.initMdb`, `Mdb.startMdb`,
events `onVendRequest` / `onVendSuccess` / `onVendFailure({ reason })`, `Mdb.approveVend()` / `Mdb.cancelVend()`.
Every rule above holds unchanged; the bridge registers its listeners once. Manual: `docs/mdb-reactnative-manual.html`.

## 14. Before the field

- [ ] AARs 8.2.7 / 2.8.0 / 1.0.9 in `libs/`, `version` answers with them
- [ ] `HardwareLib.init(applicationContext)` at boot, in every mode
- [ ] one `attachRabbahMqtt()`, no custom bridge, listeners registered once
- [ ] `onVendFailure` reverses on FAILED, SESSION_ENDED and RESET when approved, voids on CANCELLED_BY_VMC / CANCELLED_BY_OPERATOR, only resets the UI on CANCELLED_BY_APP
- [ ] `approveVend()` / `cancelVend()` return values logged
- [ ] gateway work off the callback thread
- [ ] machine settings applied and echoed in `SETTINGS_JSON`
- [ ] one real sale: each exchange once on the backend

Nothing since 8.1.0 has run on a real CM30. First field checks: duplicates gone, direct-vend health check, a reader
restart mid-session, the force-end machine, the no-echo cancel.
