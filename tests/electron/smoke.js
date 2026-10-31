// Desktop-app check, run in the real Electron (CI: xvfb-run npx electron tests/electron/smoke.js).
// Plays a song file through strandfile:// like an iTunes song, and checks that files
// not in your library are refused.
const { app, BrowserWindow, components } = require('electron');
const fs = require('fs'); const os = require('os'); const path = require('path');
const itunes = require('../../electron/itunes');
const { start } = require('../../server');

function wav(sec = 2, rate = 8000) {
  const n = sec * rate, b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(40 * Math.sin(i / 5));
  return b;
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strand smoke '));
const song = path.join(dir, 'Glass Hours (live).wav'); fs.writeFileSync(song, wav());
const secret = path.join(dir, 'secret.wav'); fs.writeFileSync(secret, wav());

app.whenReady().then(async () => {
  itunes.setup();
  await start(5199, '127.0.0.1');
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, '..', '..', 'electron', 'preload.js') } });
  await win.loadURL('http://127.0.0.1:5199/callback.html');
  const run = js => win.webContents.executeJavaScript(js);
  const results = [];
  const allowedCount = await run(`window.strandDesktop.itunes.allow(${JSON.stringify([song])})`);
  results.push(['allow list set', allowedCount === 1]);
  const played = await run(`new Promise(res => { const a = new Audio('strandfile://song/' + encodeURIComponent(${JSON.stringify(song)})); a.muted = true;
    a.oncanplay = () => a.play().then(() => setTimeout(() => res({ ok: true, t: a.currentTime, d: a.duration }), 700), e => res({ ok: false, e: e.message }));
    a.onerror = () => res({ ok: false, e: 'error ' + (a.error && a.error.code) }); setTimeout(() => res({ ok: false, e: 'timeout' }), 8000); })`);
  results.push(['library song plays from its file', played.ok && played.t > 0.2, JSON.stringify(played)]);
  const seek = await run(`fetch('strandfile://song/' + encodeURIComponent(${JSON.stringify(song)}), { headers: { Range: 'bytes=100-199' } }).then(r => r.status + ':' + r.headers.get('content-length')).catch(e => 'err ' + e.message)`);
  results.push(['seeking (range requests) works', seek === '206:100', seek]);
  const denied = await run(`fetch('strandfile://song/' + encodeURIComponent(${JSON.stringify(secret)})).then(r => r.status).catch(e => 'err')`);
  results.push(['files not in the library are refused', denied === 403, String(denied)]);
  const notAudio = await run(`fetch('strandfile://song/' + encodeURIComponent(${JSON.stringify(path.join(dir, 'x.txt'))})).then(r => r.status).catch(e => 'err')`);
  results.push(['non-audio files are refused', notAudio === 403, String(notAudio)]);
  // Widevine (castLabs build): needed for Spotify inside the desktop app
  let cdm = 'no components API (stock Electron)';
  if (components) {
    try { await Promise.race([components.whenReady(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 60000))]); cdm = JSON.stringify(components.status()); }
    catch (e) { cdm = 'not ready: ' + e.message; }
  }
  const wv = await run(`navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{ initDataTypes: ['cenc'], audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }] }]).then(() => 'yes', e => 'no: ' + e.message)`);
  console.log('Widevine module:', cdm);
  results.push(['Widevine copy protection available (needed for Spotify in the app)', wv === 'yes', wv + ' · ' + cdm]);
  let failed = 0;
  for (const [n, ok, info] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' - ' + n + (ok ? '' : ' → ' + (info || ''))); if (!ok) failed++; }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  app.exit(failed ? 1 : 0);
});
