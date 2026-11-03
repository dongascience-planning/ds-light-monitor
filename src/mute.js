'use strict';

// ── 알림 음소거 (2026-11-04) ────────────────────────────────────
// 이미 아는 장애를 내부에서 조치하는 동안, 그 서비스만 알림을 멈춘다.
// ds-monitor(풀점검)의 src/mute.js와 같은 설계 — 이쪽은 서비스 단위다
// (경량은 서비스당 점검 항목이 하나뿐이라 항목명을 받지 않는다).
//
// 계기: 11-04 00:14경 닷컴 전체 503(istio upstream connect timeout). 경량은 반복
// 억제가 없어 30분마다 같은 🚨가 본 채널에 쌓인다 — 밤새 약 17건.
//
// ⚠️ 설계 원칙 — 음소거는 "모니터링을 끄는 것"이 아니다:
//  1) **만료 시각 필수.** until 없는 항목은 무시한다. 끄고 잊는 것이 이 기능의
//     유일한 실패 모드다. MAX_HOURS를 넘는 만료도 방치로 보고 무시한다.
//  2) **점검·판정·이력은 그대로.** 실패는 계속 ❌로 기록되고 대시보드 가동률과
//     위젯에도 반영된다. 멈추는 것은 즉시 알림(🚨)과 교차 재점검 발사뿐이다.
//  3) **다른 서비스는 영향 없다.** 음소거한 서비스 외에 하나라도 이상이면 알림은
//     정상 발송되고, 그때는 재점검도 평소대로 돈다.
//  4) **감시 체계 자체의 경고는 안 막는다.** 러너 네트워크 문제(⚠️ 판정 불가)는
//     서비스 상태가 아니라 모니터링이 눈먼 상태를 알리는 것이라 음소거 대상이 아니다.
//
// 사용법 — docs/data/mute.json:
//   { "dotcom": { "until": "2026-11-04T09:00:00+09:00", "reason": "내부 조치 중" } }
//   서비스 키: dsstore | dotcom | dl
// 만료되면 파일을 손대지 않아도 자동으로 알림이 되살아난다.
//
// ※ 이 레포는 공개다 — reason에 내부 상세(서버·계정·담당자)를 쓰지 말 것.

const fs = require('fs');
const path = require('path');

const MUTE_FILE = path.join(__dirname, '..', 'docs', 'data', 'mute.json');
const MAX_HOURS = 24; // 경량은 30분 간격 — 하루를 넘기면 조치가 아니라 방치다

function loadMutes() {
  try {
    const raw = JSON.parse(fs.readFileSync(MUTE_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {}; // 파일 없음·손상 = 음소거 없음 (안전한 기본값)
  }
}

/**
 * 해당 서비스가 지금 음소거 상태인가.
 * 반환: { reason, until, untilKst } | null
 */
function checkMute(serviceKey) {
  const entry = loadMutes()[serviceKey];
  if (!entry || !entry.until) return null;

  const until = new Date(entry.until);
  if (isNaN(until.getTime())) {
    console.error(`[음소거] ${serviceKey}: until 파싱 실패(${entry.until}) — 무시하고 알림`);
    return null;
  }
  const now = Date.now();
  if (until.getTime() <= now) return null; // 만료 → 자동 해제
  if (until.getTime() - now > MAX_HOURS * 3600 * 1000) {
    console.error(`[음소거] ${serviceKey}: 만료가 ${MAX_HOURS}시간보다 멀다 — 무시하고 알림 (방치 방지)`);
    return null;
  }
  const kst = new Date(until.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const untilKst = `${p(kst.getUTCMonth() + 1)}-${p(kst.getUTCDate())} ${p(kst.getUTCHours())}:${p(kst.getUTCMinutes())}`;
  return { reason: entry.reason || '사유 미기재', until: entry.until, untilKst };
}

/**
 * 이상이 난 서비스에 음소거 표시를 달고, "알릴 이상이 남았는지"를 알려준다.
 * 이상 서비스 전부가 음소거면 alertable=false → 호출부가 알림·재점검을 건너뛴다.
 *
 * @param results  { [key]: { ok, slow, imgBroken, ... } }
 * @param services SERVICES 배열 ({ key, name })
 */
function applyMutes(results, services) {
  const worthy = services.filter((s) => {
    const r = results[s.key];
    return r && (!r.ok || r.slow || r.imgBroken);
  });
  if (!worthy.length) return { anyAlertWorthy: false, alertable: false, muted: [] };

  const muted = [];
  for (const s of worthy) {
    const m = checkMute(s.key);
    if (!m) continue;
    const r = results[s.key];
    r.muted = true;
    r.muteReason = m.reason;
    r.muteUntilKst = m.untilKst;
    muted.push(s.name);
    console.log(`[음소거] ${s.name} 이상 — 알림 생략 (${m.reason}, ~${m.untilKst}까지)`);
  }
  const alertable = worthy.some((s) => !results[s.key].muted);
  return { anyAlertWorthy: true, alertable, muted };
}

module.exports = { checkMute, applyMutes, MUTE_FILE, MAX_HOURS };
