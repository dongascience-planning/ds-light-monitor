#!/opt/homebrew/bin/bun
// ds-status — DS스토어·동아사이언스 닷컴·d라이브러리 상태를 macOS 메뉴바에 경광등으로 표시하는 SwiftBar 위젯.
// 데이터: ds-light-monitor(공개, 30분 주기) history-light.json 을 5분마다 raw로 읽음. 인증 불필요.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { makeCanvas, encodePNG, downsample, fillAA, rr, disc } from "./lib/pixel.js";

const DATA_URL = "https://raw.githubusercontent.com/dongascience-planning/ds-light-monitor/main/docs/data/history-light.json";
const DASH_URL = "https://dongascience-planning.github.io/ds-monitor/";
const KEYS = ["dsstore", "dotcom", "dl"], NAMES = ["DS스토어", "동아사이언스 닷컴", "d라이브러리"];
const HOME = homedir();
const STATE_DIR = `${HOME}/.config/ds-status`;
const STATE_FILE = `${STATE_DIR}/state.json`;
const NOW = Date.now();

// ── 데이터 ──
function fetchHistory() {
  let raw;
  try {
    raw = execSync(`/usr/bin/curl -fsS --max-time 20 "${DATA_URL}?t=${NOW}"`, { encoding: "utf8", timeout: 22000, stdio: ["ignore", "pipe", "ignore"] });
  } catch { return { error: "네트워크·조회 오류 — 연결을 확인하세요" }; }
  let arr;
  try { arr = JSON.parse(raw); } catch { return { error: "응답 해석 실패" }; }
  if (!Array.isArray(arr)) return { error: "응답 해석 실패" };
  const snaps = [];
  for (const d of arr) {
    if (!d || typeof d !== "object") continue;
    const t = Date.parse(d.ts); if (isNaN(t)) continue;
    const services = [];
    KEYS.forEach((k, i) => {
      const sd = d[k]; if (!sd || typeof sd !== "object") return;
      services.push({ key: k, name: NAMES[i], ok: sd.ok === true, slow: sd.slow === true, imgBroken: sd.imgBroken === true, elapsed: Number(sd.elapsed) || 0 });
    });
    if (services.length) snaps.push({ ts: t, services });
  }
  if (!snaps.length) return { error: "점검 이력이 비어 있음" };
  return { snaps };
}

function computeState(snaps) {
  let latest = snaps[0];
  for (const s of snaps) if (s.ts > latest.ts) latest = s;
  const stale = (NOW - latest.ts) / 60000 > 90;
  let level = 0;
  for (const svc of latest.services) { if (!svc.ok) level = 2; else if ((svc.slow || svc.imgBroken) && level < 1) level = 1; }
  if (stale && level < 1) level = 1;
  const uptime = {};
  for (const k of KEYS) {
    let total = 0, ok = 0;
    for (const s of snaps) {
      if ((NOW - s.ts) / 3600000 > 24) continue;
      const svc = s.services.find((v) => v.key === k);
      if (svc) { total++; if (svc.ok) ok++; }
    }
    uptime[k] = total > 0 ? 100 * ok / total : -1;
  }
  return { level, stale, latest, uptime };
}

// ── 경광등 아이콘 (검정 박스 + 돔 + 받침 + 빛살). 0정상 1주의 2장애 3무데이터 ──
const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
function renderBeacon(level) {
  const C = level === 0 ? [76, 200, 110] : level === 1 ? [255, 170, 40] : level === 2 ? [240, 70, 85] : [150, 150, 150];
  const alarm = level === 1 || level === 2;
  const W = 18, H = 16, SS = 6, K = 3, cx = 9, cy = 11;
  const cv = makeCanvas(W, H, SS);
  if (alarm) disc(cv, cx, cy, 7, [...C, 70], (dx, dy) => dy <= 0.4);            // 빛무리
  disc(cv, cx, cy, 5.6, C, (dx, dy) => dy <= 0.3);                             // 돔
  disc(cv, cx - 1.7, cy - 2.6, 1.3, [255, 255, 255, 150]);                     // 유리 하이라이트
  fillAA(cv, (x, y) => rr(x, y, cx, cy + 1.0, 5.6, 1.1, 0.9), [120, 123, 130]); // 받침
  if (alarm) {
    const ray = (x1, y1, x2, y2) => fillAA(cv, (x, y) => segDist(x, y, x1, y1, x2, y2) <= 1.0, C);
    ray(cx, 4.8, cx, 2.0); ray(3.4, 6.4, 1.4, 4.2); ray(14.6, 6.4, 16.6, 4.2);
  }
  return encodePNG(downsample(cv, K)).toString("base64");
}

// ── 상태 저장(전이 알림 + 일시오류 시 마지막 상태 유지) ──
const readSaved = () => { try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return null; } };
const writeSaved = (o) => { try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(o)); } catch {} };
function notify(title, msg) {
  try { execSync(`osascript -e 'display notification ${JSON.stringify(msg)} with title ${JSON.stringify(title)}'`, { timeout: 4000, stdio: "ignore" }); } catch {}
}

// ── 포맷 ──
const fmtAgo = (ms) => { const m = Math.floor(ms / 60000); return m < 1 ? "방금" : m < 60 ? `${m}분 전` : `${Math.floor(m / 60)}시간 ${m % 60}분 전`; };
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const gauge = (pct, w = 18) => { const f = Math.round(Math.max(0, Math.min(100, pct)) / 100 * w); return "█".repeat(f) + "░".repeat(w - f); };
const statusWord = (s) => !s.ok ? "장애" : s.imgBroken ? "이미지 깨짐" : s.slow ? "느림" : "정상";
const statusHex = (s) => !s.ok ? "#eb5757" : (s.slow || s.imgBroken) ? "#f2994a" : "#6fcf97";
const upHex = (u) => u >= 99 ? "#6fcf97" : u >= 95 ? "#f2994a" : "#eb5757";
const guideFor = (e) => e.startsWith("네트워크") ? "인터넷 연결을 확인하세요. 복구되면 자동 반영됩니다."
  : e.startsWith("응답 해석") ? "데이터 형식 오류일 수 있습니다. 5분마다 자동 재시도합니다."
  : e.startsWith("점검 이력이 비") ? "데이터 파일이 초기화됐을 수 있습니다. 다음 점검(최대 30분) 후 채워집니다."
  : "5분마다 자동으로 다시 시도합니다.";

// ── 메인 ──
const res = fetchHistory();
const saved = readSaved();
const out = [];

let state = null, error = null;
if (res.error) {
  error = res.error;
  if (saved?.latest) { state = saved; state.fromCache = true; }   // 일시오류 → 마지막 상태 유지
} else {
  state = computeState(res.snaps);
  if (state.stale) error = `점검 이력 지연 — 마지막 점검 ${Math.floor((NOW - state.latest.ts) / 60000)}분 전`;
  // 전이 알림
  const prev = saved?.lastOk || {};
  for (const svc of state.latest.services) {
    if (svc.key in prev) {
      if (prev[svc.key] && !svc.ok) notify("DS 서비스 장애 감지", `${svc.name} 접속 실패가 감지됐습니다.`);
      else if (!prev[svc.key] && svc.ok) notify("DS 서비스 복구", `${svc.name}이(가) 정상으로 돌아왔습니다.`);
    }
  }
  const lastOk = {}; for (const svc of state.latest.services) lastOk[svc.key] = svc.ok;
  writeSaved({ level: state.level, latest: state.latest, uptime: state.uptime, lastOk, savedAt: NOW });
}

// 메뉴바 아이콘
out.push(`| image=${renderBeacon(state ? state.level : 3)}`);
out.push("---");
out.push("DS 서비스 상태 | size=13 color=#f0f0f0");
out.push("경량 모니터링 · 30분 주기 | size=11 color=#8b949e");
out.push("---");

if (error) {
  out.push(`⚠ ${error} | color=#f58282 size=12`);
  if (res.error) out.push(`${guideFor(error)} | size=11 color=#8b949e`);
  out.push("---");
}

if (state?.latest) {
  for (const svc of state.latest.services) {
    const up = state.uptime[svc.key] ?? -1;
    out.push(`${svc.name}  —  ${statusWord(svc)} | color=${statusHex(svc)}`);
    const info = (svc.ok ? `응답 ${(svc.elapsed / 1000).toFixed(1)}초` : "접속 실패") + (up >= 0 ? `  ·  24h 가동률 ${up.toFixed(1)}%` : "");
    out.push(`${info} | font=Menlo size=11 color=#8b949e`);
    if (up >= 0) out.push(`▕${gauge(up)}▏ | font=Menlo size=11 color=${upHex(up)}`);
  }
  out.push("---");
  out.push(`${hhmm(state.latest.ts)} 점검 (${fmtAgo(NOW - state.latest.ts)})${state.fromCache ? " · 캐시" : ""} | size=11 color=#8b949e`);
} else if (!error) {
  out.push("불러오는 중… | size=12 color=gray");
}

out.push("---");
out.push(`📊 대시보드 열기 | href=${DASH_URL}`);
out.push("🔄 지금 새로고침 | refresh=true");
out.push("v0.1 · ds-status | size=11 color=#8b949e");

console.log(out.join("\n"));
