// 程序化生成 BDrive PWA 图标（仅用 Node 内置 zlib，无外部依赖）
// 用法: node scripts/gen-icons.cjs
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'static', 'icons');
fs.mkdirSync(OUT, { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// 对角渐变取色
function grad(x, y, size) {
  const t = Math.max(0, Math.min(1, (x / size) * 0.6 + (y / size) * 0.4));
  // #3b82f6 (59,130,246) -> #6366f1 (99,102,241) -> #8b5cf6 (139,92,246)
  const a = [59, 130, 246], b = [99, 102, 241], c2 = [139, 92, 246];
  let r, g, bl;
  if (t < 0.55) { const k = t / 0.55; r = a[0] + (b[0] - a[0]) * k; g = a[1] + (b[1] - a[1]) * k; bl = a[2] + (b[2] - a[2]) * k; }
  else { const k = (t - 0.55) / 0.45; r = b[0] + (c2[0] - b[0]) * k; g = b[1] + (c2[1] - b[1]) * k; bl = b[2] + (c2[2] - b[2]) * k; }
  return [Math.round(r), Math.round(g), Math.round(bl)];
}

// 云朵形状：圆盘并集 + 底部圆角矩形
function inCloud(px, py, size) {
  const cx = size * 0.5, cy = size * 0.52;
  const u = size / 100;
  const discs = [
    [-17, 6, 16], [17, 6, 16], [0, -8, 21], [-7, 13, 14], [9, 14, 13],
  ];
  for (const [dx, dy, rr] of discs) {
    const ddx = px - (cx + dx * u), ddy = py - (cy + dy * u);
    if (ddx * ddx + ddy * ddy <= (rr * u) * (rr * u)) return true;
  }
  // 底部圆角基座
  const x0 = cx - 22 * u, x1 = cx + 22 * u, y0 = cy - 2 * u, y1 = cy + 17 * u, rad = 9 * u;
  if (px >= x0 && px <= x1 && py >= y0 && py <= y1) {
    const insideFlat = py <= y1 - rad || (px >= x0 + rad && px <= x1 - rad);
    let cornerOk = true;
    if (py > y1 - rad) {
      let near = false;
      for (const [ccx, ccy] of [[x0 + rad, y1 - rad], [x1 - rad, y1 - rad]]) {
        const ddx = px - ccx, ddy = py - ccy;
        if (ddx * ddx + ddy * ddy <= rad * rad) near = true;
      }
      cornerOk = near;
    }
    if (insideFlat || cornerOk) return true;
  }
  return false;
}

function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = grad(x, y, size);
      let rr = r, gg = g, bb = b, aa = 255;
      if (inCloud(x, y, size)) { rr = 255; gg = 255; bb = 255; }
      const i = (y * size + x) * 4;
      buf[i] = rr; buf[i + 1] = gg; buf[i + 2] = bb; buf[i + 3] = aa;
    }
  }
  return encodePng(size, buf);
}

for (const s of [192, 512]) {
  fs.writeFileSync(path.join(OUT, `icon-${s}.png`), draw(s));
  console.log('wrote icon-' + s + '.png');
}
// apple-touch 180
fs.writeFileSync(path.join(OUT, 'apple-touch-icon.png'), draw(180));
console.log('wrote apple-touch-icon.png');
