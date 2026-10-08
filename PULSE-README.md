# Pulse machines - what the Android app has to do

hardware-lib 8.2.0, `PulseLib` (package `com.rabbah.mdb`). A pulse machine takes credit as coin pulses on one
digital output of the CM30, and may raise a digital input to say "ready for credit". The library drives every
edge itself on a dedicated high-priority thread, so the app never touches the IO directly.

Complete sample: [samples/PulsePaymentSample.kt](samples/PulsePaymentSample.kt) - app start, machine configuration from
the backend model, and a sale (ready check -> hold the card -> pulse -> capture or void).

## The four calls, in the order a machine is set up

### 1. Set the polarity once - `initPulse`

The machine's coin input expects pulses that go either HIGH (line idles LOW) or LOW (line idles HIGH). Nothing
pulses until this is set.

```kotlin
PulseLib.initPulse(true)    // HIGH pulses, line idles LOW
PulseLib.initPulse(false)   // LOW pulses, line idles HIGH
```

- Drives the idle level immediately. Returns `true` when the hardware accepted it.
- Persisted on the device as `pulseMode` (high / low / unset) and re-driven at every app start by
  `HardwareLib.init(context)`, so you call it once per machine, not at every boot. Calling it again is harmless.
- Which polarity a machine wants comes from your backend machine model (the dashboard calls it "Init High /
  Init Low"). Wrong polarity = the machine counts nothing.

### 2. Send credit - `sendPulse`

```kotlin
val ok = PulseLib.sendPulse(pulseWidthMs = 50, pulsePeriodMs = 100, count = 3)
```

- `width` = how long one pulse stays at the active level; `period` = time from the start of one pulse to the
  start of the next; `count` = how many pulses (your price-to-pulses rule decides this).
- **Blocks** for about `period x count` (plus any train already queued) and returns `true` only when every pulse
  physically went out. Call it from a coroutine or background thread, never the UI thread.
- Returns `false`, with a `[pulse] ...` log line saying why, when: polarity was never set; `width < 1`;
  `period < width`; `period == width` with `count > 1`; `count < 1`; the queue (100 trains) is full; the ready
  gate (step 3) says the machine is not ready; or the hardware errored mid-train.
- Charge the customer only after `sendPulse` returned `true`. A `false` means no credit reached the machine.

### 3. Ready feedback, optional - the gate

Some machines raise a digital input when they can accept credit. When the gate is armed, `sendPulse` reads the
input(s) first and refuses the train if the value is wrong. Off by default; persisted once armed.

One input:

```kotlin
PulseLib.setReadyFeedback(1, 0)        // input 0 must read 1 before any train
PulseLib.setReadyFeedback(null)        // gate off
// backend-model form: supported flag + value, exactly as the model carries them
PulseLib.setReadyFeedback(model.supportReadyFeedback, model.readyFeedbackValue, channel = 0)
```

Several inputs (8.1.0; the CM30 has three, 0..2):

```kotlin
PulseLib.setReadyFeedbackChannels(mapOf(0 to 1, 2 to 0))   // input 0 must read 1 AND input 2 must read 0
PulseLib.setReadyFeedbackChannels(emptyMap())              // gate off
```

`PulseLib.enableReadyFeedback()` re-arms whatever was last saved.

### 4. Check readiness yourself - `isMachineReady`

```kotlin
if (PulseLib.isMachineReady()) startPayment() else showMachineBusy()
```

Reads every gated input now and returns `true` only if all match (always `true` when the gate is off). Use it
before taking the card, so you never charge for a train the gate would then refuse. The log line lists what it
read: `[pulse] ready feedback in0 expected=1 actual=1, in2 expected=0 actual=1 ready=false`.

## State you can read

| property | meaning |
|---|---|
| `PulseLib.isInitialized` | polarity has been set this run |
| `PulseLib.isHighPulse` | current polarity |
| `PulseLib.pendingTrains` | trains waiting in the queue |
| `PulseLib.readyFeedbackChannels` | the armed gate, channel -> ready value (empty = off) |

`getSettings` / `HardwareLib.currentSettingsJson()` report `pulseMode`, `readyFeedbackEnabled`,
`readyFeedbackValue`, `readyFeedbackChannel` and `readyFeedbackChannels`.

## Rules that bite

- **Call `HardwareLib.init(context)` at app start**, also on pulse-only machines. Without it nothing above
  persists and the device forgets polarity and gate on every restart.
- **Never call `sendPulse` on the UI thread** - it waits for the train.
- **Set polarity before the first train**; `sendPulse` refuses otherwise ("call initPulse first").
- **Do not drive the digital IO yourself** anywhere else in the app. One owner, or the timing breaks.
- `vendorPulse(p1, p2, p3, p4)` is a raw passthrough to the vendor's own pulser, kept for experiments only - it
  produced the wrong count on real hardware. Do not use it in production.
- Without the CM30 runtime (emulator, other hardware) every call returns `false` and logs; nothing crashes.

## Remote equivalents (dashboard / backend, no app code)

| command | does |
|---|---|
| `initPulse:true` / `initPulse:false` | set polarity (dashboard: Init High / Init Low, mode label) |
| `sendPulse:50,100,3` | test train, runs detached, result as a `[pulse] sent ...` line |
| `setReadyFeedback:yes,1,0` / `setReadyFeedback:off` / `setReadyFeedback:on` | one-input gate / off / re-arm last saved |
| `setReadyFeedback:0=1,2=0` | multi-input gate (8.1.0) |
| `checkMachineReady` | run the gate check now |

The bench app `pulse-sample-v1.5.apk` puts all of this on buttons, so polarity, timing and the ready input can be
proven on the wiring before the real app is involved.

## React Native

Same calls, same rules: `Mdb.initPulse(true)`, `await Mdb.sendPulse(50, 100, 3)` (resolves when the train is
done), `Mdb.setReadyFeedback(value, channel)` or `Mdb.setReadyFeedback(supported, value)`, `Mdb.isMachineReady()`,
`Mdb.getPulseState()`. The multi-input gate is set with the remote command `setReadyFeedback:0=1,2=0` for now.
