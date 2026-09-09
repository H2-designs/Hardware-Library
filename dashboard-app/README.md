# Hardware Dashboard (desktop app)

The `dashboard/log-viewer.html` dashboard packaged as a Windows desktop app. One reason it
exists: **a browser tab can only speak MQTT over websockets**, and the Rabbah mosquitto broker
only exposes plain TCP `1883`. Inside Electron the page uses Node's `mqtt` package over
`mqtt://` TCP — the exact same path the CM30 device uses. No broker changes, no websockets.

## Run it

- **Packaged**: unzip `Hardware-Dashboard-win32-x64.zip`, run `Hardware Dashboard.exe`.
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

## Rebuild the distributable

```
npm run package   # -> dist/Hardware Dashboard-win32-x64/
```

`test-tcp.js` is a quick broker connectivity check from this machine: `node test-tcp.js`.
