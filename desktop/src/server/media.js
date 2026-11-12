'use strict';
// Image decoding for the palette and the AI vision check, without Electron's nativeImage: Tumblr's media are
// asked for as JPEG/PNG and decoded in plain JavaScript (jpeg-js, pngjs), scaled down with a box filter.
// Same interface as before: pixels(url, size) → RGBA bytes, dataUrl(url, size) → a JPEG data URL.

const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

const MAX_BYTES = 25 * 1024 * 1024;

function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512, maxResolutionInMP: 120 });
    return { width: img.width, height: img.height, data: img.data };
  }
  if (buf.subarray(1, 4).toString() === 'PNG') {
    const img = PNG.sync.read(buf);
    return { width: img.width, height: img.height, data: img.data };
  }
  throw new Error('image format not readable');
}

// Box-filter downscale so the longest side is at most `size` (never enlarges)
function scale(img, size) {
  const k = Math.min(1, size / Math.max(img.width, img.height));
  if (k >= 1) return img;
  const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = img.width / w, sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * img.width + xx) * 4;
        r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; a += img.data[i + 3]; n++;
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { width: w, height: h, data: out };
}

function makeMedia({ fetchFn = fetch } = {}) {
  async function load(url, size) {
    if (!/^https:\/\/[\w.-]+\.media\.tumblr\.com\//.test(url)) throw new Error('not a Tumblr image');
    const res = await fetchFn(url, { headers: { Accept: 'image/jpeg,image/png;q=0.9' } });
    if (!res.ok) throw new Error('image ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('image too large');
    return scale(decode(buf), size);
  }
  return {
    async pixels(url, size = 64) { return new Uint8ClampedArray((await load(url, size)).data); },
    async dataUrl(url, size = 768) {
      const img = await load(url, size);
      const enc = jpeg.encode({ data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), width: img.width, height: img.height }, 85);
      return 'data:image/jpeg;base64,' + Buffer.from(enc.data).toString('base64');
    },
  };
}

module.exports = { makeMedia, decode, scale };
