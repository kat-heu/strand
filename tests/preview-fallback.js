// iTunes unreachable on a phone -> preview comes from Deezer
const { chromium, devices } = require('playwright'); const fs = require('fs');
function wav(sec = 2, rate = 8000) {
  const n = sec * rate, buf = Buffer.alloc(44 + n);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34); buf.write('data', 36); buf.writeUInt32LE(n, 40); buf.fill(128, 44);
  return buf;
}
(async () => {
  const { start } = require(require('path').join(__dirname, '..', 'server.js')); await start(5197);
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ ...devices['iPhone 13'] });
  const cfg = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'config.js'), 'utf8').replace(/supabase(Url|Key): '[^']*'/g, "supabase$1: ''");
  await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: cfg }));
  await ctx.route('https://itunes.apple.com/**', r => r.fulfill({ status: 403, body: 'rate limited' }));
  await ctx.route(/fonts\.g|lrclib|rss\./, r => r.abort());
  await ctx.route('https://api.deezer.com/**', r => { const cb = new URL(r.request().url()).searchParams.get('callback'); r.fulfill({ contentType: 'text/javascript', body: `${cb}(${JSON.stringify({ data: [{ title: 'Better', duration: 210, preview: 'https://audio.test/dz.wav', artist: { name: 'Khalid' }, album: { cover_xl: '' } }] })})` }); });
  await ctx.route('https://audio.test/**', r => r.fulfill({ contentType: 'audio/wav', body: wav() }));
  const p = await ctx.newPage(); await p.goto('http://127.0.0.1:5197/'); await p.waitForTimeout(1200);
  await p.evaluate(() => strand.player.playQueue([{ key: 'x', title: 'Better', artist: 'Khalid', durationMs: 210000, origin: 'spotify', ids: {} }], 0));
  await p.waitForTimeout(2500);
  const st = await p.evaluate(() => ({ prov: strand.player.state.provider, err: strand.player.state.error, tried: strand.player.state.trying }));
  const ok = st.prov === 'preview' || /Deezer|dz/.test(JSON.stringify(st)) || st.tried === 'preview';
  const reached = await p.evaluate(() => performance.getEntriesByType('resource').some(e => e.name.includes('api.deezer.com')));
  const pass = reached && st.prov === 'preview';
  console.log((pass ? 'PASS' : 'FAIL') + ' - Apple catalogue unreachable: preview is looked up on Deezer instead', JSON.stringify(st));
  console.log(pass ? '1/1 passed' : '0/1 passed');
  await b.close(); process.exit(pass ? 0 : 1);
  await b.close(); process.exit(0);
})();
