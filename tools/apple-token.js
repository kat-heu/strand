#!/usr/bin/env node
// Generates an Apple MusicKit developer token (ES256 JWT) — no dependencies.
// Usage: node tools/apple-token.js AuthKey_ABC123.p8 ABC123 TEAMID [days=180] [origin]
// Keep the .p8 file private. Never ship it inside the app.
const fs = require('fs');
const crypto = require('crypto');

const [keyPath, keyId, teamId, days = '180', origin] = process.argv.slice(2);
if (!keyPath || !keyId || !teamId) {
  console.error('Usage: node tools/apple-token.js <AuthKey.p8> <KEY_ID> <TEAM_ID> [days<=180] [origin e.g. http://127.0.0.1:5173]');
  process.exit(1);
}
const b64 = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
const payload = { iss: teamId, iat: now, exp: now + Math.min(180, Number(days)) * 86400 };
if (origin) payload.origin = origin.split(',');
const data = `${b64(header)}.${b64(payload)}`;
const sig = crypto.sign('sha256', Buffer.from(data), { key: fs.readFileSync(keyPath), dsaEncoding: 'ieee-p1363' });
console.log(`${data}.${sig.toString('base64url')}`);
