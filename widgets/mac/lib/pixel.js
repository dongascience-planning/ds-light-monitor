// 픽셀 캔버스 + 의존성0 PNG 인코더.
// 곡선(원/호)은 장치픽셀 커버리지로 안티에일리어싱 → 작아도 매끈(RunCat 느낌).
// 사각/디테일 점은 crisp 블록 유지.
import zlib from "node:zlib";
import { flattenPath, pointInSubs } from "./svgpath.js";

export function makeCanvas(w, h, scale = 2) {
  const W = w * scale, H = h * scale;
  const buf = Buffer.alloc(W * H * 4, 0);
  // 장치픽셀 하나에 알파 합성(over)
  const blendDev = (dx, dy, r, g, b, a) => {
    if (a <= 0 || dx < 0 || dy < 0 || dx >= W || dy >= H) return;
    const p = (dy * W + dx) * 4, da = buf[p + 3] / 255, sa = a;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    buf[p] = (r * sa + buf[p] * da * (1 - sa)) / oa;
    buf[p + 1] = (g * sa + buf[p + 1] * da * (1 - sa)) / oa;
    buf[p + 2] = (b * sa + buf[p + 2] * da * (1 - sa)) / oa;
    buf[p + 3] = oa * 255;
  };
  // 논리픽셀 하나 = scale×scale 블록 (crisp)
  const set = (x, y, [r, g, b, a = 255]) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    for (let j = 0; j < scale; j++) for (let i = 0; i < scale; i++) blendDev(x * scale + i, y * scale + j, r, g, b, a / 255);
  };
  return { w, h, W, H, buf, scale, set, blendDev };
}

export const rect = (cv, x, y, rw, rh, col) => {
  for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) cv.set(x + i, y + j, col);
};
export const strokeRect = (cv, x, y, rw, rh, col) => {
  for (let i = 0; i < rw; i++) { cv.set(x + i, y, col); cv.set(x + i, y + rh - 1, col); }
  for (let j = 0; j < rh; j++) { cv.set(x, y + j, col); cv.set(x + rw - 1, y + j, col); }
};
// 안티에일리어싱 원. test(dx,dy,d) 로 각도/영역 제한(호/위상).
export const disc = (cv, cx, cy, r, col, test) => {
  const s = cv.scale, [cr, cg, cb, ca = 255] = col;
  const x0 = Math.floor((cx - r - 1) * s), x1 = Math.ceil((cx + r + 1) * s);
  const y0 = Math.floor((cy - r - 1) * s), y1 = Math.ceil((cy + r + 1) * s);
  for (let dy = y0; dy <= y1; dy++)
    for (let dx = x0; dx <= x1; dx++) {
      const lx = (dx + 0.5) / s, ly = (dy + 0.5) / s;      // 이 장치픽셀의 논리 좌표(중심)
      const ex = lx - cx, ey = ly - cy, d = Math.hypot(ex, ey);
      let cov = Math.max(0, Math.min(1, (r - d) * s + 0.5)); // 경계 1장치픽셀 폭 흐림
      if (cov <= 0) continue;
      if (test && !test(ex, ey, d)) continue;
      cv.blendDev(dx, dy, cr, cg, cb, (ca / 255) * cov);
    }
};

// 연속 inside(lx,ly) 판정을 장치픽셀 3×3 슈퍼샘플로 채움 → 격자 무관 매끈(애플식)
export function fillAA(cv, inside, col) {
  const s = cv.scale, [r, g, b, a = 255] = col, N = 3;
  for (let dy = 0; dy < cv.H; dy++)
    for (let dx = 0; dx < cv.W; dx++) {
      let cnt = 0;
      for (let sy = 0; sy < N; sy++)
        for (let sx = 0; sx < N; sx++)
          if (inside((dx + (sx + 0.5) / N) / s, (dy + (sy + 0.5) / N) / s)) cnt++;
      if (cnt) cv.blendDev(dx, dy, r, g, b, (a / 255) * cnt / (N * N));
    }
}
// 둥근 사각형 내부 판정 (연속 SDF): 중심(cx,cy), 반폭 hw, 반높이 hh, 모서리 r
export const rr = (lx, ly, cx, cy, hw, hh, r) => {
  const qx = Math.max(Math.abs(lx - cx) - (hw - r), 0), qy = Math.max(Math.abs(ly - cy) - (hh - r), 0);
  return Math.hypot(qx, qy) <= r;
};

// 클로드 심볼 — 방사형 스파크(썬버스트). 중심(cx,cy), 반경 r.
export function drawClaudeMark(cv, cx, cy, r, col) {
  const angles = [0, Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4]; // 8방향
  const inside = (lx, ly) => {
    const dx = lx - cx, dy = ly - cy;
    for (const a of angles) {
      const ca = Math.cos(a), sa = Math.sin(a);
      const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
      if (Math.abs(u) <= r && Math.abs(v) <= r * 0.24 * (1 - Math.abs(u) / r * 0.8)) return true; // 끝으로 갈수록 뾰족
    }
    return Math.hypot(dx, dy) <= r * 0.17;
  };
  fillAA(cv, inside, col);
}
// 코덱스 심볼 — 실제 로고 SVG 패스(viewBox 24) 렌더. even-odd로 안쪽 구멍 처리.
const CODEX_D = "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z";
const CODEX_SUBS = flattenPath(CODEX_D);
export function drawCodexMark(cv, cx, cy, r, col) {
  const s = cv.scale, [cr, cg, cb, ca = 255] = col, N = 3, sz = 2 * r;
  const dx0 = Math.floor((cx - r) * s), dx1 = Math.ceil((cx + r) * s);
  const dy0 = Math.floor((cy - r) * s), dy1 = Math.ceil((cy + r) * s);
  for (let dy = dy0; dy < dy1; dy++)
    for (let dx = dx0; dx < dx1; dx++) {
      let cnt = 0;
      for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) {
        const lx = (dx + (sx + 0.5) / N) / s, ly = (dy + (sy + 0.5) / N) / s;
        const px = (lx - (cx - r)) / sz * 24, py = (ly - (cy - r)) / sz * 24;
        if (pointInSubs(px, py, CODEX_SUBS)) cnt++;
      }
      if (cnt) cv.blendDev(dx, dy, cr, cg, cb, (ca / 255) * cnt / (N * N));
    }
}

// ── 3×5 미니 폰트 (그룹 라벨 + 숫자) ──
const FONT = {
  C: ["111", "100", "100", "100", "111"],
  X: ["101", "101", "010", "101", "101"],
  0: ["111", "101", "101", "101", "111"], 1: ["110", "010", "010", "010", "111"],
  2: ["111", "001", "111", "100", "111"], 3: ["111", "001", "111", "001", "111"],
  4: ["101", "101", "111", "001", "001"], 5: ["111", "100", "111", "001", "111"],
  6: ["111", "100", "111", "101", "111"], 7: ["111", "001", "001", "001", "001"],
  8: ["111", "101", "111", "101", "111"], 9: ["111", "101", "111", "001", "111"],
  "-": ["000", "000", "111", "000", "000"],
};
export function drawText(cv, x, y, str, col) {
  let cx = x;
  for (const ch of str) {
    const g = FONT[ch];
    if (g) for (let r = 0; r < g.length; r++) for (let c = 0; c < 3; c++) if (g[r][c] === "1") cv.set(cx + c, y + r, col);
    cx += 4;
  }
  return cx;
}
export const textW = (str) => str.length * 4 - 1;
// 크기 조절 텍스트: fs = 폰트 픽셀당 논리 크기(1=기본). 커버리지로 매끈하게.
export function drawTextScaled(cv, lx, ly, str, col, fs) {
  const s = cv.scale, [r, g, b, a = 255] = col;
  let cx = lx;
  for (const ch of str) {
    const gl = FONT[ch];
    if (gl) for (let ry = 0; ry < 5; ry++) for (let rx = 0; rx < 3; rx++) if (gl[ry][rx] === "1") {
      const x0 = (cx + rx * fs) * s, x1 = (cx + (rx + 1) * fs) * s, y0 = (ly + ry * fs) * s, y1 = (ly + (ry + 1) * fs) * s;
      for (let dy = Math.floor(y0); dy < Math.ceil(y1); dy++)
        for (let dx = Math.floor(x0); dx < Math.ceil(x1); dx++) {
          const cvx = Math.max(0, Math.min(dx + 1, x1) - Math.max(dx, x0));
          const cvy = Math.max(0, Math.min(dy + 1, y1) - Math.max(dy, y0));
          if (cvx * cvy > 0) cv.blendDev(dx, dy, r, g, b, (a / 255) * cvx * cvy);
        }
    }
    cx += 4 * fs;
  }
}
export const textWScaled = (str, fs) => (str.length * 4 - 1) * fs;
// 외곽선 두른 텍스트 (어떤 배경 위에도 읽히게)
export function drawTextOutlined(cv, x, y, str, fill, outline) {
  for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]])
    drawText(cv, x + ox, y + oy, str, outline);
  drawText(cv, x, y, str, fill);
}

// K×K 블록 평균으로 축소 (premultiplied) → 슈퍼샘플링 안티에일리어싱
export function downsample({ W, H, buf }, K) {
  const W2 = Math.floor(W / K), H2 = Math.floor(H / K);
  const out = Buffer.alloc(W2 * H2 * 4);
  for (let y = 0; y < H2; y++)
    for (let x = 0; x < W2; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (let j = 0; j < K; j++)
        for (let i = 0; i < K; i++) {
          const p = ((y * K + j) * W + (x * K + i)) * 4, a = buf[p + 3] / 255;
          ar += buf[p] * a; ag += buf[p + 1] * a; ab += buf[p + 2] * a; aa += a;
        }
      const p = (y * W2 + x) * 4, n = K * K;
      if (aa > 0) { out[p] = ar / aa; out[p + 1] = ag / aa; out[p + 2] = ab / aa; }
      out[p + 3] = (aa / n) * 255;
    }
  return { W: W2, H: H2, buf: out };
}

// ── PNG 인코더 ──
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
export function encodePNG({ W, H, buf }) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; buf.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
