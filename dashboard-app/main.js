// Hardware Dashboard - Electron shell around dashboard.html.
//
// The one reason this app exists: a BROWSER can only speak MQTT over websockets, but the
// Rabbah mosquitto broker only exposes plain TCP 1883. Inside Electron the renderer can
// require('mqtt') from Node, which happily connects over mqtt:// TCP - same path the CM30
// device uses, zero broker changes.
const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Log recording lives next to the app's own data (%APPDATA%/Hardware Dashboard/logs on Windows):
// one text file per device per day, written by the renderer; these handlers only answer the
// questions a renderer cannot (where is userData, show a save dialog, reveal a folder).
const LOGS_DIR = path.join(app.getPath('userData'), 'logs');
ipcMain.handle('logs-dir', () => { fs.mkdirSync(LOGS_DIR, { recursive: true }); return LOGS_DIR; });
ipcMain.handle('save-text', async (e, defaultName, text) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, {
    title: 'Export log as text', defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: [{ name: 'Text', extensions: ['txt'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, text, 'utf8');
  return r.filePath;
});
ipcMain.handle('reveal-path', (e, p) => { shell.showItemInFolder(p); return true; });
ipcMain.handle('open-path', (e, p) => shell.openPath(p));

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
