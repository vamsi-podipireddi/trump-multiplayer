/* ============================================================
   PWA icon generator — no dependencies.

   Draws the TRUMP mark (gold spade on felt green) at every size the
   manifest needs and writes real PNGs via a minimal encoder (zlib is
   the only thing needed: PNG = signature + IHDR + deflated scanlines).
   Run:  node scripts/gen-icons.js
   ============================================================ */
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- minimal PNG encoder (8-bit RGBA, no interlace) ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- the mark: geometry in a 0..1 unit square, sampled 4x4 per pixel ----
const FELT = [13, 77, 46], FELT_EDGE = [8, 48, 29], GOLD = [232, 196, 90];
const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
/* Spade: apex-up triangle, two lobes at its base, trapezoid stem. */
function inSpade(x, y) {
  if (inCircle(x, y, 0.31, 0.58, 0.175) || inCircle(x, y, 0.69, 0.58, 0.175)) return true;
  if (y >= 0.10 && y <= 0.66) {                       // triangle: apex (0.5,0.10) → base y=0.66
    const half = ((y - 0.10) / 0.56) * 0.29;
    if (Math.abs(x - 0.5) <= half) return true;
  }
  if (y >= 0.64 && y <= 0.88) {                       // stem, widening downward
    const half = 0.025 + ((y - 0.64) / 0.24) * 0.115;
    if (Math.abs(x - 0.5) <= half) return true;
  }
  return false;
}
function draw(size, pad) {
  const buf = Buffer.alloc(size * size * 4);
  const S = 4, inset = pad * size, r = size * 0.22; // rounded-square corner radius
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const X = px + (sx + 0.5) / S, Y = py + (sy + 0.5) / S;
        // rounded-square background
        const bx = Math.min(Math.max(X, inset + r), size - inset - r);
        const by = Math.min(Math.max(Y, inset + r), size - inset - r);
        const inBg = X >= inset && X <= size - inset && Y >= inset && Y <= size - inset &&
          ((X - bx) ** 2 + (Y - by) ** 2 <= r * r ||
           (X >= inset + r && X <= size - inset - r) || (Y >= inset + r && Y <= size - inset - r));
        if (!inBg) { continue; }
        // spade in the inner area
        const u = (X - inset) / (size - 2 * inset), v = (Y - inset) / (size - 2 * inset);
        const edge = u < 0.06 || u > 0.94 || v < 0.06 || v > 0.94;
        const col = inSpade(u, v) ? GOLD : (edge ? FELT_EDGE : FELT);
        acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; acc[3] += 255;
      }
      const n = S * S, o = (py * size + px) * 4;
      const cover = acc[3] / (255 * n) || 0;
      buf[o] = cover ? Math.round(acc[0] / (n * cover)) : 0;
      buf[o + 1] = cover ? Math.round(acc[1] / (n * cover)) : 0;
      buf[o + 2] = cover ? Math.round(acc[2] / (n * cover)) : 0;
      buf[o + 3] = Math.round(cover * 255);
    }
  }
  return encodePNG(size, size, buf);
}

const OUT = path.join(__dirname, "..", "app");
const files = [
  ["icon-192.png", 192, 0],       // any: fills the tile
  ["icon-512.png", 512, 0],
  ["icon-maskable-512.png", 512, 0.12], // safe-zone padding for adaptive masks
  ["apple-touch-icon.png", 180, 0],
  ["favicon-32.png", 32, 0],
];
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [name, size, pad] of files) {
    fs.writeFileSync(path.join(OUT, name), draw(size, pad));
    console.log("wrote app/" + name);
  }
}
export { encodePNG, draw, files };
