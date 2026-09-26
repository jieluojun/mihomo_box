// ============================================================
// 极简 QR 码生成器（字节模式，纠错等级 L/M，版本 1–20）
// 只为「浏览器访问地址」生成可扫描的二维码，故不引入第三方库。
// 输出为内联 SVG，离线可用、随主题缩放。
// ============================================================

// ---- GF(256) 运算表（生成多项式 0x11d）----
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gmul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

// 生成多项式
function rsPoly(deg) {
  let poly = [1];
  for (let i = 0; i < deg; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gmul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsPoly(ecLen);
  const res = new Array(ecLen).fill(0);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0];
    res.shift();
    res.push(0);
    for (let j = 0; j < ecLen; j++) res[j] ^= gmul(gen[j + 1], factor);
  }
  return res;
}

// ---- 版本参数表：[总码字数, ecPerBlock, group1块数, group1数据码字, group2块数, group2数据码字] ----
// 仅收录 L / M 两级、版本 1–20（足够放下一条带令牌的 URL）
const RS_L = {
  1: [26, 7, 1, 19, 0, 0], 2: [44, 10, 1, 34, 0, 0], 3: [70, 15, 1, 55, 0, 0],
  4: [100, 20, 1, 80, 0, 0], 5: [134, 26, 1, 108, 0, 0], 6: [172, 18, 2, 68, 0, 0],
  7: [196, 20, 2, 78, 0, 0], 8: [242, 24, 2, 97, 0, 0], 9: [292, 30, 2, 116, 0, 0],
  10: [346, 18, 2, 68, 2, 69], 11: [404, 20, 4, 81, 0, 0], 12: [466, 24, 2, 92, 2, 93],
  13: [532, 26, 4, 107, 0, 0], 14: [581, 30, 3, 115, 1, 116], 15: [655, 22, 5, 87, 1, 88],
  16: [733, 24, 5, 98, 1, 99], 17: [815, 28, 1, 107, 5, 108], 18: [901, 30, 5, 120, 1, 121],
  19: [991, 28, 3, 113, 4, 114], 20: [1085, 28, 3, 107, 5, 108],
};
const RS_M = {
  1: [26, 10, 1, 16, 0, 0], 2: [44, 16, 1, 28, 0, 0], 3: [70, 26, 1, 44, 0, 0],
  4: [100, 18, 2, 32, 0, 0], 5: [134, 24, 2, 43, 0, 0], 6: [172, 16, 4, 27, 0, 0],
  7: [196, 18, 4, 31, 0, 0], 8: [242, 22, 2, 38, 2, 39], 9: [292, 22, 3, 36, 2, 37],
  10: [346, 26, 4, 43, 1, 44], 11: [404, 30, 1, 50, 4, 51], 12: [466, 22, 6, 36, 2, 37],
  13: [532, 22, 8, 37, 1, 38], 14: [581, 24, 4, 40, 5, 41], 15: [655, 24, 5, 41, 5, 42],
  16: [733, 28, 7, 45, 3, 46], 17: [815, 28, 10, 46, 1, 47], 18: [901, 26, 9, 43, 4, 44],
  19: [991, 26, 3, 44, 11, 45], 20: [1085, 26, 3, 41, 13, 42],
};
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50], 11: [6, 30, 54],
  12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66], 15: [6, 26, 48, 70],
  16: [6, 26, 50, 74], 17: [6, 30, 54, 78], 18: [6, 30, 56, 82], 19: [6, 30, 58, 86],
  20: [6, 34, 62, 90],
};

// 格式信息（含 BCH + 掩码 0x5412），索引 = ecBits<<3 | mask
const FMT_EC = { L: 0b01, M: 0b00 };
function formatBits(ecLevel, mask) {
  const data = (FMT_EC[ecLevel] << 3) | mask;
  let v = data << 10;
  for (let i = 4; i >= 0; i--) if (v & (1 << (i + 10))) v ^= 0x537 << i;
  return ((data << 10) | v) ^ 0x5412;
}
function versionBits(ver) {
  let v = ver << 12;
  for (let i = 5; i >= 0; i--) if (v & (1 << (i + 12))) v ^= 0x1f25 << i;
  return (ver << 12) | v;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => ((((r * c) % 2) + ((r * c) % 3)) % 2) === 0,
  (r, c) => ((((r + c) % 2) + ((r * c) % 3)) % 2) === 0,
];

// 选一个能装下的最小版本
function pickVersion(byteLen, ecLevel) {
  const tbl = ecLevel === 'L' ? RS_L : RS_M;
  for (let v = 1; v <= 20; v++) {
    const [, ec, g1, d1, g2, d2] = tbl[v];
    const dataCw = g1 * d1 + g2 * d2;
    const lenBits = v < 10 ? 8 : 16;
    if (dataCw * 8 >= 4 + lenBits + byteLen * 8) return v;
  }
  return 0;
}

function buildCodewords(bytes, ver, ecLevel) {
  const tbl = ecLevel === 'L' ? RS_L : RS_M;
  const [, ecLen, g1, d1, g2, d2] = tbl[ver];
  const dataCw = g1 * d1 + g2 * d2;
  const lenBits = ver < 10 ? 8 : 16;

  // 位流：模式(0100) + 长度 + 数据 + 终止符 + 补齐
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, lenBits);
  bytes.forEach(b => push(b, 8));
  const cap = dataCw * 8;
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const pads = [0xec, 0x11];
  let pi = 0;
  while (bits.length < cap) { push(pads[pi++ % 2], 8); }

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }

  // 分块 + 交织
  const blocks = [];
  let off = 0;
  for (let i = 0; i < g1; i++) { blocks.push(data.slice(off, off + d1)); off += d1; }
  for (let i = 0; i < g2; i++) { blocks.push(data.slice(off, off + d2)); off += d2; }
  const ecBlocks = blocks.map(b => rsEncode(b, ecLen));

  const out = [];
  const maxData = Math.max(...blocks.map(b => b.length));
  for (let i = 0; i < maxData; i++) blocks.forEach(b => { if (i < b.length) out.push(b[i]); });
  for (let i = 0; i < ecLen; i++) ecBlocks.forEach(b => out.push(b[i]));
  return out;
}

// 罚分（ISO/IEC 18004 §8.8.2），用于挑最优掩码
function penalty(m, size) {
  let score = 0;
  // 规则 1：同色连续 ≥5
  for (let i = 0; i < size; i++) {
    for (const dir of [0, 1]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const a = dir ? m[j - 1][i] : m[i][j - 1];
        const b = dir ? m[j][i] : m[i][j];
        if (a === b) { run++; } else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
    }
  }
  // 规则 2：2×2 同色
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = m[r][c];
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
  }
  // 规则 3：1:1:3:1:1 类似定位图形
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const match = (arr, s, pat) => pat.every((p, k) => arr[s + k] === p);
  for (let i = 0; i < size; i++) {
    const row = m[i], col = m.map(r => r[i]);
    for (let s = 0; s + 11 <= size; s++) {
      if (match(row, s, pat1) || match(row, s, pat2)) score += 40;
      if (match(col, s, pat1) || match(col, s, pat2)) score += 40;
    }
  }
  // 规则 4：黑白比例偏离 50%
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

// 生成模块矩阵（true=黑）。text 会按 UTF-8 编码。
export function qrMatrix(text, ecLevel = 'M') {
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  let ver = pickVersion(bytes.length, ecLevel);
  if (!ver && ecLevel === 'M') { ecLevel = 'L'; ver = pickVersion(bytes.length, 'L'); }
  if (!ver) return null;                       // 内容过长，调用方降级为纯文本

  const size = 17 + ver * 4;
  const m = Array.from({ length: size }, () => new Array(size).fill(0));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const put = (r, c, v) => { m[r][c] = v ? 1 : 0; fixed[r][c] = true; };

  // 定位图形 + 分隔符
  const finder = (R, C) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = R + r, cc = C + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                 (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                 (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      put(rr, cc, on);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  // 校正图形
  const ap = ALIGN[ver] || [];
  ap.forEach(r => ap.forEach(c => {
    if ((r <= 7 && c <= 7) || (r <= 7 && c >= size - 8) || (r >= size - 8 && c <= 7)) return;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      put(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  }));

  // 定时图形
  for (let i = 8; i < size - 8; i++) { put(6, i, i % 2 === 0); put(i, 6, i % 2 === 0); }
  put(size - 8, 8, 1);                       // 固定的暗模块

  // 预留格式信息区
  for (let i = 0; i <= 8; i++) {
    if (!fixed[8][i]) put(8, i, 0);
    if (!fixed[i][8]) put(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    if (!fixed[8][size - 1 - i]) put(8, size - 1 - i, 0);
    if (!fixed[size - 1 - i][8]) put(size - 1 - i, 8, 0);
  }
  // 版本信息（版本 ≥7）
  if (ver >= 7) {
    const vb = versionBits(ver);
    for (let i = 0; i < 18; i++) {
      const bit = (vb >> i) & 1;
      put(Math.floor(i / 3), size - 11 + (i % 3), bit);
      put(size - 11 + (i % 3), Math.floor(i / 3), bit);
    }
  }

  // 数据填充（右下起，之字形上下走）
  const cw = buildCodewords(bytes, ver, ecLevel);
  let bitIdx = 0;
  const totalBits = cw.length * 8;
  const nextBit = () => {
    if (bitIdx >= totalBits) return 0;
    const b = (cw[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
    bitIdx++;
    return b;
  };
  let up = true;
  for (let base = size - 1; base > 0; base -= 2) {
    // 垂直定时列（第 6 列）不承载数据：到达它之后所有列整体左移一格。
    // 注意必须用独立变量，直接改循环变量会打乱步长。
    const col = base <= 6 ? base - 1 : base;
    for (let i = 0; i < size; i++) {
      const row = up ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (fixed[row][c]) continue;
        m[row][c] = nextBit();
      }
    }
    up = !up;
  }

  // 选最优掩码
  let best = null, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const t = m.map(r => r.slice());
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (!fixed[r][c] && MASKS[mask](r, c)) t[r][c] ^= 1;
    }
    // 写入格式信息
    const fb = formatBits(ecLevel, mask);
    for (let i = 0; i < 15; i++) {
      const bit = (fb >> i) & 1;
      // 竖排副本（左上角下方 + 左下角）
      if (i < 6) t[i][8] = bit;
      else if (i < 8) t[i + 1][8] = bit;
      else t[size - 15 + i][8] = bit;
      // 横排副本（右上角 + 左上角右侧）
      if (i < 8) t[8][size - 1 - i] = bit;
      else if (i === 8) t[8][15 - i] = bit;
      else t[8][14 - i] = bit;
    }
    t[size - 8][8] = 1;                      // 固定暗模块
    const sc = penalty(t, size);
    if (sc < bestScore) { bestScore = sc; best = t; }
  }
  return best;
}

// 生成内联 SVG 字符串（含静区），前景用 currentColor 以适配深浅色主题
export function qrSvg(text, opts = {}) {
  const mat = qrMatrix(text, opts.ec || 'M');
  if (!mat) return null;
  const n = mat.length;
  const quiet = opts.quiet === undefined ? 4 : opts.quiet;
  const total = n + quiet * 2;
  let path = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!mat[r][c]) { c++; continue; }
      let len = 1;
      while (c + len < n && mat[r][c + len]) len++;
      path += `M${c + quiet} ${r + quiet}h${len}v1h-${len}z`;
      c += len;
    }
  }
  const px = opts.size || 220;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="二维码">`
    + `<rect width="${total}" height="${total}" fill="#fff"/>`
    + `<path d="${path}" fill="#000"/></svg>`;
}
