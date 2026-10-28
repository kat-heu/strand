// Automatic updates from GitHub Releases (electron-updater).
// On launch and every 4 hours: check for a newer release, download it in the
// background, then offer to restart. "Later" installs it when the app quits.
// Status is shown in Settings, and every step is written to update.log in the
// app's data folder so failed updates (e.g. blocked by a network) can be diagnosed.
const { app, dialog, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');

let status = { state: 'idle' };
const logFile = () => path.join(app.getPath('userData'), 'update.log');
function log(...a) {
  const line = `${new Date().toISOString()} ${a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`;
  try { fs.appendFileSync(logFile(), line); } catch {}
  console.log(...a);
}
function setStatus(s) {
  status = { ...s, at: Date.now() };
  log('status', status);
  for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('update-status', status); } catch {} }
}

function setupAutoUpdates() {
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('update:status', () => status);
  ipcMain.handle('update:log', () => shell.openPath(logFile()));

  if (!app.isPackaged) {
    status = { state: 'dev' };
    ipcMain.handle('update:check', () => status);
    ipcMain.handle('update:install', () => {});
    return;
  }

  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); }
  catch (e) { setStatus({ state: 'error', message: 'Updater missing: ' + e.message }); return; }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: m => log('[info]', m), warn: m => log('[warn]', m), error: m => log('[error]', m), debug: () => {} };

  let prompted = false;
  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => setStatus({ state: 'latest' }));
  autoUpdater.on('update-available', info => setStatus({ state: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', p => setStatus({ state: 'downloading', version: status.version, percent: Math.round(p.percent) }));
  autoUpdater.on('error', e => setStatus({ state: 'error', message: String(e?.message || e).split('\n')[0] }));
  autoUpdater.on('update-downloaded', async info => {
    setStatus({ state: 'ready', version: info.version });
    if (prompted) return;
    prompted = true;
    const win = BrowserWindow.getAllWindows()[0];
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Strand ${info.version} is ready to install.`,
      detail: 'Restart now to update, or it will install the next time you close Strand.',
    });
    if (response === 0) setImmediate(() => autoUpdater.quitAndInstall());
  });

  const check = () => autoUpdater.checkForUpdates().catch(e => setStatus({ state: 'error', message: String(e?.message || e).split('\n')[0] }));
  ipcMain.handle('update:check', async () => { await check(); return status; });
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());

  log('Strand', app.getVersion(), 'starting update checks');
  setTimeout(check, 5000);
  setInterval(check, 4 * 60 * 60 * 1000);
}

module.exports = { setupAutoUpdates };
