# Why log lines were duplicated, and how 8.2.1 / 2.7.1 stops it

Hardware-Library, 15 October 2026. Applies to hardware-lib 8.2.1 + mqtt-lib 2.7.1 (release v8.2.1).
Companion to `AAR-HANDOFF-README.md` (sections "8.2.1 / mqtt-lib 2.7.1" and "Register listeners ONCE").

## 1. What was seen

Two different symptoms, same family of cause.

**Case A - on the device screen (8 October 2026).** Every exchange appeared once in the library's own words and
then ten more times in the app's own format:

```
SETUP CONFIG rx=11 00 03 10 02 00 26 tx=READER CONFIG DATA level=3
[V/113] 11 00 03 10 02 00 26 | READER CONFIG DATA | 3
[V/113] 11 00 03 10 02 00 26 | READER CONFIG DATA | 3
... (x10)
```

**Case B - on the backend (field case D-0961, 15 October 2026).** One sale produced VEND APPROVED four times within
20 ms, most other exchanges twice, and a stream of plain-text lines filed under `device.log.unknown_source` that
said the same thing as the coded items next to them.

The dashboard, which reads the same MQTT stream, showed each exchange once in case A and the copies in case B.
That difference is the first clue: case A was duplicated before MQTT (in the app's own log view), case B on the way
to MQTT.

## 2. How one exchange travels

```
VMC ──POLL──> MDB bus thread ──> engine answers ONCE ──> deliver(event)   (one call per exchange)
                                                              │
                 ┌────────────────────────────────────────────┼──────────────────────────────┐
                 │                                            │                              │
          logListener(s)                              exchangeListener(s)              controlListener(s)
          plain text line                             structured MdbExchangeEvent       SETTINGS_JSON / VMC_STATUS
          "VEND APPROVED rx=12 tx=VEND APPROVED"      code 122, params, sessionId       (not log lines)
                 │                                            │
         app's on-screen log                        a BRIDGE turns it into ONE coded RabbahLog item
                                                              │
                                                    RabbahLog.log(event, params)
                                                              │
                                                    MqttLib outbound queue ──> broker ──> backend
```

Three facts about this pipeline decide everything below:

1. The engine calls `deliver()` exactly once per exchange. It answers one POLL with one reply; it cannot produce
   two VEND APPROVED for one POLL. A duplicate is never the bus and never the engine.
2. Every listener feed is a list. `addExchangeListener`, `addLogListener`, `addStateListener`,
   `addControlListener`, `addRs232EventListener` and `MqttLib.addCommandListener` each hold a list, and
   `deliver()` calls every entry in the list. N entries = N copies of every event.
3. Whatever is registered as a bridge publishes to the backend. Two bridges = two wire items per exchange.

## 3. Root cause 1: the same listener registered many times (case A)

Before 8.2.1 the listener lists were plain `CopyOnWriteArrayList.add(...)`. Nothing deduplicated them and nothing
removed entries by itself. The fleet app registered its exchange listener from an Activity (`onCreate` /
`onResume`), so every screen rotation, every return from background and every Activity recreation added one more
entry with the same code. After ten recreations the list held ten entries, and `deliver()` faithfully called all ten.

Why the dashboard still showed one line: the library's own bridge (`attachRabbahMqtt()`) was guarded by a boolean
and registered once, so the MQTT stream carried one coded item per exchange. Only the app's own listener had
multiplied.

How to recognise it: the copies are in the app's format, not the library's; the count grows over the app's uptime
and resets on restart; the dashboard shows one line.

## 4. Root cause 2: two bridges publishing the same exchange (case B)

The sample `MdbMqttBridge.kt` was copied into the fleet app. It registered an exchange listener that turned every
`MdbExchangeEvent` into a coded `RabbahLog` item. Independently of that, `HardwareLib.attachRabbahMqtt()` also ran,
either from mqtt-lib's auto-attach on the first broker connection or from the dashboard's HW toggle
(`attachHardware`). Before 8.2.1 `attachRabbahMqtt()` forwarded exchanges as plain text log lines, not coded items,
which is where `device.log.unknown_source` came from: the same exchange, once as text from the library's bridge and
once as a coded item from the app's bridge.

Then root cause 1 multiplied it. The app's bridge was attached per Activity, so its listener sat in the list twice;
with the library bridge next to it one VEND APPROVED became four wire items inside the same `deliver()` loop. That is
why the four copies were 20 ms apart and not 50 or 100 ms: they were produced in one pass over one listener list,
not by the machine polling again. Real repeats on an MDB bus are at POLL cadence, 50 to 100 ms or more, and carry
different timestamps from the engine.

How to recognise it: copies on the backend as well as on the device; identical code, params and session id; spacing
of a few milliseconds; plain-text twins of coded items.

## 5. What 8.2.1 / 2.7.1 changed (three guards, all inside the libraries)

**Guard 1 - a listener instance can only be registered once.** Every `add*Listener` and `MqttLib.addCommandListener`
now uses `addIfAbsent` and returns `false` when that exact instance is already in the list. A bridge or Activity that
calls `attach()` on every recreation no longer stacks publishers. (A new lambda object on every call is still a new
instance; see section 6.)

**Guard 2 - `attachRabbahMqtt()` is the complete bridge, and the only one you need.** Since 8.2.1 it registers an
exchange forwarder that publishes each MDB exchange as ONE coded `RabbahLog` item (through reflection into mqtt-lib:
`MdbLogEvent.valueOf`, `RabbahLog.log`, `RabbahLog.setSessionId`), and it keeps the plain-text twin of that exchange
local: while `deliver()` is dispatching an exchange it sets a `deliveringExchange` flag, and the bridge's log-line
listener skips lines that arrive under that flag. Result: one coded item per exchange on the wire, no
`unknown_source` text twin, and nothing left for an app-side bridge to do. The sample `MdbMqttBridge` is now a
two-line wrapper: `attach() = HardwareLib.attachRabbahMqtt()`, `detach() = HardwareLib.detachRabbahMqtt()`.
`attachRabbahMqtt()` is idempotent (a boolean plus guard 1) and `detachRabbahMqtt()` removes exactly the listeners
attach registered, nothing else.

**Guard 3 - `RabbahLog` drops an exact duplicate within 30 ms (mqtt-lib 2.7.1).** The key is
`schemaCode | sessionId | params`. An item identical to the previous one that arrives within 30 ms is not
enqueued and `RabbahLog.dedupedItems` is incremented. This is a safety net for in-process fan-out only, which is why
the window is 30 ms and not wider: two identical exchanges 50 ms apart are real bus traffic (a VMC re-polling) and
the backend must see both. A rising `dedupedItems` counter after 8.2.1 means the app still wires a second publisher.

## 6. What the app must do (checklist for the Android engineer)

1. Swap both AARs: `hardware-lib-8.2.1.aar`, `mqtt-lib-2.7.1.aar`. No API change.
2. Delete any exchange or log forwarder the app has of its own. Keep exactly one call to
   `HardwareLib.attachRabbahMqtt()` (or `MdbMqttBridge.attach()`, same thing). Calling it again is harmless.
3. Never run `attachLogSink` and `attachRabbahMqtt` together. `attachLogSink` is for a custom transport instead of
   mqtt-lib, not in addition to it.
4. Register the app's own listeners ONCE per process, in the Application class or a singleton. Listener slots are
   process-wide, not per screen.
5. If a screen must listen, keep the lambda in a field and call the matching `remove...Listener(sameReference)` in
   `onDestroy` / `onPause`. Guard 1 only recognises the same instance; a fresh lambda created in `onCreate` is a new
   instance every time and will be added again.
6. The single-slot vars (`HardwareLib.exchangeListener = ...`, `logListener = ...`, `stateListener = ...`) replace
   instead of adding. They are safe to assign again, but they are one slot each.

## 7. How to tell which duplicate you are looking at

| Symptom | Where | Spacing | Cause | Fix |
|---|---|---|---|---|
| N copies in the app's own format, library line once, dashboard once | device screen only | same instant | listener registered N times (root cause 1) | register once; remove with the same reference |
| 2 to 4 copies of the same coded item, plus plain-text twins as `unknown_source` | backend and device | a few ms, inside 20 ms | two bridges, each possibly registered twice (root cause 2) | one `attachRabbahMqtt()`, delete the app bridge |
| 2 identical items 50 to 100 ms apart with the engine's own different timestamps | backend | POLL cadence | the machine really repeated the exchange | nothing; this is bus truth and is kept |
| `RabbahLog.dedupedItems` rising on 8.2.1 | code / debugger | - | an extra publisher still wired | find the second `RabbahLog.log` caller or listener registration |

## 8. Verify after deploying 8.2.1

1. `version` on the dashboard passthrough answers `mqtt-lib 2.7.1, hardware-lib 8.2.1`.
2. Run one sale. On the backend each exchange appears once and VEND APPROVED appears once.
3. No `device.log.unknown_source` lines that repeat a coded item.
4. On the device screen, each exchange appears once in the library's words and once per app listener that is
   deliberately registered.
5. Rotate the screen or recreate the Activity ten times and repeat step 2. Counts must not grow.

Not yet run on a real CM30. Compiled, javap-checked, dex-checked. D-0961 is the first field check.

## 9. Questions that came up

**If one VEND APPROVED is sent once but two publishers each take 50 ms, does the 30 ms window miss it?** No. The 30 ms
window is not what fixes the problem. Guards 1 and 2 remove the second publisher, so one exchange reaches
`RabbahLog.log` once and there is nothing to deduplicate. Guard 3 is only there for the in-process fan-out that
produced the 20 ms copies, and all entries of one listener list are called in the same millisecond.

**Why not a wider window?** Because identical exchanges 50 ms apart are legitimate on an MDB bus. Hiding them would
make the backend's view of the machine wrong to cover a bug that is already fixed upstream.

**Why did the engine not have this problem?** It never calls `deliver()` twice for one exchange. Duplication can only
start after `deliver()`, in the listener lists and the bridges, which is exactly where the guards are.

**Does the dashboard show duplicates?** Only in case B. The dashboard reads the MQTT stream, so what it shows is what
the backend receives. In case A the dashboard is the proof that the library stream is clean.
