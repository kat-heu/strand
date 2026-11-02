// Free full songs from Audius (mocked): Home shelf, search, plays inside Strand.
const { chromium, devices } = require('playwright');
const path = require('path'); const fs = require('fs');
const results = []; const check = (n, ok, info = '') => results.push([ok ? 'PASS' : 'FAIL', n, info]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function wav(sec = 3, rate = 8000) {
  const n = sec * rate, b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); b.fill(128, 44);
  return b;
}
(async () => {
  const { start } = require(path.join(__dirname, '..', 'server.js')); await start(5169);
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ ...devices['iPhone 13'] });
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'public', 'config.js'), 'utf8').replace(/supabase(Url|Key): '[^']*'/g, "supabase$1: ''").replace(/youtubeKey: '[^']*'/, "youtubeKey: ''");
  await ctx.route(u => u.pathname === '/config.js', r => r.fulfill({ contentType: 'text/javascript', body: cfg }));
  await ctx.route(/itunes\.apple|rss\.apple|lrclib/, r => r.fulfill({ contentType: 'application/json', body: '{"results":[]}' }));
  await ctx.route(/fonts\.g|deezer/, r => r.abort());
  let jamCid = null;
  await ctx.route('https://api.jamendo.com/**', r => {
    const u = new URL(r.request().url()); jamCid = u.searchParams.get('client_id');
    if (u.pathname.startsWith('/v3.0/tracks/file') || u.pathname.endsWith('.mp3')) return r.fulfill({ contentType: 'audio/wav', headers: { 'Access-Control-Allow-Origin': '*' }, body: wav() });
    r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ headers: { status: 'success' }, results: [{ id: '777', name: 'Open Road', artist_name: 'Free Band', album_name: 'CC', album_image: '', duration: 3, audio: 'https://api.jamendo.com/v3.0/tracks/file/?id=777' }] }) });
  });
  const calls = [];
  const T = (id, title, name, extra = {}) => ({ id, title, user: { name, handle: name }, artwork: { '480x480': '' }, duration: 3, genre: 'Electronic', is_streamable: true, ...extra });
  await ctx.route('https://api.audius.co/**', r => {
    const u = new URL(r.request().url()); calls.push(u.pathname + ' app=' + u.searchParams.get('app_name'));
    const J = d => r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(d) });
    if (u.pathname === '/v1/tracks/trending') return J({ data: [T('a1', 'Sunrise Loop', 'Kora'), T('a2', 'Night Market', 'Lumen'), T('a3', 'Paid Song', 'X', { stream_conditions: { usdc_purchase: {} } })] });
    if (u.pathname === '/v1/tracks/search') return J({ data: [T('a9', 'Glass Hours (free remix)', 'Kora')] });
    if (/\/stream$/.test(u.pathname)) return r.fulfill({ contentType: 'audio/wav', headers: { 'Access-Control-Allow-Origin': '*' }, body: wav() });
    return J({ data: [] });
  });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:5169/'); await sleep(2000);
  check('Home shows "Free music trending"', await p.isVisible('text=Free music trending') && await p.locator('.card', { hasText: 'Sunrise Loop' }).count() === 1);
  check('Paid or gated Audius tracks are left out', await p.locator('.card', { hasText: 'Paid Song' }).count() === 0);
  check('Strand identifies itself to Audius (app_name)', calls.length > 0 && calls.every(c => c.endsWith('app=Strand')), calls.join(', '));
  await p.locator('.card', { hasText: 'Sunrise Loop' }).tap(); await sleep(2000);
  let s = await p.evaluate(() => ({ prov: strand.player.state.provider, playing: strand.player.state.playing, bg: strand.player.BACKGROUND?.audius }));
  check('Free songs play in full inside Strand', s.prov === 'audius' && s.playing, JSON.stringify(s));
  check('…on the background-safe player (keeps going when the phone is locked)', await p.evaluate(() => import('/js/player.js').then(m => m.BACKGROUND.audius === true)) && await p.evaluate(() => import('/js/engine.js').then(E => E.ownerName() === 'audius')));
  await p.evaluate(() => { location.hash = '#/search/glass'; }); await sleep(1500);
  await p.locator('.chip', { hasText: 'Free music' }).tap(); await sleep(1500);
  check('Search has a "Free music" tab with Audius results', await p.locator('.row', { hasText: 'Glass Hours (free remix)' }).count() === 1);
  // Apple's catalogue unreachable (as on some phones/networks): search still gives results
  await ctx.unroute(/itunes\.apple|rss\.apple|lrclib/);
  await ctx.route(/itunes\.apple/, r => r.abort());
  await p.evaluate(() => { location.hash = '#/search'; }); await sleep(600);
  await p.locator('.chip', { hasText: 'All' }).tap(); await sleep(300);
  await p.locator('.searchbar input').fill('glass hours'); await sleep(2500);
  check('Search still works when Apple’s catalogue can’t be reached', !(await p.isVisible('text=Something went wrong')) && await p.locator('.row', { hasText: 'Glass Hours (free remix)' }).count() >= 1 && await p.isVisible('text=isn’t reachable'));
  check('Jamendo is switched on with your developer ID', jamCid === '645ed6b3', String(jamCid));
  check('Jamendo songs show up in Free music', await p.locator('.row', { hasText: 'Open Road' }).count() === 1);
  await p.locator('.row', { hasText: 'Open Road' }).tap(); await sleep(2000);
  s = await p.evaluate(() => ({ prov: strand.player.state.provider, playing: strand.player.state.playing }));
  check('Jamendo songs play in full inside Strand', s.prov === 'jamendo' && s.playing, JSON.stringify(s));
  check('No JavaScript errors', !errs.length, errs.join(' | '));
  const failed = results.filter(r => r[0] === 'FAIL').length;
  for (const r of results) console.log(r[0], '-', r[1], r[0] === 'FAIL' ? '→ ' + r[2] : '');
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await b.close(); process.exit(failed ? 1 : 0);
})().catch(e => { for (const r of results) console.log(r[0], '-', r[1], r[0] === 'FAIL' ? '→ ' + r[2] : ''); console.error('CRASH [free-music]', e.message.slice(0, 800)); process.exit(1); });
