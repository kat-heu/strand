// iTunes library access for the desktop app.
// - finds the library file iTunes keeps (or lets you pick an exported one)
// - serves the songs listed in it to the player through strandfile://song/<path>,
//   and nothing else: only files named in your library, and only audio files.
const { app, ipcMain, dialog, protocol, net, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const AUDIO = /\.(mp3|m4a|aac|wav|aif|aiff|flac|alac|ogg|opus|mp4)$/i;
let allowed = new Set();
const norm = p => (process.platform === 'win32' ? p.toLowerCase() : p);

// Must run before the app is ready.
protocol.registerSchemesAsPrivileged([{ scheme: 'strandfile', privileges: { stream: true, supportFetchAPI: true, secure: true, standard: true, corsEnabled: true } }]);

function candidates() {
  const home = os.homedir(), m = path.join(home, 'Music');
  return [
    path.join(m, 'iTunes', 'iTunes Library.xml'),
    path.join(m, 'iTunes', 'iTunes Music Library.xml'),
    path.join(m, 'Music', 'Library.xml'),
    path.join(m, 'Library.xml'),
    path.join(home, 'Desktop', 'Library.xml'),
    path.join(home, 'Downloads', 'Library.xml'),
  ];
}

function setup() {
  protocol.handle('strandfile', req => {
    let p = '';
    try { p = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, '')); } catch {}
    if (!p || !AUDIO.test(p) || !allowed.has(norm(p))) return new Response('Not allowed', { status: 403 });
    if (!fs.existsSync(p)) return new Response('Missing', { status: 404 });
    return net.fetch(pathToFileURL(p).toString(), { headers: req.headers });   // passes Range through, so seeking works
  });
  ipcMain.handle('itunes:find', async () => {
    for (const f of candidates()) {
      try { const xml = await fs.promises.readFile(f, 'utf8'); if (xml.includes('<plist')) return { path: f, xml }; } catch {}
    }
    return null;
  });
  ipcMain.handle('itunes:pick', async e => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose your iTunes / Music library file',
      defaultPath: path.join(os.homedir(), 'Music'),
      filters: [{ name: 'iTunes library', extensions: ['xml'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const f = r.filePaths[0];
    const xml = await fs.promises.readFile(f, 'utf8');
    if (!xml.includes('<plist')) throw new Error('That isn’t an iTunes library file');
    return { path: f, xml };
  });
  ipcMain.handle('itunes:allow', (_e, files) => {
    allowed = new Set((Array.isArray(files) ? files : []).filter(f => typeof f === 'string' && AUDIO.test(f)).map(norm));
    return allowed.size;
  });
}

module.exports = { setup };
