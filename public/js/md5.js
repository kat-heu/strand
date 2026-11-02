// Small MD5 (the Subsonic API signs requests with md5(password + salt)).
export function md5(str) {
  const b = new TextEncoder().encode(str);
  const n = ((b.length + 8) >> 6) + 1, w = new Uint32Array(n * 16);
  for (let i = 0; i < b.length; i++) w[i >> 2] |= b[i] << ((i % 4) * 8);
  w[b.length >> 2] |= 0x80 << ((b.length % 4) * 8);
  w[n * 16 - 2] = b.length * 8;
  const K = [], S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let o = 0; o < w.length; o += 16) {
    let [a, bb, c, d] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (bb & c) | (~bb & d); g = i; }
      else if (i < 32) { f = (d & bb) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = bb ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (bb | ~d); g = (7 * i) % 16; }
      const t = d; d = c; c = bb;
      const x = (a + f + K[i] + w[o + g]) >>> 0, s = S[(i >> 4) * 4 + (i % 4)];
      bb = (bb + ((x << s) | (x >>> (32 - s)))) >>> 0; a = t;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + bb) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  return [a0, b0, c0, d0].map(v => [0, 8, 16, 24].map(s => ((v >>> s) & 255).toString(16).padStart(2, '0')).join('')).join('');
}
