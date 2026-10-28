// Phone tests (iPhone-sized, touch): layout, mini player, full-screen player,
// and Spotify on phones (in-Strand by default, or the Spotify app as a remote).
// Run: node tests/mobile.js
const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');
const BASE = 'http://127.0.0.1:5178/';
const results = [];
const check = (name, ok, extra = '') => results.push([ok ? 'PASS' : 'FAIL', name, extra]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = (r, d, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: d === null ? '' : JSON.stringify(d) });

function wav(seconds, freq) {
  const rate = 22050, n = rate * seconds, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(5000 * Math.sin(2 * Math.PI * freq * i / rate)), 44 + i * 2);
  return buf;
}
const TONE = wav(30, 220);

(async () => {
  const { start } = require(path.join(__dirname, '..', 'server.js')); await start(5178);
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ ...devices['iPhone 13'] });
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'public', 'config.js'), 'utf8').replace(/supabase(Url|Key): '[^']*'/g, "supabase$1: ''");
  await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: cfg }));
  const song = i => ({ wrapperType: 'track', trackId: 3000 + i, trackName: ['Glass Hours', 'Neon Rivers', 'Satellite Heart', 'Quiet Engines', 'After the Static'][i % 5], artistName: 'Nova Lane', artistId: 77, collectionId: 500, collectionName: 'Night Drive', artworkUrl100: '', trackTimeMillis: 200000, previewUrl: 'https://audio.test/p' + i + '.wav', trackNumber: i + 1, discNumber: 1, releaseDate: '2024-01-01' });
  await ctx.route('https://itunes.apple.com/**', r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/search') return J(r, { results: [0, 1, 2, 3, 4].map(song) });
    const id = u.searchParams.get('id');
    if (id && id.includes(',')) return J(r, { results: id.split(',').map(x => song(+x - 3000)) });
    return J(r, { results: [{ ...song(0), wrapperType: 'collection' }, ...[0, 1, 2, 3, 4].map(song)] });
  });
  await ctx.route('https://rss.applemarketingtools.com/**', r => J(r, { feed: { results: [0, 1, 2, 3].map(i => ({ id: String(3000 + i) })) } }));
  await ctx.route('https://audio.test/**', r => r.fulfill({ contentType: 'audio/wav', headers: { 'Access-Control-Allow-Origin': '*' }, body: TONE }));
  await ctx.route(/lrclib|fonts\.g/, r => J(r, {}));
  let sdkLoaded = false;
  await ctx.route('https://sdk.scdn.co/**', r => { sdkLoaded = true; r.fulfill({ body: '' }); });
  // Spotify Web API with a phone running the Spotify app
  const sp = { calls: [], playing: null, pos: 0, isPlaying: false };
  const spt = i => ({ id: 's' + i, name: ['Glass Hours', 'Neon Rivers', 'Satellite Heart'][i % 3], uri: 'spotify:track:s' + i, duration_ms: 200000, artists: [{ name: 'Nova Lane' }], album: { name: 'Night Drive', images: [] }, external_ids: {} });
  await ctx.route('https://api.spotify.com/**', r => {
    const u = new URL(r.request().url()); const P = u.pathname.replace('/v1', ''); const m = r.request().method();
    sp.calls.push(m + ' ' + P + u.search);
    if (P === '/me') return J(r, { id: 'kat', display_name: 'Kat' });
    if (P === '/search') {
      const q = u.searchParams.get('q') || ''; const title = (q.match(/track:(.+?) artist:/) || [])[1] || 'Glass Hours';
      const id = 's' + title.toLowerCase().replace(/\W+/g, '');
      return J(r, { tracks: { items: [{ ...spt(0), id, name: title, uri: 'spotify:track:' + id }] } });
    }
    if (P === '/me/player/devices') return J(r, { devices: [{ id: 'phone1', name: 'iPhone', type: 'Smartphone', is_active: false }] });
    if (P === '/me/player/play' && m === 'PUT') { const body = r.request().postData(); if (body) { sp.playing = JSON.parse(body).uris[0]; sp.pos = 0; } sp.isPlaying = true; return r.fulfill({ status: 200, contentType: 'text/plain', body: 'dxSALWBYoZEZpqj' }); } // Spotify now answers play with a plain-text id
    if (P === '/me/player/pause') { sp.isPlaying = false; return J(r, null, 204); }
    if (P === '/me/player/seek') { sp.pos = +u.searchParams.get('position_ms'); return J(r, null, 204); }
    if (P === '/me/player') return J(r, { is_playing: sp.isPlaying, progress_ms: sp.pos, item: sp.playing ? { uri: sp.playing, duration_ms: 200000 } : null });
    if (P === '/me/playlists') return J(r, { items: [], next: null });
    return J(r, { items: [] });
  });

  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERR ' + e.message));
  p.on('dialog', d => { errs.push('NATIVE DIALOG'); d.dismiss(); });
  const S = () => p.evaluate(() => ({ prov: strand.player.state.provider, title: strand.player.state.track?.title, idx: strand.player.state.index, playing: strand.player.state.playing }));
  const noOverflow = () => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('.main').scrollWidth <= document.querySelector('.main').clientWidth + 1);

  await p.goto(BASE); await sleep(1500);
  // ---- layout
  check('Bottom tab bar shown, sidebar hidden', await p.isVisible('#tabbar') && !(await p.isVisible('.sidebar')));
  check('Tab bar has Home, Search, Your music, Library, Settings', (await p.locator('#tabbar a').allTextContents()).join('|') === 'Home|Search|Your music|Library|Settings');
  for (const [hash, name] of [['#/', 'Home'], ['#/search/nova', 'Search'], ['#/me', 'Your music'], ['#/library', 'Library'], ['#/settings', 'Settings'], ['#/album/500', 'Album']]) {
    await p.evaluate(h => { location.hash = h; }, hash); await sleep(900);
    check(`${name} fits the phone screen (no sideways scrolling)`, await noOverflow());
  }
  await p.locator('#tabbar a', { hasText: 'Search' }).tap(); await sleep(500);
  check('Tapping a tab navigates and highlights it', p.url().includes('#/search') && await p.locator('#tabbar a.on', { hasText: 'Search' }).count() === 1);
  await p.evaluate(() => { location.hash = '#/'; }); await sleep(900);
  check('Home shelves scroll sideways like a native app', await p.evaluate(() => { const g = document.querySelector('.v-home .grid'); return getComputedStyle(g).display === 'flex' && g.scrollWidth > g.clientWidth; }));
  await p.evaluate(() => { location.hash = '#/library'; }); await sleep(700);
  check('Top bar: no back button on a tab page', await p.locator('#mtop-back').isHidden());
  await p.evaluate(() => { location.hash = '#/album/500'; }); await sleep(1000);
  check('Top bar: back button on an album', await p.locator('#mtop-back').isVisible());
  await p.locator('#mtop-back').tap(); await sleep(700);
  check('Back button goes back', p.url().includes('#/library'));
  await p.evaluate(() => { location.hash = '#/album/500'; }); await sleep(1000);
  await p.locator('.tracks .row button[title=More]').first().tap(); await sleep(400);
  check('Song menu opens as a bottom sheet with the song name', await p.evaluate(() => { const m = document.getElementById('menu'); const r = m.getBoundingClientRect(); return !m.hidden && m.classList.contains('sheet') && innerHeight - r.bottom < 60 && m.textContent.includes('Glass Hours'); }));
  await p.locator('.sheet-cancel').tap(); await sleep(300);
  check('Cancel closes the sheet', await p.evaluate(() => document.getElementById('menu').hidden && !document.body.classList.contains('menu-open')));

  // ---- mini player + full-screen player
  await p.evaluate(() => { location.hash = '#/album/500'; }); await sleep(1000);
  await p.locator('.row').nth(0).tap(); await sleep(1500);
  let s = await S();
  check('Tapping a song plays it (in Strand, preview)', s.prov === 'preview' && s.playing, JSON.stringify(s));
  check('Mini player shows the song above the tabs', await p.isVisible('#bar') && (await p.textContent('#bar-title')) === s.title);
  const barBox = await p.locator('#bar').boundingBox(), tabBox = await p.locator('#tabbar').boundingBox();
  check('Mini player sits just above the tab bar', barBox.y + barBox.height <= tabBox.y + 1);
  await p.locator('#bar-title').tap(); await sleep(500);
  check('Tapping the mini player opens the full-screen player', await p.evaluate(() => document.body.classList.contains('np-open')) && await p.isVisible('#np-play'));
  const npBox = await p.locator('#panel').boundingBox();
  const vh = await p.evaluate(() => innerHeight);
  check('Full-screen player covers the screen', npBox.y <= 1 && npBox.height >= vh - 1, JSON.stringify(npBox) + ' vh=' + vh);
  await p.locator('#np-play').tap(); await sleep(400);
  check('Big pause button works', !(await S()).playing);
  await p.locator('#np-play').tap(); await sleep(400);
  check('Big play button works', (await S()).playing);
  await p.locator('#np-next').tap(); await sleep(1300);
  check('Next button works', (await S()).idx === 1);
  await sleep(1200);
  check('Progress bar and times update', (await p.textContent('#np-pos')) !== '0:00' || (await p.inputValue('#np-seek')) !== '0');
  check('Lyrics / Up next tabs are in the player', await p.isVisible('.tabs button[data-tab=queue]'));
  await p.locator('#np-close').tap(); await sleep(500);
  check('Chevron closes the player', !(await p.evaluate(() => document.body.classList.contains('np-open'))));
  check('Spotify web player is never loaded on phones', !sdkLoaded);

  // ---- Spotify on phones
  await p.evaluate(() => {
    localStorage.setItem('strand:spotify', JSON.stringify({ access: 'x', refresh: 'r', exp: Date.now() + 3e6, scope: 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative user-library-read user-top-read user-read-recently-played user-follow-read' }));
    localStorage.setItem('strand:spotify:me', JSON.stringify({ id: 'kat', display_name: 'Kat' }));
  });
  await p.reload(); await sleep(1200);
  await p.evaluate(() => { location.hash = '#/album/500'; }); await sleep(1000);
  await p.locator('.row').nth(2).tap(); await sleep(1500);
  s = await S();
  check('No YouTube set up: Spotify-connected phone plays the full song in the Spotify app (not a 30s preview)', s.prov === 'spotifyRemote' && !sdkLoaded && sp.calls.some(c => c.startsWith('PUT /me/player/play?device_id=phone1')), JSON.stringify(s));
  await p.locator('#bar-title').tap(); await sleep(500);
  check('Player offers "Play in Strand instead"', await p.locator('#np-source button', { hasText: 'Play in Strand instead' }).isVisible());
  await p.locator('#np-source button', { hasText: 'Play in Strand instead' }).tap(); await sleep(1500);
  s = await S();
  check('"Play in Strand instead" plays it in Strand and pauses Spotify', s.prov === 'preview' && sp.isPlaying === false, JSON.stringify(s));
  check('"Play in Spotify app" button shown in the player', await p.locator('#np-source button', { hasText: 'Play in Spotify app' }).isVisible());
  await p.locator('#np-source button', { hasText: 'Play in Spotify app' }).tap(); await sleep(2000);
  s = await S();
  check('Song moves to the Spotify app', s.prov === 'spotifyRemote' && sp.playing === 'spotify:track:ssatelliteheart', JSON.stringify(s) + ' ' + sp.calls.filter(c => c.includes('player')).join(','));
  check('Player shows it is playing in the Spotify app', (await p.textContent('#np-source')).includes('Spotify app'));
  await p.locator('#np-play').tap(); await sleep(500);
  check('Pause in Strand pauses the Spotify app', sp.isPlaying === false && sp.calls.some(c => c.startsWith('PUT /me/player/pause')));
  await p.locator('#np-play').tap(); await sleep(500);
  check('Play in Strand resumes the Spotify app', sp.isPlaying === true);
  await p.evaluate(() => strand.player.seek(60000)); await sleep(300);
  check('Seeking moves the Spotify app', sp.pos === 60000);
  // song ends in the Spotify app -> Strand moves to the next song
  const idxBefore = (await S()).idx;
  sp.pos = 198000; await sleep(2600);
  sp.isPlaying = false; sp.pos = 0; sp.playing = 'spotify:track:other'; await sleep(4500);
  check('When the song ends in Spotify, Strand plays the next one', (await S()).idx === idxBefore + 1, JSON.stringify(await S()));
  // setting: always use the Spotify app
  await p.locator('#np-close').tap(); await sleep(300);
  await p.evaluate(() => { location.hash = '#/settings'; }); await sleep(800);
  await p.selectOption('select:has(option[value=app])', 'app'); await sleep(300);
  await p.evaluate(() => { location.hash = '#/album/500'; }); await sleep(1000);
  await p.locator('.row').nth(1).tap(); await sleep(2000);
  check('Setting "In the Spotify app" plays there straight away', (await S()).prov === 'spotifyRemote');

  // ---- long list on a phone
  await p.evaluate(() => import('/js/store.js').then(m => { m.library.playlists.unshift({ id: 'big', name: 'Big', tracks: [...Array(3000)].map((_, i) => ({ key: 'm' + i, title: 'Track ' + i, artist: 'A', artwork: '', durationMs: 1, origin: 'catalog', ids: {} })), created: 1 }); m.saveLibrary(); }));
  await p.evaluate(() => { location.hash = '#/playlist/big'; }); await sleep(800);
  check('3,000-song playlist on a phone draws only visible rows', (await p.locator('.tracks.virtual .row').count()) < 80);
  check('…and still fits the screen', await noOverflow());
  check('Top bar is clear at the top of a page', await p.evaluate(() => !document.getElementById('mtop').classList.contains('solid')));
  await p.evaluate(() => document.querySelector('.main').scrollTo(0, 1500)); await sleep(300);
  check('Top bar shows the playlist name after scrolling', await p.evaluate(() => document.getElementById('mtop').classList.contains('solid') && document.getElementById('mtop-title').textContent === 'Big'));

  // ---- the phone version updates itself
  let ver = 'aaa111';
  await ctx.route('**/version.json*', r => J(r, { version: ver }));
  const u = await ctx.newPage();
  await u.goto(BASE); await sleep(1500);
  await u.evaluate(() => { window.__marker = 1; });
  await u.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await sleep(800);
  check('No reload when the version is unchanged', await u.evaluate(() => window.__marker === 1));
  ver = 'bbb222';
  await u.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await sleep(2000);
  check('Opening the app after an update loads the new version', await u.evaluate(() => window.__marker === undefined));
  await u.evaluate(() => { location.hash = '#/settings'; }); await sleep(800);
  check('Settings shows the running version', (await u.textContent('#web-version')).includes('Version bbb222'));
  await u.locator('#web-version button', { hasText: 'Check connections' }).tap(); await sleep(11000);
  check('Connection check lists every service with a result', await u.evaluate(() => { const r = [...document.querySelectorAll('.diag-row')]; return r.length === 8 && r.every(x => !x.textContent.includes('checking…')); }), await u.textContent('#web-version'));
  await u.close();

  check('No JavaScript errors', errs.length === 0, errs.join(' | '));
  const failed = results.filter(r => r[0] === 'FAIL').length;
  for (const r of results) console.log(r[0], '-', r[1], r[0] === 'FAIL' ? '→ ' + r[2] : '');
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await p.evaluate(() => { location.hash = '#/'; }); await sleep(800);
  try { fs.mkdirSync(path.join(__dirname, '..', 'test-results'), { recursive: true }); await p.screenshot({ path: path.join(__dirname, '..', 'test-results', 'mobile-home.png') }); } catch {}
  await b.close(); process.exit(failed ? 1 : 0);
})().catch(e => { for (const r of results) console.log(r[0], '-', r[1], r[0] === 'FAIL' ? '→ ' + r[2] : ''); console.error('CRASH', e.message.slice(0, 1500)); process.exit(1); });
