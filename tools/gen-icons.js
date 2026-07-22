/*
 * gen-icons.js — generates the extension PNG icons with no dependencies.
 * Renders a clock glyph on a rounded indigo tile, supersampled for smooth
 * edges, and encodes PNGs using Node's built-in zlib. Run: `node tools/gen-icons.js`.
 */
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const BG = [79, 70, 229];      // indigo tile
const FACE = [255, 255, 255];  // clock face
const HAND = [28, 37, 48];     // hands / ticks

function lerp(a, b, t) { return a + (b - a) * t; }
function mix(dst, src, alpha) {
  for (let i = 0; i < 3; i++) dst[i] = Math.round(lerp(dst[i], src[i], alpha));
  dst[3] = Math.max(dst[3], Math.round(alpha * 255));
}

// Signed-distance helpers (negative = inside).
function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdSegment(px, py, ax, ay, bx, by, half) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t)) - half;
}

function render(size) {
  const ss = 4;                 // supersample factor
  const S = size * ss;
  const buf = new Array(S * S);
  for (let i = 0; i < buf.length; i++) buf[i] = [0, 0, 0, 0];

  const c = S / 2;
  const faceR = S * 0.34;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5, py = y + 0.5;
      const p = buf[y * S + x];
      const aa = ss; // coverage softening in device px

      // Rounded tile.
      let d = sdRoundRect(px, py, c, c, S * 0.5, S * 0.5, S * 0.22);
      mix(p, BG, clamp01(0.5 - d / aa));

      // White face.
      d = sdCircle(px, py, c, c, faceR);
      mix(p, FACE, clamp01(0.5 - d / aa));

      // Tick marks at 12/3/6/9.
      for (let k = 0; k < 4; k++) {
        const ang = k * Math.PI / 2;
        const rx = c + Math.sin(ang) * faceR * 0.82;
        const ry = c - Math.cos(ang) * faceR * 0.82;
        const rx2 = c + Math.sin(ang) * faceR * 0.62;
        const ry2 = c - Math.cos(ang) * faceR * 0.62;
        d = sdSegment(px, py, rx, ry, rx2, ry2, S * 0.018);
        mix(p, HAND, clamp01(0.5 - d / aa));
      }

      // Minute hand (points to 2 o'clock) and hour hand (points to 10).
      d = sdSegment(px, py, c, c,
        c + Math.sin(Math.PI / 3) * faceR * 0.72,
        c - Math.cos(Math.PI / 3) * faceR * 0.72, S * 0.026);
      mix(p, HAND, clamp01(0.5 - d / aa));
      d = sdSegment(px, py, c, c,
        c - Math.sin(Math.PI / 4) * faceR * 0.5,
        c - Math.cos(Math.PI / 4) * faceR * 0.5, S * 0.032);
      mix(p, HAND, clamp01(0.5 - d / aa));

      // Center hub.
      d = sdCircle(px, py, c, c, S * 0.04);
      mix(p, HAND, clamp01(0.5 - d / aa));
    }
  }

  // Downsample by box filter.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const p = buf[(y * ss + sy) * S + (x * ss + sx)];
          r += p[0]; g += p[1]; b += p[2]; a += p[3];
        }
      }
      const n = ss * ss;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// --- Minimal PNG encoder ---------------------------------------------------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const outDir = path.join(__dirname, "..", "icons");
fs.mkdirSync(outDir, { recursive: true });
[16, 48, 128].forEach(function (s) {
  const png = encodePNG(render(s), s);
  fs.writeFileSync(path.join(outDir, "icon" + s + ".png"), png);
  console.log("wrote icons/icon" + s + ".png (" + png.length + " bytes)");
});
