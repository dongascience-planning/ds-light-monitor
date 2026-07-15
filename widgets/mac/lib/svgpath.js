// 최소 SVG path 파서 — d 문자열을 폴리곤(서브패스 배열)으로 평탄화.
// 지원: M/m L/l H/h V/v C/c S/s Q/q T/t A/a Z/z. 곡선/호는 선분으로 샘플링.
export function flattenPath(d, steps = 14) {
  // 문자 스캐너 — 호(arc) 플래그가 숫자에 붙는 경우("013.046")를 위해 플래그는 1글자로 읽는다.
  let p = 0, x = 0, y = 0, sx = 0, sy = 0, cmd = "", pcx = null, pcy = null, pqx = null, pqy = null;
  const subs = []; let cur = null;
  const skip = () => { while (p < d.length && /[\s,]/.test(d[p])) p++; };
  const num = () => {
    skip();
    const m = /^[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/.exec(d.slice(p));
    p += m[0].length; return parseFloat(m[0]);
  };
  const flag = () => { skip(); return d[p++] === "1" ? 1 : 0; };  // 플래그는 0/1 한 글자
  const more = () => { skip(); return p < d.length && /[-+.\d]/.test(d[p]); };  // 다음이 숫자?
  const push = (nx, ny) => { cur.push([nx, ny]); x = nx; y = ny; };
  const cubic = (x1, y1, x2, y2, ex, ey) => {
    for (let t = 1; t <= steps; t++) { const u = t / steps, m = 1 - u;
      cur.push([m*m*m*x + 3*m*m*u*x1 + 3*m*u*u*x2 + u*u*u*ex, m*m*m*y + 3*m*m*u*y1 + 3*m*u*u*y2 + u*u*u*ey]); }
    pcx = x2; pcy = y2; x = ex; y = ey;
  };
  const quad = (x1, y1, ex, ey) => {
    for (let t = 1; t <= steps; t++) { const u = t / steps, m = 1 - u;
      cur.push([m*m*x + 2*m*u*x1 + u*u*ex, m*m*y + 2*m*u*y1 + u*u*ey]); }
    pqx = x1; pqy = y1; x = ex; y = ey;
  };
  const arc = (rx, ry, rot, laf, sf, ex, ey) => {
    if (rx === 0 || ry === 0) { push(ex, ey); return; }
    const ang = rot * Math.PI / 180, cos = Math.cos(ang), sin = Math.sin(ang);
    const dx = (x - ex) / 2, dy = (y - ey) / 2;
    const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
    rx = Math.abs(rx); ry = Math.abs(ry);
    let l = (x1*x1)/(rx*rx) + (y1*y1)/(ry*ry); if (l > 1) { const s = Math.sqrt(l); rx *= s; ry *= s; }
    let sq = (rx*rx*ry*ry - rx*rx*y1*y1 - ry*ry*x1*x1) / (rx*rx*y1*y1 + ry*ry*x1*x1);
    sq = Math.sqrt(Math.max(0, sq)); if (laf === sf) sq = -sq;
    const cxp = sq * rx * y1 / ry, cyp = -sq * ry * x1 / rx;
    const cx = cos*cxp - sin*cyp + (x+ex)/2, cy = sin*cxp + cos*cyp + (y+ey)/2;
    const ang1 = Math.atan2((y1-cyp)/ry, (x1-cxp)/rx);
    let da = Math.atan2((-y1-cyp)/ry, (-x1-cxp)/rx) - ang1;
    if (!sf && da > 0) da -= 2*Math.PI; if (sf && da < 0) da += 2*Math.PI;
    const n = Math.max(2, Math.ceil(Math.abs(da) / (Math.PI/steps)));
    for (let t = 1; t <= n; t++) { const a = ang1 + da*t/n, ct = Math.cos(a), st = Math.sin(a);
      cur.push([cos*rx*ct - sin*ry*st + cx, sin*rx*ct + cos*ry*st + cy]); }
    x = ex; y = ey;
  };
  while (true) {
    skip();
    if (p >= d.length) break;
    if (/[a-zA-Z]/.test(d[p])) { cmd = d[p++]; }
    else if (!more()) break;
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    if (C === "M") { const nx = num()+ox, ny = num()+oy; cur = [[nx, ny]]; subs.push(cur); x = nx; y = ny; sx = nx; sy = ny; cmd = rel ? "l" : "L"; }
    else if (C === "L") push(num()+ox, num()+oy);
    else if (C === "H") push(num()+(rel?x:0), y);
    else if (C === "V") push(x, num()+(rel?y:0));
    else if (C === "C") cubic(num()+ox, num()+oy, num()+ox, num()+oy, num()+ox, num()+oy);
    else if (C === "S") { const x1 = pcx!=null?2*x-pcx:x, y1 = pcy!=null?2*y-pcy:y; cubic(x1, y1, num()+ox, num()+oy, num()+ox, num()+oy); }
    else if (C === "Q") quad(num()+ox, num()+oy, num()+ox, num()+oy);
    else if (C === "T") { const x1 = pqx!=null?2*x-pqx:x, y1 = pqy!=null?2*y-pqy:y; quad(x1, y1, num()+ox, num()+oy); }
    else if (C === "A") { const rx = num(), ry = num(), rot = num(), laf = flag(), sf = flag(); arc(rx, ry, rot, laf, sf, num()+ox, num()+oy); }
    else if (C === "Z") { cur.push([sx, sy]); x = sx; y = sy; }
    else break;
    if (C !== "C" && C !== "S") { pcx = pcy = null; }
    if (C !== "Q" && C !== "T") { pqx = pqy = null; }
  }
  return subs;
}

// 짝수-홀수(even-odd) 내부 판정
export function pointInSubs(px, py, subs) {
  let c = false;
  for (const sp of subs)
    for (let k = 0, l = sp.length - 1; k < sp.length; l = k++) {
      const [xi, yi] = sp[k], [xj, yj] = sp[l];
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) c = !c;
    }
  return c;
}
