'use strict';
// Generates the tray/app icons as PNGs with zero dependencies.
// Run: node scripts/gen-icons.js   (outputs into app/assets/)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// MemBridge "M-bridge" mark, same stroke geometry as the vendored brand
// SVGs (app/assets/brand/membridge-mark-*.svg, viewBox 0 0 32): an M whose
// towers carry a wider crossbar deck, with the V dipping just below it.
// Rendered here as round-capped strokes so the tray icon matches the logo
// exactly at any size.
const SEGS = [
  [9, 11, 9, 22.5],   // left tower
  [9, 11, 16, 18],    // left diagonal
  [16, 18, 23, 11],   // right diagonal
  [23, 11, 23, 22.5], // right tower
  [5, 16.5, 27, 16.5], // bridge deck
];
const STROKE = 3;
const HALF = STROKE / 2;
// mark bounds including the round caps
const BX0 = 5 - HALF, BX1 = 27 + HALF;
const BY0 = 11 - HALF, BY1 = 22.5 + HALF;

function distToSeg(px, py, [x0, y0, x1, y1]) {
  const dx = x1 - x0, dy = y1 - y0;
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

let CRC_TABLE;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function render(scale, [r, g, b]) {
  const size = 16 * scale;
  const margin = scale; // 1px of breathing room per 16px of icon
  const fit = (size - 2 * margin) / (BX1 - BX0);
  const ox = margin, oy = (size - (BY1 - BY0) * fit) / 2;
  const SS = 4; // 4x4 subsamples per pixel for antialiasing
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const mx = BX0 + (x + (sx + 0.5) / SS - ox) / fit;
          const my = BY0 + (y + (sy + 0.5) / SS - oy) / fit;
          for (const s of SEGS) {
            if (distToSeg(mx, my, s) <= HALF) { hit++; break; }
          }
        }
      }
      if (hit) {
        const i = (y * size + x) * 4;
        rgba[i] = r;
        rgba[i + 1] = g;
        rgba[i + 2] = b;
        rgba[i + 3] = Math.round((255 * hit) / (SS * SS));
      }
    }
  }
  return png(size, size, rgba);
}

const outDir = path.join(__dirname, '..', 'app', 'assets');
fs.mkdirSync(outDir, { recursive: true });
// macOS menu bar: black "Template" images auto-adapt to light/dark menu bars
fs.writeFileSync(path.join(outDir, 'trayTemplate.png'), render(1, [0, 0, 0]));
fs.writeFileSync(path.join(outDir, 'trayTemplate@2x.png'), render(2, [0, 0, 0]));
// Windows/Linux tray: brand blue (#3B82F6) reads on light and dark taskbars
fs.writeFileSync(path.join(outDir, 'tray.png'), render(2, [59, 130, 246]));
// app/assets/icon.png is NOT generated: it is the brand app icon, copied from
// docs/brand/png/membridge-app-icon-512.png.
console.log(`icons written to ${outDir}`);
