// Cloud music: songs you add are uploaded to your private Strand cloud and play
// inside Strand on your other devices (Supabase Storage mocked).
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
const UID = '11111111-2222-3333-4444-555555555555';
const SB = 'https://sb.test';

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strand-cloud-'));
  const f1 = path.join(dir, 'Nova Lane - Glass Hours.wav'); fs.writeFileSync(f1, wav());
  const { start } = require(path.join(__dirname, '..', 'server.js')); await start(5174);
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'public', 'config.js'), 'utf8').replace(/supabaseUrl: '[^']*'/, `supabaseUrl: '${SB}'`).replace(/supabaseKey: '[^']*'/, "supabaseKey: 'pk'");
  const files = new Map(); let row = null; const calls = [];
  const J = (r, d, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(d) });
  const session = { access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3600e3, user: { id: UID, email: 'kat@example.com', user_metadata: { name: 'Kat' } } };
  const setup = async ctx => {
    await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: cfg }));
    await ctx.route(/itunes\.apple|rss\.apple|lrclib/, r => J(r, { results: [], feed: { results: [] } }));
    await ctx.route(/fonts\.g|deezer/, r => r.abort());
    await ctx.route(SB + '/**', async r => {
      const req = r.request(), u = new URL(req.url()), m = req.method();
      if (m === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
      calls.push(m + ' ' + u.pathname);
      if (u.pathname === '/rest/v1/user_data') {
        if (m === 'GET') return J(r, row ? [row] : []);
        row = { ...row, ...JSON.parse(req.postData()), updated_at: new Date().toISOString() }; return J(r, [row], 201);
      }
      if (u.pathname.startsWith('/auth/v1/user')) return J(r, session.user);
      const up = u.pathname.match(/^\/storage\/v1\/object\/music\/(.+)$/);
      if (up && m === 'POST') {
        const p = decodeURIComponent(up[1]);
        if (!p.startsWith(UID + '/')) return J(r, { message: 'new row violates row-level security policy' }, 403);
        files.set(p, { body: req.postDataBuffer(), type: req.headers()['content-type'] }); return J(r, { Key: 'music/' + p });
      }
      if (u.pathname === '/storage/v1/object/sign/music' && m === 'POST') {
        const { paths } = JSON.parse(req.postData());
        return J(r, paths.map(p => ({ path: p, signedURL: `/object/sign/music/${p}?token=t`, error: files.has(p) ? null : 'not found' })));
      }
      const get = u.pathname.match(/^\/storage\/v1\/object\/sign\/music\/(.+)$/);
      if (get) { const f = files.get(decodeURIComponent(get[1])); return f ? r.fulfill({ status: 200, contentType: f.type, headers: { 'Access-Control-Allow-Origin': '*' }, body: f.body }) : r.fulfill({ status: 404 }); }
      if (u.pathname === '/storage/v1/object/music' && m === 'DELETE') { for (const p of JSON.parse(req.postData()).prefixes) files.delete(p); return J(r, []); }
      return J(r, {});
    });
    await ctx.addInitScript(s => { if (!localStorage.getItem('strand:session')) localStorage.setItem('strand:session', JSON.stringify(s)); }, session);
  };

  // ---- phone/computer A: add a song → uploaded to the cloud
  const A = await b.newContext({ viewport: { width: 1300, height: 850 } }); await setup(A);
  const p = await A.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:5174/#/library'); await sleep(1500);
  const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.getByRole('button', { name: 'Add your music files' }).first().click()]);
  await fc.setFiles([f1]); await sleep(3000);
  const songPath = [...files.keys()].find(k => k.includes('/songs/'));
  check('Added song is uploaded to your private cloud folder', !!songPath && songPath.startsWith(UID + '/songs/') && songPath.endsWith('.wav'), JSON.stringify([...files.keys()]));
  check('The song remembers where it is in the cloud', await p.evaluate(() => strand.library.playlists.find(x => x.id === 'local')?.tracks[0]?.ids.cloud) === songPath);
  await sleep(2500);   // let the library sync
  check('Library (with the song) synced to your account', !!row && JSON.stringify(row.library || {}).includes(songPath));

  // ---- device B: same account, doesn't have the file → plays it from the cloud, inside Strand
  const B = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); await setup(B);
  const q = await B.newPage(); const errs2 = []; q.on('pageerror', e => errs2.push(e.message));
  await q.goto('http://127.0.0.1:5174/#/playlist/local'); await sleep(2500);
  await q.evaluate(() => { location.hash = '#/playlist/local'; }); await sleep(1200);
  check('Your other device shows the song', await q.locator('.row', { hasText: 'Glass Hours' }).count() === 1);
  await q.evaluate(() => strand.player.playQueue(strand.library.playlists.find(x => x.id === 'local').tracks, 0)); await sleep(2500);
  const s = await q.evaluate(() => ({ prov: strand.player.state.provider, playing: strand.player.state.playing }));
  check('…and plays it from your cloud inside Strand', s.prov === 'cloud' && s.playing, JSON.stringify(s));

  // ---- remove → gone from the cloud too
  await p.evaluate(() => { location.hash = '#/playlist/local'; }); await sleep(800);
  await p.locator('.row', { hasText: 'Glass Hours' }).click({ button: 'right' }); await sleep(300);
  await p.getByRole('button', { name: 'Remove from My music' }).click(); await sleep(300);
  await p.locator('.dialog button', { hasText: 'Remove' }).click(); await sleep(1000);
  check('Removing a song deletes it from the cloud', ![...files.keys()].some(k => k.includes('/songs/')));
  check('No JavaScript errors', !errs.length && !errs2.length, [...errs, ...errs2].join(' | '));

  const failed = results.filter(r => r[0] === 'FAIL').length;
  for (const r of results) console.log(r[0], '-', r[1], r[0] === 'FAIL' ? '→ ' + r[2] : '');
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await b.close(); process.exit(failed ? 1 : 0);
})().catch(e => { for (const r of results) console.log(r[0], '-', r[1], r[0] === 'FAIL' ? '→ ' + r[2] : ''); console.error('CRASH', e.message.slice(0, 800)); process.exit(1); });
