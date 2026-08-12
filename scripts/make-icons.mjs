// Generates the PWA icons in public/ (committed, regenerate only if the mark
// changes). Hand-rolled PNG encoder so icon generation needs no image
// dependency — the mark is a 2x2 grid of squares on the app's accent blue:
// one square per venture "folder", which is what the OS is.
//
// Usage: node scripts/make-icons.mjs

import { writeFileSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function png(size, pixelFn) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  const stride = 1 + size * 3;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelFn(x / size, y / size);
      const o = y * stride + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const BLUE = [29, 78, 216]; // --accent in styles.css
const WHITE = [255, 255, 255];

// u,v in [0,1). Squares occupy two bands per axis with margins and a gap.
function mark(u, v) {
  const inBand = (t) => (t > 0.2 && t < 0.46) || (t > 0.54 && t < 0.8);
  return inBand(u) && inBand(v) ? WHITE : BLUE;
}

for (const [name, size] of [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180],
]) {
  writeFileSync(join(outDir, name), png(size, mark));
  console.log(`wrote public/${name}`);
}
