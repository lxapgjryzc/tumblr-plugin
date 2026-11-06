'use strict';
// Draws the app icon (navy rounded square, white "t") as PNG files, without any image library.
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');

function png(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.22, s = size;
  const inRound = (x, y) => {
    const cx = Math.min(Math.max(x, r), s - r), cy = Math.min(Math.max(y, r), s - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  // the letter: a stem and a cross bar, and a small foot to the right
  const u = s / 16;
  const white = (x, y) => (x >= 6.5 * u && x < 9 * u && y >= 3 * u && y < 12.5 * u)
    || (x >= 4.5 * u && x < 11.5 * u && y >= 5.6 * u && y < 7.6 * u)
    || (x >= 6.5 * u && x < 11.5 * u && y >= 11 * u && y < 13 * u);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const o = (y * s + x) * 4;
    if (!inRound(x + 0.5, y + 0.5)) continue;
    const w = white(x + 0.5, y + 0.5);
    px[o] = w ? 255 : 0x1f; px[o + 1] = w ? 255 : 0x2d; px[o + 2] = w ? 255 : 0x4f; px[o + 3] = 255;
  }
  const raw = Buffer.alloc((s * 4 + 1) * s);
  for (let y = 0; y < s; y++) px.copy(raw, y * (s * 4 + 1) + 1, y * s * 4, (y + 1) * s * 4);
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(s, 0); ihdr.writeUInt32BE(s, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const out = path.join(__dirname, '..', 'src', 'renderer');
fs.writeFileSync(path.join(out, 'icon.png'), png(256));
fs.writeFileSync(path.join(out, 'tray.png'), png(32));
console.log('icons written');
