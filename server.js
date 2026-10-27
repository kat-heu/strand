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
};

function start(port = Number(process.env.PORT) || 5173, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
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
