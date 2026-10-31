// iTunes library access for the desktop app.
// - finds the library file iTunes keeps (or lets you pick an exported one)
// - serves the songs listed in it to the player through strandfile://song/<path>,
//   and nothing else: only files named in your library, and only audio files.
const { ipcMain, dialog, protocol, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const TYPES = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.alac': 'audio/mp4' };

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
    let size;
    try { size = fs.statSync(p).size; } catch { return new Response('Missing', { status: 404 }); }
    // Answer byte-range requests ourselves, so jumping around in a song works.
    const type = TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream';
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
    if (m && size) {
      let start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
      let end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      return new Response(Readable.toWeb(fs.createReadStream(p, { start, end })), { status: 206, headers: {
        'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' } });
    }
    return new Response(Readable.toWeb(fs.createReadStream(p)), { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
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
