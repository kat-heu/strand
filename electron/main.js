// Desktop wrapper: serves the same web app from 127.0.0.1 and opens it in a window.
// For Spotify / Apple Music full playback the window needs Widevine DRM, which the
// stock Electron build doesn't ship. Use the castLabs "Electron for Content Security"
// build (see README) — it exposes `components`, which we wait on below.
const { app, BrowserWindow, shell, components } = require('electron');
const path = require('path');
const { start } = require('../server');
const { setupAutoUpdates } = require('./updater');

const PORT = 5173;
let mainWin = null;
const focusWin = () => { if (!mainWin) return; if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus(); };

async function createWindow() {
  let url = `http://127.0.0.1:${PORT}/`;
  try {
    ({ url } = await start(PORT, '127.0.0.1', { onAuth: focusWin }));
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e; // already running (e.g. `npm start`) — just reuse it
  }

  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#0c0b10',
    title: 'Strand',
    autoHideMenuBar: true,
    show: false, // shown once the app has painted, so it never flashes blank
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  });
  mainWin = win;
  win.once('ready-to-show', () => win.show());
  setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) win.show(); }, 10000);

  // If the app page fails to load (slow start, local server not ready), retry.
  win.webContents.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    if (isMainFrame && failedUrl.startsWith(url)) setTimeout(() => { if (!win.isDestroyed()) win.loadURL(url); }, 1000);
  });
  win.webContents.on('render-process-gone', () => { if (!win.isDestroyed()) win.loadURL(url); });

  // The main window only ever shows Strand. Anything else (a login page, a link)
  // opens in the default browser instead of replacing the app with no way back.
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(url)) { e.preventDefault(); shell.openExternal(target); }
  });

  // Sign-in popups (Google, Apple Music) open inside the app so they can hand the
  // login back to the page; every other target=_blank link goes to the system browser.
  const AUTH_HOSTS = ['accounts.google.com', 'authorize.music.apple.com', 'idmsa.apple.com', 'appleid.apple.com'];
  win.webContents.setWindowOpenHandler(({ url }) => {
    let host = '';
    try { host = new URL(url).hostname; } catch {}
    if (AUTH_HOSTS.includes(host) || url === 'about:blank') {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 700, autoHideMenuBar: true, parent: win } };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadURL(url);
}

app.whenReady().then(async () => {
  if (components && typeof components.whenReady === 'function') {
    try {
      await components.whenReady();
      console.log('Widevine ready:', components.status());
    } catch (e) {
      console.warn('Widevine unavailable — Spotify/Apple Music will fall back to other sources:', e.message);
    }
  }
  setupAutoUpdates();
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
