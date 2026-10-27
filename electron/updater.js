// Automatic updates from GitHub Releases (electron-updater).
// On launch and every 4 hours: check for a newer release, download it in the
// background, then offer to restart. "Later" installs it when the app quits.
// Works on Windows and Linux (AppImage). macOS auto-update requires a signed app.
const { app, dialog, BrowserWindow } = require('electron');

function setupAutoUpdates() {
  if (!app.isPackaged) return;            // only in installed builds
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { console.warn('electron-updater missing', e); return; }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  let prompted = false;
  autoUpdater.on('update-downloaded', async info => {
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
  autoUpdater.on('error', e => console.warn('Update check failed:', e?.message || e));

  const check = () => autoUpdater.checkForUpdates().catch(e => console.warn('Update check failed:', e?.message || e));
  setTimeout(check, 5000);
  setInterval(check, 4 * 60 * 60 * 1000);
}

module.exports = { setupAutoUpdates };
