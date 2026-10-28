# Rabbah hardware library - CM30 MDB / RS232 / Pulse

Everything needed to put a Rabbah payment terminal (CM30) on a vending machine: the Android libraries, their
complete source code, the React Native bridge, the Windows operator dashboard, the documentation set and the
release history. Current release: **v8.2.10** (hardware-lib 8.2.10, mqtt-lib 2.8.0, 28 October 2026).

## What is in this repository

| path | what it is |
|---|---|
| `libs/` | the three AARs an Android app bundles: `hardware-lib-8.2.10.aar`, `mqtt-lib-2.8.0.aar`, `CM30-HardwareLibrary-1.0.9.aar` (vendor runtime) |
| `AAR-Update-latest.zip` | the Android handoff: the three AARs + the four READMEs below, stable name, rebuilt on every release |
| `IMPLEMENTATION-README.md` | **the implementation guide for the Android app**: startup, the three-callback VendListener with the reversal rule, approve / cancel, health check, per-machine settings, RS232 rules, pulse, verify, troubleshooting |
| `VENDLISTENER-README.md` | the VendListener in full: Kotlin / Java / React Native implementation, the fix for every field mistake, the vend counters, the bench test |
| `CANCEL-FLOW-README.md` | who can cancel a vend (machine, app, dashboard), what onVendFailure reports for each, what goes on the bus |
| `SESSION-ENDED-README.md` | the vend the machine never finished: why onVendFailure fires at END SESSION with SESSION_ENDED and why the app must reverse |
| `AAR-HANDOFF-README.md` | **start here for the Android app**: install, what changed since the fleet's 8.0.0, health check, listener rules, per-state answer table, verify |
| `API-REFERENCE.md` | every public function of `HardwareLib` (MDB), `Rs232Lib`, `PulseLib`, plus the remote command cheat sheet |
| `PULSE-README.md` | pulse machine integration guide |
| `DUPLICATE-LOGS-README.md` | why log lines were duplicated on the device and the backend, and how 8.2.1 / 2.7.1 stops it |
| `RELEASE-NOTES-8.2.10.md` | release notes for the Android team, cumulative against the fleet's 8.0.0 / 2.6.0 (older: 8.2.9 and 8.2.8 (never released), 8.2.7, 8.2.6, 8.2.5, 8.2.4, 8.2.3, 8.2.2, 8.2.1, 8.2.0, 8.1.0) |
| `RS232-LOG-SCHEMA.md`, `RS232-TEST-PLAN.md`, `LIBRARY_README.md` | RS232 codebook schema, RS232 bench plan, the long-form library README |
| `docs/` | the documentation pages: library manual (with the full release history tab), architecture, design, RS232 guide, React Native manual, release notes pages, vend simulator, packet scheme, machine setup template for the dashboard team |
| `dashboard-app/` | the Hardware Dashboard (Electron, plain MQTT TCP): live log, device tabs, every remote command, hex config editor, log recording to disk, History and Export. `npm install && npm start`, or the packaged zip on the release |
| `samples/` | `MdbMqttBridge.kt` (two-line wrapper), `PulsePaymentSample.kt`, RS232 sample |
| `*.apk` | test apps that carry no credentials: `pulse-sample-v1.5.apk`, `rs232-sample-v2.0.apk`. The library demo `MDB-Slave-2-v2.25.0-build112-debug.apk` and `rabbahlog-sample` embed the broker password (see below) and are deliberately NOT in git; build them from `source/` or take them from the private release |
| `source/MdbSlaveApp/` | **complete source** of the libraries and the demo apps: Gradle project with modules `hardware-lib`, `mqtt-lib`, `app` (MDB-Slave-2 demo), `pulse-sample`, `rs232-sample`, `rabbahlog-sample`, `sampleapp`, `mdblib` (legacy) |
| `source/react-native/` | the complete Hardware-ReactNative tree: `react-native-mdb/` (the bridge package 1.3.3 that bundles the same AARs; JS API in `index.d.ts`), `MdbDemo/` (the React Native demo app, run with `npm install` then `npm run android`), its `docs/` and README |

## Versions

| component | version |
|---|---|
| hardware-lib | 8.2.10 |
| mqtt-lib | 2.8.0 |
| CM30-HardwareLibrary (vendor) | 1.0.9 |
| demo APK MDB-Slave-2 | v2.25.0 build 112 (on hardware-lib 8.2.10) |
| Hardware Dashboard | v8.2.4 (Cancel Retry, Skip 00 00 Vend toggles): `Hardware-Dashboard-win32-x64-v8.2.4.zip` on the release |
| react-native-mdb | 1.3.9 |

A device on the right build answers `version` on the dashboard passthrough bar with
`mqtt-lib 2.8.0, hardware-lib 8.2.10`.

## Build the libraries from source

```
cd source/MdbSlaveApp
copy local.properties.example local.properties      # fill sdk.dir and the broker settings
gradlew :hardware-lib:assembleRelease :mqtt-lib:assembleRelease :app:assembleDebug
```

Outputs: `hardware-lib/build/outputs/aar/hardware-lib-release.aar`, `mqtt-lib/build/outputs/aar/mqtt-lib-release.aar`,
`app/build/outputs/apk/debug/app-debug.apk`. Build with the Android Studio JBR (Java 17). Bump `HardwareLib.VERSION`,
`MqttLib.VERSION` and the app `versionCode` / `versionName` on every build; the MDM rejects reused versions.

## The broker password

The MQTT password lives only in `source/MdbSlaveApp/local.properties` (ignored by git) and reaches the demo app
through `BuildConfig`. It is never printed and never committed as text. **A debug APK built that way carries the
password inside its dex**, which is why the MDB-Slave-2 and rabbahlog demo APKs are not committed here. Build them from
`source/` with your own local.properties, or keep them only as assets of a private release. Rotate the password if
such an APK ever leaves the organisation.

## Standing rules of the stack

- Nothing turns on by itself on the device: remote log stream and hardware auto-attach are off by default and the
  operator enables them from the dashboard.
- Every vending-machine deviation is a persisted operator setting (session mode, cooldown, cancel mode, MDB level,
  direct vend, force session end, ready feedback, pulse polarity), never app code.
- `VendListener` is exactly three callbacks: `onVendRequest`, `onVendSuccess`, `onVendFailure`.
- One dashboard (`dashboard-app/dashboard.html`), one GitHub release kept at a time.
- Register library listeners once per process and keep a single `HardwareLib.attachRabbahMqtt()`; see
  `DUPLICATE-LOGS-README.md`.

## Not yet verified on hardware

Everything from 8.1.0 onward is compiled, API-checked and dex-checked but has not run on a real CM30. First field
checks: backend logs showing each exchange once, the direct-vend health check passing, a reader restart mid-session,
the force-end machine, and the D-0130 presence fix.
