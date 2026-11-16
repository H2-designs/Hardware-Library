# Release notes - hardware-lib 8.2.15 + react-native-mdb 1.5.0 (mqtt-lib 2.8.0 unchanged)

Release: https://github.com/RabbahSystems/hardware-library/releases/tag/v8.2.15 (and https://github.com/H2-designs/Hardware-Library/releases/tag/v8.2.15)
Date: 16 November 2026. Replaces v8.2.14 (5 November). Cumulative against the fleet's hardware-lib 8.0.0 / mqtt-lib 2.6.0.

## TL;DR for the Android app

- Swap `hardware-lib-8.2.14.aar` for `hardware-lib-8.2.15.aar`; mqtt-lib stays 2.8.0. React Native apps take
  `react-native-mdb` 1.5.0. Rebuild. Nothing existing changes; everything below is additive.
- **"Is the machine ready?" is now a question you can ask any time, and an event you cannot miss.** Field report:
  the machine finished its handshake before the Android app registered its listeners, so the app never saw the
  machine become ready. The state listener replays at registration since 8.2.1, but an app whose own code (or JS
  side) subscribes later still waited for the *next* transition, and a quiet machine never makes one.
- New on hardware-lib: `isMachineReady`, `isMdbReady`, `isMdbHandshakeDone`, `machineReadyJson()`,
  `readyListener` / `addReadyListener((ready, json))` (replayed on registration, then edge-only), control line
  `MACHINE_READY:{...}`, remote `getMachineReady`.
- New on RS232: `Rs232Lib.isMachineReady` (port open and the machine has been heard), rule event `"connect"` for
  the handshake / heartbeat rules, `setReadyTimeout(ms)` / remote `rs232ReadyTimeout:MS` (readiness drops when the
  machine goes silent). The LoyalSuns sample rules tag CONNECT and HEARTBEAT with it.
- New on React Native 1.5.0: `getMachineReady()`, `onMachineReady(fn)`, `onStateChanged(fn)`. Both events deliver
  the **current** value right after subscribing - the native module re-emits it to every new JS subscriber.

## Files

| file | version |
|---|---|
| `libs/hardware-lib-8.2.15.aar` | 8.2.15 (fleet has 8.0.0) |
| `libs/mqtt-lib-2.8.0.aar` | 2.8.0, unchanged (fleet has 2.6.0) |
| `libs/CM30-HardwareLibrary-1.0.9.aar` | unchanged |
| `react-native-mdb` 1.5.0 | bundles hardware-lib 8.2.15; new JS: `getMachineReady`, `onMachineReady`, `onStateChanged` |
| dashboard | source change only: a `MACHINE_READY:` line renders as `[machine ready] YES · MDB ready (...) · RS232 ...`; the packaged v8.2.13 build shows it as a raw line until repackaged |
| `MDB-Slave-2-v2.30.0-build117-debug.apk` | demo/test app on 8.2.15 (private release only) |
| `rs232-sample-v2.2-build13-debug.apk` | RS232 test bench on 8.2.15: status line shows `machine: READY / not heard yet`, logs `>> MACHINE READY`, default CONNECT / HEARTBEAT rules tagged `connect` (no credentials, shareable) |
| `samples/loyalsuns-v2-rules.json` | CONNECT and HEARTBEAT now carry `"event":"connect"` |

```gradle
implementation files('libs/mqtt-lib-2.8.0.aar')
implementation files('libs/hardware-lib-8.2.15.aar')
implementation files('libs/CM30-HardwareLibrary-1.0.9.aar')
```

## What "ready" means

| transport | ready when | not ready when |
|---|---|---|
| MDB (`isMdbReady`) | the reader is running and the **reported** state is `ENABLED_STATE` or `VEND_STATE` - the same truth `currentState` tells, so direct vend ON counts as ready | before `start()`, after `stop()`, while the bus is INACTIVE (no handshake yet) or DISABLED (handshake done, READER DISABLE) |
| RS232 (`Rs232Lib.isMachineReady`) | the port is open **and** the machine has sent a frame that matched a rule tagged `"event":"connect"` - or, when no rule in the table is tagged, any rule at all | after `close()`, when the reader dies, and after `readyTimeoutMs` without a matched frame (0 = off, default) |
| `isMachineReady` | either of the two | neither |

`isMdbHandshakeDone` is the finer MDB fact: the VMC completed SETUP since `start()` (the real bus state left
INACTIVE). It stays true through READER DISABLE and goes false on RESET or `stop()`.

## The snapshot

`machineReadyJson()`, the `MACHINE_READY:` control line, remote `getMachineReady` and React Native
`getMachineReady()` all carry the same JSON:

```json
{"ready":true,
 "mdb":{"ready":true,"running":true,"handshake":true,"state":"ENABLED_STATE","busState":"ENABLED_STATE",
        "directVend":false,"recentActivity":true,"level":2},
 "rs232":{"ready":false,"open":false,"connected":false,"lastRule":null,"lastRxAgeMs":-1,"rules":12,
          "connectRules":2,"readyTimeoutMs":0},
 "at":1794824376204}
```

## The listener

```kotlin
HardwareLib.addReadyListener { ready, json ->
    // called ONCE right here with the current value - even if the machine was ready an hour ago -
    // then only when readiness flips. Not on heartbeats, not on idle POLLs, not on BEGIN / END SESSION.
    runOnUiThread { readyBadge.text = if (ready) "MACHINE READY" else "WAITING FOR MACHINE" }
}
```

What flips it: READER ENABLE -> true; READER DISABLE, RESET, `stop()` -> false; direct vend switched on while the
bus is INACTIVE / DISABLED -> true. RS232: the first connect-tagged (or first matched) frame after `open()` -> true;
`close()`, reader failure, ready timeout -> false. Every flip also logs
`[ready] machine READY - mdb ENABLED_STATE (mdb=true rs232=false)` and ships `MACHINE_READY:{...}`.

Delivery thread: the one that saw the change (the MDB offload thread, the RS232 reader thread, or the caller's
thread for the registration replay). Return fast; hop to your own thread for UI work. The `var` slot
`readyListener` replays too; the `add` list never deduplicates, so register once per process.

## React Native 1.5.0

```ts
const ready = await Mdb.getMachineReady();       // { ready, mdb: {...}, rs232: {...}, at }
const sub = Mdb.onMachineReady((e) => setReady(e.ready));   // fires at once with the current value, then on change
const sub2 = Mdb.onStateChanged((e) => setState(e.state));  // likewise replays the current state (new in 1.5.0)
```

RN calls the native module's `addListener(eventName)` for every JS subscription; the module now answers
`MdbMachineReady` and `MdbStateChanged` by re-emitting the current value to that subscriber. The emit arrives after
the JS subscription exists (the native call is asynchronous). Handling the same value twice is harmless: it is the
same payload `getMachineReady()` / `getCurrentState()` return. The pulse `isMachineReady()` is a different thing
(the digital-in ready-feedback gate) and is unchanged.

## RS232 rule event `connect`

```json
{"name":"CONNECT",   "rx":"A0 04 00 03 43 4F 4E E5", "tx":"A1 05 00 02 4F 4B A2", "event":"connect"},
{"name":"HEARTBEAT", "rx":"A0 06 00 02 48 42 ??",    "tx":"A1 06 00 02 4F 4B A1", "event":"connect"}
```

A connect-tagged match marks the machine as heard and fires no VendListener callback. Tag the heartbeat too, so a
machine that reconnects without a fresh CON frame still counts, and so `rs232ReadyTimeout:15000` (for a 10 s
heartbeat, say) can drop readiness when the heartbeat stops and raise it on the next one. Every matched frame
refreshes the timeout, whichever rule it hits. Unknown `event` values are still rejected with the full list.

## Remote commands (dashboard passthrough bar or backend `cmd` topic)

| command | effect |
|---|---|
| `getMachineReady` (or `isMachineReady`) | ships `MACHINE_READY:{...}` and one `[remote] machine ready: YES (mdb=true rs232=false)` line |
| `rs232ReadyTimeout:MS` / `rs232ReadyTimeout:off` | sets the RS232 ready timeout (0-600000 ms, persisted) |

A control-plane listener that registers late now receives `MACHINE_READY` next to `VMC_STATUS` and `SETTINGS_JSON`,
so the dashboard sees one `[machine ready] ...` line when the device's bridge starts.

## Tests

Bus-trace harness (`source/MdbSlaveApp/hardware-lib/bus-trace/`): **31 scenarios, all pass on 8.2.15** (28 existing,
unchanged). New in `extra/BusTraceExtra7.java`:

- S29 - MDB readiness through a full life cycle: false before `start()` and through RESET / SETUP (DISABLED), true at
  READER ENABLE, still true in VEND_STATE, false at READER DISABLE (handshake flag stays true), true again, false on
  RESET (handshake false), true after the re-handshake, false after `stop()`; the snapshot checked at each step.
- S30 - the listener: the machine completes its handshake **before** anything is registered; `addReadyListener` gets
  exactly one `onReady(true)` at once; idle POLLs, session open and END SESSION produce no call; READER DISABLE /
  ENABLE produce exactly one call each; the `MACHINE_READY` control line ships on every change; a removed listener is
  silent; the `readyListener` var slot replays on assignment.
- S31 - RS232 half on the JVM (no port): a HEARTBEAT that is not connect-tagged does not mark the machine as heard
  while a connect rule exists, the CONNECT frame does; with the port closed `ready` stays false; `setReadyTimeout`
  range checks; an unknown event value is rejected with a message that lists `connect`.

Not yet run on a real CM30 or a LoyalSuns machine.

## Everything from 8.2.14 and earlier still applies

CASH SALE ACKed (8.2.14), warm resume (8.2.13), the review fixes (8.2.12), vend event gap (8.2.11), cancel grace
(8.2.7 / 8.2.10), stale-approve protection (8.2.8 / 8.2.9), `onVendFailure(reason)` (8.2.5 / 8.2.6), `vendStats`
(8.2.2), direct vend and replay-on-registration (8.2.1). No `MdbCmd` code changed; the MQTT payloads of existing
lines are byte-identical; the only new line on the wire is `MACHINE_READY:{...}`.
