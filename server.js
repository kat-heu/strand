// Tiny zero-dependency static server.
// Spotify only accepts loopback redirect URIs on 127.0.0.1 (not "localhost"),
// so both the web dev server and the desktop app serve from http://127.0.0.1:5173/.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

// Desktop sign-in hand-off. The desktop app opens the login page in the user's real
// browser (login pages often refuse to load inside apps). The service redirects the
// browser back to http://127.0.0.1:5173/?code=…&state=…; if that state was registered
// by the app, we keep the code here and the app collects it. Other states fall
// through to the normal web-app flow.
const pending = new Map(); // state -> { code, error, at }
const DONE_PAGE = ok => `<!doctype html><meta charset="utf-8"><title>Strand</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#0c0b10;color:#f3f1f7;font:16px system-ui,sans-serif;text-align:center">
<div><div style="font-size:42px">${ok ? '✓' : '⚠️'}</div><h2 style="margin:8px 0">${ok ? 'Signed in to Strand' : 'Sign-in was cancelled'}</h2>
<p style="color:#a19eb0">You can close this tab and go back to Strand.</p></div>
<script>setTimeout(() => window.close(), 1500)</script>`;

function start(port = Number(process.env.PORT) || 5173, host = '127.0.0.1', opts = {}) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let u;
      try { u = new URL(req.url, 'http://x'); } catch { u = new URL('http://x/'); }
      const state = u.searchParams.get('state') || u.searchParams.get('sb_state');
      if (u.pathname === '/__auth/start' && req.method === 'POST' && state) {
        for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60000) pending.delete(k);
        pending.set(state, { code: null, error: null, at: Date.now() });
        res.writeHead(204); return res.end();
      }
      if (u.pathname === '/__auth/result' && state) {
        const e = pending.get(state);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        if (!e) return res.end(JSON.stringify({ error: 'expired' }));
        if (e.code || e.error) { pending.delete(state); return res.end(JSON.stringify({ code: e.code, error: e.error })); }
        return res.end(JSON.stringify({ pending: true }));
      }
      // Token-style sign-ins (Google) arrive via public/callback.html, which posts them here.
      if (u.pathname === '/__auth/deliver' && req.method === 'POST' && state) {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 20000) req.destroy(); });
        req.on('end', () => {
          const e = pending.get(state);
          if (!e) { res.writeHead(404); return res.end(); }
          let d = {};
          try { d = JSON.parse(body); } catch {}
          if (d.error || !d.access_token) e.error = d.error || 'cancelled';
          else e.code = JSON.stringify({ access_token: d.access_token, expires_in: d.expires_in });
          res.writeHead(204); res.end();
          try { opts.onAuth?.(); } catch {}
        });
        return;
      }
      if (u.pathname === '/' && state && pending.has(state) && (u.searchParams.get('code') || u.searchParams.get('error'))) {
        const e = pending.get(state);
        e.code = u.searchParams.get('code'); e.error = u.searchParams.get('error');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(DONE_PAGE(!!e.code));
        try { opts.onAuth?.(); } catch {}
        return;
      }
      let p;
      try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { p = '/'; }
      if (p === '/') p = '/index.html';
      const file = path.normalize(path.join(ROOT, p));
      if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, data) => {
        if (err) {
          // SPA fallback
          return fs.readFile(path.join(ROOT, 'index.html'), (e2, d2) => {
            res.writeHead(e2 ? 404 : 200, { 'Content-Type': TYPES['.html'] });
            res.end(d2 || 'Not found');
          });
        }
        res.writeHead(200, {
          'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        res.end(data);
      });
    });
    srv.on('error', reject);
    srv.listen(port, host, () => resolve({ srv, url: `http://${host}:${port}/` }));
  });
}

module.exports = { start };

if (require.main === module) {
  start().then(({ url }) => console.log(`\n  Strand is running at ${url}\n  (open exactly this address — Spotify login needs 127.0.0.1)\n`));
}
