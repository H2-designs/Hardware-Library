# Hardware Dashboard (desktop app)

The `dashboard-app/dashboard.html` (Hardware Dashboard desktop app) dashboard packaged as a Windows desktop app. One reason it
exists: **a browser tab can only speak MQTT over websockets**, and the Rabbah mosquitto broker
only exposes plain TCP `1883`. Inside Electron the page uses Node's `mqtt` package over
`mqtt://` TCP — the exact same path the CM30 device uses. No broker changes, no websockets.

## Run it

- **Packaged**: download `Hardware-Dashboard-win32-x64-v<version>.zip` from the repo's **Releases** page
  (https://github.com/H2-designs/Hardware-Library/releases - the exe is ~120 MB, too big for git itself),
  unzip, run `Hardware Dashboard.exe`. The dashboard.html source in this folder is always the latest.
- **From source**: `npm install && npm start` in this folder
  (first time: `npm approve-scripts electron && npm rebuild electron`).

## Connecting

On first launch a connection panel appears with the broker URL and username prefilled —
type the MQTT password once (the same one in `MdbSlaveApp/local.properties`) and it is
saved on that computer. Press **F2** any time to change broker/user/password.

Alternatively drop a `config.json` next to `dashboard.html` (or next to the exe's
`resources/app/` folder in the packaged build):

```json
{ "broker": "mqtt://uat-api.rabbah.sa:1883", "username": "rabbah", "password": "..." }
```

`config.json` is gitignored on purpose — never commit it.

## What it shows

Identical to the HTML dashboard: every device publishing under
`cm30-mdb/hamdan-rabbah/<deviceId>/liveLog` appears in the device dropdown; all commands
(vendApprove, rs232Open, setRs232Rules, initPulse, …) publish to
`…/<deviceId>/commands`.

## Device tabs (15 October 2026)

Picking a device in the dropdown opens a **tab** for it under the header. Every open tab keeps its own
log buffer (last 5000 lines in memory, last 2000 drawn), its own cached settings / config / VMC state /
link counters, and keeps being decoded and recorded while another tab is on screen. A background tab
shows an unread counter and the device's last reported MDB state; its presence dot follows the retained
status topic. Click a tab to switch (the controls flip to that device's values at once, then a
`getSettings` refreshes them), **×** closes it. Open tabs survive a restart. Commands always go to the
tab on screen only.

## Log recording, History, Export (15 October 2026)

- **Record** (header toggle, default ON): every line of every open tab is appended to a text file on this
  PC, one file per device per day: `%APPDATA%\Hardware Dashboard\logs\<deviceId>\<YYYY-MM-DD>.txt`
  (lines are `HH:MM:SS.mmm  text`, written in 0.7 s batches; hidden "other peripheral" lines are
  recorded too, the view filter only affects the screen). Control-plane snapshots (SETTINGS_JSON,
  VMC_STATUS, ...) are not log lines and are not recorded.
- **History**: opens the recorded files - pick device and day, **Load**, filter lines live, **Export** the
  shown lines as .txt, **Open folder**. Works with no broker connection, so a log from yesterday can be
  read on the train.
- **Export**: saves the tab on screen (everything in its memory buffer) as a .txt through a save dialog.
- **Clear** empties the screen and the memory buffer of that tab only; the file on disk is kept.

## Rebuild the distributable

```
npm run package   # -> dist/Hardware Dashboard-win32-x64/
```

`test-tcp.js` is a quick broker connectivity check from this machine: `node test-tcp.js`.
