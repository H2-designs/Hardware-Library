// Hardware Dashboard - Electron shell around dashboard.html.
//
// The one reason this app exists: a BROWSER can only speak MQTT over websockets, but the
// Rabbah mosquitto broker only exposes plain TCP 1883. Inside Electron the renderer can
// require('mqtt') from Node, which happily connects over mqtt:// TCP - same path the CM30
// device uses, zero broker changes.
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Hardware Dashboard',
    autoHideMenuBar: true,
    webPreferences: {
      // The dashboard page calls require('mqtt') directly - it is our own local file, no
      // remote content is ever loaded in this window.
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'dashboard.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
