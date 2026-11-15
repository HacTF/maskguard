/* Regenerate extension icons without external dependencies: node tests/make-icons.js */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'icons');
const GREEN = [22, 163, 74];
const WHITE = [255, 255, 255];

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(size, rgba) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function build(size) {
  const r = Math.max(2, size * 0.20);
  const bars = [[0.30, 0.60], [0.46, 0.44], [0.62, 0.54]];
  const barH = Math.max(1, size * 0.095);
  const inRound = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  };
  const inBars = (x, y) => bars.some(([top, width]) => {
    const y0 = size * top, x0 = (size - size * width) / 2;
    return y >= y0 && y <= y0 + barH && x >= x0 && x <= x0 + size * width;
  });

  const rgba = Buffer.alloc(size * size * 4);
  const samples = 4, total = samples * samples;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let green = 0, white = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;
          if (inRound(px, py)) { green++; if (inBars(px, py)) white++; }
        }
      }
      const i = (y * size + x) * 4;
      if (!green) continue;
      const f = white / green;
      rgba[i] = Math.round(GREEN[0] + (WHITE[0] - GREEN[0]) * f);
      rgba[i + 1] = Math.round(GREEN[1] + (WHITE[1] - GREEN[1]) * f);
      rgba[i + 2] = Math.round(GREEN[2] + (WHITE[2] - GREEN[2]) * f);
      rgba[i + 3] = Math.round(255 * green / total);
    }
  }
  return encodePNG(size, rgba);
}

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
[16, 32, 48, 128].forEach(s => {
  const file = path.join(OUT, 'icon' + s + '.png');
  fs.writeFileSync(file, build(s));
  console.log('wrote', file, fs.statSync(file).size, 'bytes');
});
