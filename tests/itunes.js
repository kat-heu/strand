// iTunes library sync: on the web (pick the exported file) and in the desktop app
// (finds the library itself and plays songs from their files).
const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs'); const os = require('os');
const results = []; const check = (n, ok, info = '') => results.push([ok ? 'PASS' : 'FAIL', n, info]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const track = (id, name, artist, album, ms, loc, extra = '') => `<key>${id}</key><dict><key>Track ID</key><integer>${id}</integer><key>Name</key><string>${name}</string><key>Artist</key><string>${artist}</string><key>Album</key><string>${album}</string><key>Kind</key><string>MPEG audio file</string><key>Total Time</key><integer>${ms}</integer><key>Persistent ID</key><string>P${id}</string><key>Track Type</key><string>File</string><key>Location</key><string>${loc}</string>${extra}</dict>`;
const XML = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Major Version</key><integer>1</integer><key>Tracks</key><dict>
${track(101, 'Glass Hours', 'Nova Lane', 'Night Drive', 200000, 'file://localhost/C:/Users/Kat/Music/iTunes/Nova%20Lane/Glass%20Hours.mp3')}
${track(102, 'Neon Rivers', 'Ivy Marlow', 'Night Drive', 190000, 'file:///Users/kat/Music/Neon%20Rivers.m4a')}
${track(103, 'Some Movie', 'Studio', '', 6000000, 'file:///Users/kat/Movies/x.m4v', '<key>Has Video</key><true/>')}
${track(104, 'Protected Song', 'Apple Artist', 'AM', 180000, 'file:///Users/kat/Music/p.m4p', '<key>Protected</key><true/>')}
</dict><key>Playlists</key><array>
<dict><key>Name</key><string>Library</string><key>Master</key><true/><key>Playlist ID</key><integer>1</integer><key>Playlist Items</key><array><dict><key>Track ID</key><integer>101</integer></dict></array></dict>
<dict><key>Name</key><string>Music</string><key>Distinguished Kind</key><integer>4</integer><key>Playlist ID</key><integer>2</integer><key>Playlist Items</key><array><dict><key>Track ID</key><integer>101</integer></dict></array></dict>
<dict><key>Name</key><string>Road Trip</string><key>Playlist ID</key><integer>3</integer><key>Playlist Persistent ID</key><string>RT1</string><key>Playlist Items</key><array><dict><key>Track ID</key><integer>102</integer></dict><dict><key>Track ID</key><integer>101</integer></dict><dict><key>Track ID</key><integer>103</integer></dict></array></dict>
</array></dict></plist>`;

function wav(sec = 3, rate = 8000) {
  const n = sec * rate, b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); b.fill(128, 44);
  return b;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strand-itl-'));
  const xmlFile = path.join(dir, 'Library.xml'); fs.writeFileSync(xmlFile, XML);
  const { start } = require(path.join(__dirname, '..', 'server.js')); await start(5175);
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'public', 'config.js'), 'utf8').replace(/supabase(Url|Key): '[^']*'/g, "supabase$1: ''").replace(/youtubeKey: '[^']*'/, "youtubeKey: ''");
  const setup = async ctx => {
    await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: cfg }));
    await ctx.route(/itunes\.apple\.com/, r => r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ results: [{ wrapperType: 'track', trackId: 1, trackName: 'Glass Hours', artistName: 'Nova Lane', collectionName: 'Night Drive', artworkUrl100: '', trackTimeMillis: 200000, previewUrl: 'https://audio.test/p.wav' }] }) }));
    await ctx.route(/rss\.apple|lrclib/, r => r.fulfill({ contentType: 'application/json', body: '{}' }));
    await ctx.route(/fonts\.g|deezer/, r => r.abort());
    await ctx.route('https://audio.test/**', r => r.fulfill({ contentType: 'audio/wav', body: wav() }));
  };

  // ---- web: choose the exported library file
  const ctx = await b.newContext({ viewport: { width: 1300, height: 850 } }); await setup(ctx);
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:5175/#/library'); await sleep(1000);
  await p.getByRole('link', { name: 'Sync iTunes' }).click(); await sleep(600);
  const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.getByRole('button', { name: 'Choose iTunes library file' }).click()]);
  await fc.setFiles(xmlFile); await sleep(1500);
  const d = await p.evaluate(() => import('/js/itunes.js').then(m => { const x = m.itunesData(); return x && { songs: Object.values(x.tracks).map(t => t.title), pls: x.playlists.map(q => q.name + ':' + q.keys.length), files: Object.values(x.tracks).map(t => t.ids.itunesFile || '') }; }));
  check('Songs come in (videos skipped)', d && d.songs.length === 3 && !d.songs.includes('Some Movie'), JSON.stringify(d));
  check('Your playlists come in (iTunes’ built-in lists skipped)', d && JSON.stringify(d.pls) === JSON.stringify(['Road Trip:2']), JSON.stringify(d?.pls));
  check('Windows and Mac file locations understood', d?.files.includes('C:\\Users\\Kat\\Music\\iTunes\\Nova Lane\\Glass Hours.mp3') && d?.files.includes('/Users/kat/Music/Neon Rivers.m4a'), JSON.stringify(d?.files));
  check('Protected Apple Music downloads aren’t treated as playable files', d?.files.filter(Boolean).length === 2);
  await p.evaluate(() => { location.hash = '#/library'; }); await sleep(800);
  check('Library shows "From iTunes" with the playlist', await p.isVisible('text=From iTunes') && await p.locator('.card', { hasText: 'Road Trip' }).count() === 1);
  await p.locator('.card', { hasText: 'Road Trip' }).click(); await sleep(800);
  check('Playlist opens with its songs in order', (await p.locator('.tracks .row .t, .tracks .row').allTextContents()).join('|').indexOf('Neon Rivers') < (await p.locator('.tracks .row').allTextContents()).join('|').indexOf('Glass Hours'));
  await p.locator('.row', { hasText: 'Glass Hours' }).dblclick(); await sleep(2000);
  let s = await p.evaluate(() => ({ prov: strand.player.state.provider }));
  check('On the web an iTunes song plays from a streaming source', !!s.prov && s.prov !== 'itunes', JSON.stringify(s));
  await p.reload(); await sleep(1000);
  check('Still there after reopening Strand', await p.evaluate(() => import('/js/itunes.js').then(m => !!m.itunesData())));
  await p.evaluate(() => { location.hash = '#/itunes/itl-RT1'; }); await sleep(600);
  await p.getByRole('button', { name: 'Save to library' }).click(); await sleep(400);
  check('"Save to library" copies it into your Strand library (shows on other devices)', await p.evaluate(() => strand.library.playlists.some(x => x.name === 'Road Trip' && x.tracks.length === 2)));
  check('No JavaScript errors (web)', errs.length === 0, errs.join(' | '));

  // ---- desktop app: finds the library itself, plays from the files
  const c2 = await b.newContext({ viewport: { width: 1300, height: 850 } }); await setup(c2);
  await c2.addInitScript(xml => {
    window.__allowed = null;
    window.strandDesktop = { getVersion: async () => '0.1.20', getUpdateStatus: async () => ({ state: 'latest' }), checkForUpdates: async () => ({ state: 'latest' }), installUpdate() {}, openUpdateLog() {}, onUpdateStatus: () => () => {},
      itunes: { findLibrary: async () => ({ path: 'C:\\Users\\Kat\\Music\\iTunes\\iTunes Library.xml', xml }), pickLibrary: async () => null, allow: async f => { window.__allowed = f; return f.length; } } };
  }, XML);
  const q = await c2.newPage(); const errs2 = []; q.on('pageerror', e => errs2.push(e.message));
  await q.goto('http://127.0.0.1:5175/#/settings'); await sleep(1000);
  await q.locator('#itunes').getByRole('button', { name: 'Sync iTunes library' }).click(); await sleep(1500);
  check('Desktop: finds the iTunes library on the computer by itself', await q.evaluate(() => import('/js/itunes.js').then(m => m.itunesData()?.playlists.length === 1)));
  check('Desktop: only the library’s song files are allowed to play', await q.evaluate(() => JSON.stringify(window.__allowed)) === JSON.stringify(['C:\\Users\\Kat\\Music\\iTunes\\Nova Lane\\Glass Hours.mp3', '/Users/kat/Music/Neon Rivers.m4a']), await q.evaluate(() => JSON.stringify(window.__allowed)));
  await q.evaluate(() => { location.hash = '#/itunes/itl-all'; }); await sleep(800);
  await q.locator('.row', { hasText: 'Glass Hours' }).dblclick(); await sleep(2500);
  const lg = await q.evaluate(() => import('/js/log.js').then(m => m.logLines().join('\n')));
  check('Desktop: an iTunes song is played from its file first', /order":\["itunes"/.test(lg), lg.split('\n').slice(-4).join(' / '));
  check('No JavaScript errors (desktop)', errs2.length === 0, errs2.join(' | '));

  const failed = results.filter(r => r[0] === 'FAIL').length;
  for (const r of results) console.log(r[0], '-', r[1], r[0] === 'FAIL' ? '→ ' + r[2] : '');
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await b.close(); process.exit(failed ? 1 : 0);
})().catch(e => { for (const r of results) console.log(r[0], '-', r[1], r[0] === 'FAIL' ? '→ ' + r[2] : ''); console.error('CRASH [' + require('path').basename(__filename) + ' after ' + results.length + ' checks: ' + (results[results.length - 1] || [])[1] + ']', e.message.slice(0, 800)); process.exit(1); });
