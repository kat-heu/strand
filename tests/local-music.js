// Your own music files: add from the device, tags read, plays from the file, survives a reload.
const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs'); const os = require('os');
const results = []; const check = (n, ok, info = '') => results.push([ok ? 'PASS' : 'FAIL', n, info]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function wav(sec = 3, rate = 8000) {
  const n = sec * rate, b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(40 * Math.sin(i / 6));
  return b;
}
function id3mp3() {
  const frame = (id, body) => { const h = Buffer.alloc(10); h.write(id, 0); h.writeUInt32BE(body.length, 4); return Buffer.concat([h, body]); };
  const text = s => Buffer.concat([Buffer.from([3]), Buffer.from(s, 'utf8')]);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const apic = Buffer.concat([Buffer.from([0]), Buffer.from('image/png\0'), Buffer.from([3]), Buffer.from('\0'), png]);
  const frames = Buffer.concat([frame('TIT2', text('Neon Rivers')), frame('TPE1', text('Ivy Marlow')), frame('TALB', text('Night Drive')), frame('APIC', apic)]);
  const size = frames.length, h = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127]);
  return Buffer.concat([h, frames, Buffer.alloc(400)]);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strand-local-'));
  const f1 = path.join(dir, 'Nova Lane - Glass Hours.wav'); fs.writeFileSync(f1, wav());
  const f2 = path.join(dir, '02 tagged.mp3'); fs.writeFileSync(f2, id3mp3());
  const f3 = path.join(dir, 'notes.txt'); fs.writeFileSync(f3, 'not music');
  const { start } = require(path.join(__dirname, '..', 'server.js')); await start(5176);
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 1300, height: 850 } });
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'public', 'config.js'), 'utf8').replace(/supabase(Url|Key): '[^']*'/g, "supabase$1: ''");
  await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: cfg }));
  await ctx.route(/itunes|rss\.apple|lrclib/, r => r.fulfill({ contentType: 'application/json', body: '{"results":[]}' }));
  await ctx.route(/fonts\.g|deezer/, r => r.abort());
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:5176/#/library'); await sleep(1200);
  const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.getByRole('button', { name: 'Add your music files' }).click()]);
  await fc.setFiles([f1, f2, f3]); await sleep(3000);
  const pl = await p.evaluate(() => strand.library.playlists.find(x => x.id === 'local'));
  check('Files go into "On this device"', pl && pl.tracks.length === 2, JSON.stringify(pl && pl.tracks.map(t => t.title)));
  check('Title/artist from the file name when there are no tags', pl?.tracks.some(t => t.title === 'Glass Hours' && t.artist === 'Nova Lane'));
  check('Title, artist, album and cover read from ID3 tags', pl?.tracks.some(t => t.title === 'Neon Rivers' && t.artist === 'Ivy Marlow' && t.album === 'Night Drive' && t.artwork.startsWith('blob:')));
  check('Length read from the file', pl?.tracks.find(t => t.title === 'Glass Hours')?.durationMs > 2500);
  check('Opens the "On this device" playlist', p.url().endsWith('#/playlist/local') && await p.isVisible('text=On this device'));
  await p.locator('.row', { hasText: 'Glass Hours' }).dblclick(); await sleep(1500);
  let s = await p.evaluate(() => ({ prov: strand.player.state.provider, playing: strand.player.state.playing, pos: strand.player.state.position }));
  check('Plays from the file on this device', s.prov === 'local' && s.playing, JSON.stringify(s));
  await p.reload(); await sleep(1500);
  await p.evaluate(() => { location.hash = '#/playlist/local'; }); await sleep(800);
  await p.locator('.row', { hasText: 'Glass Hours' }).dblclick(); await sleep(1500);
  s = await p.evaluate(() => ({ prov: strand.player.state.provider, playing: strand.player.state.playing }));
  check('Still plays after reopening Strand', s.prov === 'local' && s.playing, JSON.stringify(s));
  check('Cover still shows after reopening', await p.evaluate(() => strand.library.playlists.find(x => x.id === 'local').tracks.some(t => t.artwork.startsWith('blob:'))));
  // adding the same file again doesn't duplicate it
  const [fc2] = await Promise.all([p.waitForEvent('filechooser'), p.getByRole('button', { name: 'Add files' }).click()]);
  await fc2.setFiles([f1]); await sleep(1500);
  check('Adding the same file twice doesn’t duplicate it', await p.evaluate(() => strand.library.playlists.find(x => x.id === 'local').tracks.length) === 2);
  // remove
  await p.locator('.row', { hasText: 'Neon Rivers' }).click({ button: 'right' }); await sleep(300);
  await p.getByRole('button', { name: 'Remove file from this device' }).click(); await sleep(300);
  await p.locator('.dialog button', { hasText: 'Remove' }).click(); await sleep(800);
  check('Remove deletes it', await p.evaluate(() => strand.library.playlists.find(x => x.id === 'local').tracks.length) === 1);
  // another device (no file here): the song is listed but plays from elsewhere, no broken cover
  const c2 = await b.newContext(); await c2.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: cfg }));
  await c2.route(/fonts\.g|lrclib|deezer/, r => r.abort());
  await c2.route(/itunes\.apple\.com/, r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [{ wrapperType: 'track', trackId: 1, trackName: 'Glass Hours', artistName: 'Nova Lane', collectionName: 'X', artworkUrl100: '', trackTimeMillis: 3000, previewUrl: 'https://audio.test/p.wav' }] }) }));
  await c2.route('https://audio.test/**', r => r.fulfill({ contentType: 'audio/wav', body: wav() }));
  const q = await c2.newPage();
  const lib = await p.evaluate(() => localStorage.getItem('strand:library'));
  await q.goto('http://127.0.0.1:5176/'); await q.evaluate(l => localStorage.setItem('strand:library', l), lib); await q.reload(); await sleep(1200);
  await q.evaluate(() => { location.hash = '#/playlist/local'; }); await sleep(800);
  await q.locator('.row', { hasText: 'Glass Hours' }).dblclick(); await sleep(2500);
  s = await q.evaluate(() => ({ prov: strand.player.state.provider }));
  check('On another device the song plays from a streaming source instead', s.prov && s.prov !== 'local', JSON.stringify(s));
  check('No JavaScript errors', errs.length === 0, errs.join(' | '));
  const failed = results.filter(r => r[0] === 'FAIL').length;
  for (const r of results) console.log(r[0], '-', r[1], r[0] === 'FAIL' ? '→ ' + r[2] : '');
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await b.close(); process.exit(failed ? 1 : 0);
})().catch(e => { for (const r of results) console.log(r[0], '-', r[1], r[0] === 'FAIL' ? '→ ' + r[2] : ''); console.error('CRASH', e.message.slice(0, 800)); process.exit(1); });
