// Your music server (Subsonic/Navidrome, mocked) + Mixes made for you.
const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs');
const results = []; const check = (n, ok, info = '') => results.push([ok ? 'PASS' : 'FAIL', n, info]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function wav(sec = 3, rate = 8000) {
  const n = sec * rate, b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); b.fill(128, 44);
  return b;
}
const SRV = 'https://music.example.test';
(async () => {
  const { start } = require(path.join(__dirname, '..', 'server.js')); await start(5170);
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 1300, height: 850 } });
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'public', 'config.js'), 'utf8').replace(/supabase(Url|Key): '[^']*'/g, "supabase$1: ''").replace(/youtubeKey: '[^']*'/, "youtubeKey: ''");
  await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: cfg }));
  await ctx.route(/itunes\.apple|rss\.apple|lrclib/, r => r.fulfill({ contentType: 'application/json', body: '{"results":[]}' }));
  await ctx.route(/fonts\.g/, r => r.abort());
  // Deezer: related artists + top tracks (JSONP)
  await ctx.route('https://api.deezer.com/**', r => {
    const u = new URL(r.request().url()), cb = u.searchParams.get('callback'); let d = { data: [] };
    if (u.pathname === '/search/artist') d = { data: [{ id: 10, name: u.searchParams.get('q') }] };
    if (/\/related$/.test(u.pathname)) d = { data: [{ id: 21, name: 'Halden' }, { id: 22, name: 'Mira Sol' }] };
    if (/\/top$/.test(u.pathname)) { const id = +u.pathname.split('/')[2]; d = { data: [1, 2].map(i => ({ id: id * 100 + i, title: 'New song ' + id + '-' + i, artist: { name: id === 21 ? 'Halden' : 'Mira Sol' }, album: { title: 'X', cover_xl: '' }, duration: 200, preview: 'https://audio.test/d.wav' })) }; }
    r.fulfill({ contentType: 'text/javascript', body: `${cb}(${JSON.stringify(d)})` });
  });
  // Subsonic server
  let lastAuth = null;
  const ok = x => ({ 'subsonic-response': { status: 'ok', version: '1.16.1', type: 'navidrome', serverVersion: '0.53', ...x } });
  const song = (id, title, artist) => ({ id, title, artist, album: 'Server Album', duration: 3, coverArt: 'al-1', albumId: 'al-1' });
  await ctx.route(SRV + '/**', r => {
    const u = new URL(r.request().url()), m = u.pathname.split('/').pop();
    lastAuth = { u: u.searchParams.get('u'), t: u.searchParams.get('t'), s: u.searchParams.get('s'), p: u.searchParams.get('p') };
    const J = d => r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(d) });
    if (m === 'ping') return u.searchParams.get('u') === 'kat' ? J(ok({})) : J({ 'subsonic-response': { status: 'failed', error: { code: 40, message: 'Wrong username or password' } } });
    if (m === 'getPlaylists') return J(ok({ playlists: { playlist: [{ id: 'pl1', name: 'Road Trip', songCount: 2, coverArt: 'pl-1' }] } }));
    if (m === 'getPlaylist') return J(ok({ playlist: { name: 'Road Trip', entry: [song('s1', 'Glass Hours', 'Nova Lane'), song('s2', 'Neon Rivers', 'Ivy Marlow')] } }));
    if (m === 'getAlbumList2') return J(ok({ albumList2: { album: [{ id: 'al-1', name: 'Server Album', artist: 'Nova Lane', coverArt: 'al-1' }] } }));
    if (m === 'getRandomSongs') return J(ok({ randomSongs: { song: [song('s1', 'Glass Hours', 'Nova Lane'), song('s3', 'Quiet Engines', 'Ora Vale')] } }));
    if (m === 'getSimilarSongs2') return J(ok({ similarSongs2: { song: [song('s4', 'After the Static', 'Mira Sol')] } }));
    if (m === 'getStarred2') return J(ok({ starred2: { song: [] } }));
    if (m === 'search3') return J(ok({ searchResult3: { song: /Glass Hours/i.test(u.searchParams.get('query')) ? [song('s1', 'Glass Hours', 'Nova Lane')] : [] } }));
    if (m === 'stream') return r.fulfill({ contentType: 'audio/wav', headers: { 'Access-Control-Allow-Origin': '*' }, body: wav() });
    if (m === 'getCoverArt') return r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>' });
    return J(ok({}));
  });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:5170/#/me'); await sleep(1200);
  const answers = ['music.example.test', 'kat', 'secret'];
  await p.locator('.acct', { hasText: 'My music server' }).getByRole('button', { name: 'Connect' }).click();
  for (const a of answers) { await p.locator('.dialog input').fill(a); await p.locator('.dialog button').last().click(); await sleep(400); }
  await sleep(800);
  check('Connects to the music server (https added, password not sent or stored)', await p.locator('.acct.linked', { hasText: 'kat' }).count() === 1 && lastAuth.u === 'kat' && lastAuth.t && lastAuth.s && !lastAuth.p
    && !(await p.evaluate(() => JSON.stringify(localStorage))).includes('secret'), JSON.stringify(lastAuth));
  await p.evaluate(() => { location.hash = '#/me/server'; }); await sleep(1500);
  check('Shows your server playlists and albums', await p.locator('.card', { hasText: 'Road Trip' }).count() === 1 && await p.locator('.card', { hasText: 'Server Album' }).count() === 1);
  await p.locator('.card', { hasText: 'Road Trip' }).click(); await sleep(1500);
  await p.locator('.row', { hasText: 'Glass Hours' }).dblclick(); await sleep(1500);
  let s = await p.evaluate(() => ({ prov: strand.player.state.provider, playing: strand.player.state.playing }));
  check('Server songs play inside Strand (background-safe player)', s.prov === 'server' && s.playing, JSON.stringify(s));
  // a catalog song you also own plays from your server
  await p.evaluate(() => strand.player.playQueue([{ key: 'it:900', title: 'Glass Hours', artist: 'Nova Lane', durationMs: 3000, previewUrl: 'https://audio.test/p.wav', origin: 'catalog', ids: {} }], 0)); await sleep(1500);
  s = await p.evaluate(() => ({ prov: strand.player.state.provider }));
  check('A song you also have on your server plays from your server', s.prov === 'server', JSON.stringify(s));

  // ---- mixes
  await p.evaluate(() => import('/js/store.js').then(m => {
    const T = (i, a) => ({ key: 'm' + i, title: 'Song ' + i, artist: a, artwork: '', durationMs: 1000, origin: 'catalog', ids: {} });
    const list = []; for (let i = 0; i < 40; i++) list.push(T(i, ['Nova Lane', 'Ivy Marlow', 'Ora Vale', 'Nova Lane'][i % 4]));
    m.library.playlists.push({ id: 'p9', name: 'Mine', tracks: list, created: 1 });
    m.library.liked.push(...list.slice(0, 12)); m.library.recent.push(...list.slice(0, 10)); m.saveLibrary();
  }));
  await p.evaluate(() => { location.hash = '#/mixes'; }); await sleep(3500);
  const mixes = await p.evaluate(() => import('/js/mixes.js').then(m => m.buildMixes()).then(ms => ms.map(x => ({ id: x.id, n: x.tracks.length, new: x.tracks.filter(t => t.discovered).length, arts: x.tracks.map(t => t.artist) }))));
  check('Daily mixes are made from your listening', mixes.some(m => m.id === 'daily-1' && m.n >= 8), JSON.stringify(mixes.map(m => m.id + ':' + m.n)));
  check('Mixes add new artists you don’t have yet', mixes.some(m => m.new > 0) && mixes.some(m => m.id === 'discover'), JSON.stringify(mixes.map(m => m.id + ' new ' + m.new)));
  check('Server Mix from your music server', mixes.some(m => m.id === 'server' && m.n >= 2));
  const d1 = mixes.find(m => m.id === 'daily-1');
  check('Smart shuffle: no artist twice in a row', d1 && d1.arts.every((a, i) => i === 0 || a !== d1.arts[i - 1]), d1 && d1.arts.join(' | '));
  check('Mixes page shows the mixes', await p.locator('.card', { hasText: 'Daily Mix 1' }).count() === 1);
  await p.locator('.card', { hasText: 'Daily Mix 1' }).click(); await sleep(800);
  check('A mix opens and can be saved to your library', await p.getByRole('button', { name: 'Save to library' }).isVisible());
  await p.evaluate(() => { location.hash = '#/'; }); await sleep(1500);
  check('Home shows "Made for you"', await p.isVisible('text=Made for you'));
  check('No JavaScript errors', !errs.length, errs.join(' | '));
  const failed = results.filter(r => r[0] === 'FAIL').length;
  for (const r of results) console.log(r[0], '-', r[1], r[0] === 'FAIL' ? '→ ' + r[2] : '');
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await b.close(); process.exit(failed ? 1 : 0);
})().catch(e => { for (const r of results) console.log(r[0], '-', r[1], r[0] === 'FAIL' ? '→ ' + r[2] : ''); console.error('CRASH [server-mixes]', e.message.slice(0, 800)); process.exit(1); });
