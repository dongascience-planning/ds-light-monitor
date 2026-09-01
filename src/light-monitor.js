'use strict';

const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ── 설정 ────────────────────────────────────────────────────────
const SERVICES = [
  {
    key: 'dsstore',
    name: 'DS스토어',
    url: 'https://dsstore.dongascience.com/main',
    waitUntil: 'load',
    readyFn: () => document.querySelectorAll('a[href*="/product/"]').length > 0,
    readyArg: undefined,
    readyTimeout: 8000,
    withDismissPopups: true,
    postLoadDelay: 1500,
  },
  {
    key: 'dotcom',
    name: '동아사이언스 닷컴',
    url: 'https://www.dongascience.com/ko',
    waitUntil: 'domcontentloaded',
    readyFn: (pattern) => document.querySelectorAll(`a[href*="${pattern}"]`).length > 0,
    readyArg: '/ko/news/',
    readyTimeout: 10000,
    withDismissPopups: false,
    postLoadDelay: 0,
  },
  {
    key: 'dl',
    name: 'd라이브러리',
    url: 'https://dl.dongascience.com',
    waitUntil: 'domcontentloaded',
    readyFn: () => document.querySelectorAll('a[href*="/detail/"]').length >= 5,
    readyArg: undefined,
    readyTimeout: 15000,
    withDismissPopups: false,
    postLoadDelay: 3000,
  },
];

const THRESHOLD_WARN = 16000; // 2026-08-01 느림 12→16초 상향 (러너 편차 잡음 감소, 사용자 결정)
const TIMEOUT_MS = 20000;
const WEBHOOK_URL = process.env.JANDI_WEBHOOK_URL;
const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots-light');
const HISTORY_PATH = path.join(__dirname, '..', 'docs', 'data', 'history-light.json');

// ── 영문 번역 미적용 점검 (2026-08-14) ──────────────────────────
// 닷컴 /en 뉴스 헤드라인의 한글 비율로 "번역 안 되고 한국어 원문 노출"을 감지.
// 본문은 안 열고 헤드라인만 봄(경량 철학 유지). 실측: 정상 영문 0% vs 깨짐 96%로
// 간격이 커서 40% 임계값이면 양방향 안전. up/down 판정과 독립이며, 상태 전환
// (정상↔깨짐) 시에만 별도 ⚠️/✅를 발송해 장기 장애 중 30분마다 알림 폭탄을 막는다.
// 전환 판정 상태는 history-light.json 항목의 dotcomEn 필드로 보존(별도 상태파일 불필요).
// 배경: 번역 서버↔동아사이언스 서버 연동 계정 비번 만료로 /en 전체가 한글 노출된 사고.
const EN_NEWS_URL = 'https://www.dongascience.com/en/news';
const EN_NEWS_PATTERN = '/en/news/';
// 합산 임계 0.4→0.2 인하 (2026-09-01): 15일 실측(판정 ~730건)에서 정상 최대 11.8%
// (그마저 개별 기사 미번역+[인사] 중첩 사건 기간), 중앙값 0%. [인사]·[부고] 제외로
// 바닥이 더 낮아져 20%면 오탐 여유 충분 + 부분 장애(기사 5~6건 동시 미번역)를 새로 잡음.
// 전면 붕괴는 94~96%라 양방향 안전. ※ ds-monitor translation-check.js와 함께 수정
const EN_HANGUL_THRESHOLD = 0.2;
const EN_MIN_CHARS = 100; // 헤드라인 글자 수가 이보다 적으면 판정 보류 (잡음 방지)

// ── 개별 기사 번역 미적용 추적 (2026-09-01) ──
// 배경: 주요 기사 1건이 수 시간 미번역돼도(09-01 실제 문의, 기사 79675) 합산 비율은
// 3~4%밖에 안 움직여 원리적으로 미탐 — 기사 단위 지속 추적으로 보완한다.
// 15일 실측에서 평상시 한글 헤드라인 0건(중앙값 0%)이라, "동일 기사가 지속 시간 이상
// 계속 한글"은 드문 이상 신호 = 스팸 위험 낮음. 일상적 번역 지연(발행 직후 잠깐)은
// 지속 조건에 안 걸린다.
const EN_ARTICLE_KO_THRESHOLD = 0.5;          // 헤드라인 1건이 "한글"로 판정되는 비율 (과반)
const EN_ARTICLE_MIN_CHARS = 10;              // 이보다 짧은 헤드라인은 개별 판정 보류
const EN_ARTICLE_PERSIST_MS = 2 * 3600 * 1000; // 같은 기사가 이 시간 이상 지속 한글이면 알림
const EN_ARTICLE_MAX_TRACK = 40;              // 추적 맵 크기 상한 (안전판)
function hangulRatio(text) {
  const hangul = (text.match(/[가-힣]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const denom = hangul + latin;
  return { ratio: denom === 0 ? 0 : hangul / denom, denom };
}

// ── 교차 재점검 (2026-08-01 오탐 대응) ──────────────────────────
// 실사고: 특정 러너에서 동아사이언스 3도메인만 막히고 카나리(구글·네이버 등)는
// 전부 통과 → "타깃만 막힌" 러너 경로 문제는 카나리로 원리적 구분 불가.
// 대응: 1차 러너가 알림감 이상을 감지하면 알림을 보류하고(GITHUB_OUTPUT으로
// 재점검 요청) 별도 러너의 recheck 잡이 같은 점검을 반복한다.
//  - 이상 재현  → 그때만 알림 발송 (러너 2대 교차 확인)
//  - 재현 안 됨 → 1차 기록을 runnerIssue로 확정 (요약 집계 제외)
// CI 밖(로컬 실행)에서는 재점검 잡이 없으므로 기존처럼 즉시 알림.
const RECHECK_MODE = process.env.RECHECK_MODE === '1';
const PENDING_TS = process.env.PENDING_TS || null;

// ── 하드 타임아웃 (5분) ──────────────────────────────────────────
// 5분 유지: YAML timeout-minutes:8 = 셋업(캐시미스 ~2분) + 스크립트 5분 + 안전망 30초 +
// 커밋 버퍼로 이미 꽉 참 — 여기를 올리면 YAML이 먼저 잘린다.
// 정상 회차는 3서비스+번역 점검 모두 합쳐 ~1분 이내라 문제없음. 최악(3서비스 전부
// goto/ready 타임아웃+재시도 ≈4.7분)에 번역 점검(SERVICES 루프 뒤 실행)이 겹치면 5분을
// 넘길 수 있으나, 그땐 이미 up/down 이상이라 finalize가 그 부분 결과로 알림을 내보내고
// 번역 판정만 그 회차에서 누락된다(best-effort, graceful — 30분 뒤 회차가 재판정).
const HARD_TIMEOUT_MS = Number(process.env.HARD_TIMEOUT_MS) || 5 * 60 * 1000;
const results = {};
const hardTimer = setTimeout(async () => {
  console.error(`[HARD TIMEOUT] ${(HARD_TIMEOUT_MS / 60000).toFixed(1)}분 초과 — 부분 결과 저장·알림 후 종료`);
  for (const svc of SERVICES) {
    if (!results[svc.key]) {
      results[svc.key] = { ok: false, elapsed: null, slow: false, imgBroken: false, imgStats: null, error: '점검 미완료 (하드 타임아웃으로 중단)' };
    }
  }
  setTimeout(() => process.exit(1), 30 * 1000); // 저장·알림이 멈춰도 30초 후엔 무조건 종료
  await finalize(results).catch((err) => console.error('[HARD TIMEOUT] finalize 실패:', err.message));
  process.exit(1);
}, HARD_TIMEOUT_MS);

// ── 러너 네트워크 자가진단 ──────────────────────────────────────
// 2026-07-27 실사고: google·cloudflare(미국 인프라)는 정상인데 동아사이언스
// 3개 도메인(한국 인프라)이 동시에 타임아웃 → 기존 글로벌 캐너리만으로는
// "한국 라우팅 경로만 막힌" 상황을 잡아내지 못해 서비스 이상으로 오판.
// 글로벌 그룹·한국 그룹으로 나눠 각 그룹에서 둘 다 실패해야 해당 그룹이
// "막힘"으로 판정되고, 두 그룹 중 하나라도 막히면 러너/경로 문제로 간주한다
// (보수적 기준 유지 — 애매하면 서비스 이상으로 보고 알림 발송).
async function isRunnerNetworkIssue() {
  const check = (url) => axios.get(url, { timeout: 5000 }).then(() => true).catch(() => false);
  const globalCanaries = ['https://www.google.com', 'https://www.cloudflare.com'];
  const koreaCanaries = ['https://www.naver.com', 'https://www.daum.net'];

  const [globalUp, koreaUp] = await Promise.all([
    Promise.all(globalCanaries.map(check)).then((rs) => rs.some(Boolean)),
    Promise.all(koreaCanaries.map(check)).then((rs) => rs.some(Boolean)),
  ]);

  if (!globalUp) return '글로벌(google·cloudflare) 전체 실패';
  if (!koreaUp) return '한국(naver·daum) 전체 실패';
  return null;
}

// 정상 경로·하드 타임아웃 경로 중 먼저 도달한 쪽만 저장·알림 수행
let finalized = false;
async function finalize(res) {
  if (finalized) return;
  finalized = true;

  const anyError = SERVICES.some((s) => res[s.key] && !res[s.key].ok);
  const alertWorthy = SERVICES.some((s) => {
    const r = res[s.key];
    return r && (!r.ok || r.slow || r.imgBroken);
  });

  let runnerIssue = false;
  if (anyError) {
    const reason = await isRunnerNetworkIssue();
    runnerIssue = reason !== null;
    if (runnerIssue) {
      console.log(`[진단] ${reason} → 러너 네트워크 문제 판정 (이 러너의 관측은 무효)`);
      for (const svc of SERVICES) {
        const r = res[svc.key];
        if (r && !r.ok) r.error = `${r.error || '오류'} · 러너 네트워크 이상 의심`;
      }
    }
  }

  if (RECHECK_MODE) {
    // 2차(재점검) 러너 — 1차가 보류한 기록(recheckPending)의 최종 판정을 여기서 확정
    if (runnerIssue) {
      // 재점검 러너마저 카나리 실패 → 판정 불가. 무음이 아니라 ⚠️로 알린다
      // (2026-08-02 사용자 결정: 감시 체계가 2회 연속 눈이 먼 상태는 그 자체로 알릴 사건 —
      // 서비스 상태가 확정도 해제도 안 된 채 다음 회차까지 공백이 생기므로 수동 확인 유도)
      resolvePendingRecord(true, '재점검 러너도 네트워크 이상 → 판정 불가');
      saveHistory(res, true);
      await sendInconclusive();
      markRecheckCompleted();
      return;
    }
    if (!alertWorthy) {
      // 한계(수용): 수 분 내 자연 복구된 진짜 단기 장애도 이 경로로 들어와
      // 러너 문제와 구분 불가 — 둘 다 "지금은 정상"이므로 알림 생략이 맞다고 판단
      console.log('[재점검] 전 서비스 정상 → 1차 이상은 러너 경로 문제(또는 단기 자연복구)로 확정, 알림 생략');
      resolvePendingRecord(true, '교차 재점검 통과 → 러너 경로 문제 또는 단기 자연복구로 판정');
      saveHistory(res, false);
      markRecheckCompleted();
      return;
    }
    // 1차가 러너 고장(카나리 실패)이었으면 유효 관측은 이번 러너뿐 — 교차 확인이
    // 아니라 단독 판정이므로 문구를 구분하고, 유효 관측인 2차 결과를 새 항목으로
    // 저장한다 (1차 기록은 runnerIssue로 남아 집계에서 제외되므로 이중 계상 아님)
    const resolved = resolvePendingRecord(false);
    if (resolved.found && !resolved.hadRunnerIssue) {
      // 일반 교차 확인 — 새 항목 없이 1차 기록을 확정 (이중 계상 방지, full-audit 발견)
      console.log('[재점검] 이상 재현 — 러너 2대 교차 확인, 알림 발송');
      await sendAlert(res, { crossChecked: true });
    } else {
      if (resolved.hadRunnerIssue) console.log('[재점검] 이상 감지 — 1차 관측은 러너 고장으로 무효, 이번 러너 단독 판정으로 알림 발송');
      else console.log('[재점검] 이상 재현 — 1차 기록 미발견, 이번 결과를 새 항목으로 저장 후 알림 발송');
      saveHistory(res, false);
      await sendAlert(res, { soloJudgment: resolved.hadRunnerIssue });
    }
    markRecheckCompleted();
    return;
  }

  // 1차 러너
  if (!alertWorthy) {
    saveHistory(res, runnerIssue);
    return;
  }
  if (runnerIssue) {
    // 러너 인터넷 고장 — 이 러너의 관측은 무효. 예전엔 무음으로 다음 회차(≤30분)를
    // 기다렸지만, 즉시 별도 러너에 재점검을 위임한다 (2026-08-02 사용자 결정 —
    // 진짜 장애가 러너 고장에 가려 30분 늦게 잡히는 공백 제거).
    // 기록은 runnerIssue(관측 무효, 집계 제외) + recheckPending(재점검 연계) 동시 표시
    const savedTs = saveHistory(res, true, true);
    await requestRecheck(res, savedTs, { fallbackAlert: false }); // CI 밖이면 예전처럼 무음
    return;
  }
  const savedTs = saveHistory(res, false, true); // recheckPending 표시
  await requestRecheck(res, savedTs, { fallbackAlert: true });
}

// 1차 러너: 알림 대신 워크플로우에 재점검 잡 실행을 요청한다.
// CI 밖(GITHUB_OUTPUT 없음)에서는 재점검 잡이 존재하지 않으므로 —
// 일반 이상은 기존처럼 즉시 알림, 러너 고장 회차(fallbackAlert=false)는 기존처럼 무음.
async function requestRecheck(res, savedTs, { fallbackAlert }) {
  const outFile = process.env.GITHUB_OUTPUT;
  if (!outFile || !savedTs) {
    if (!fallbackAlert) {
      console.log('[교차 재점검] 재점검 연계 불가 + 러너 고장 회차 → 무음 (기존 동작)');
      return;
    }
    if (!outFile) console.log('[교차 재점검] CI 밖 실행 → 재점검 없이 즉시 알림 (기존 동작)');
    else console.log('[교차 재점검] 이력 저장 실패로 재점검 연계 불가 → 즉시 알림');
    await sendAlert(res);
    return;
  }
  fs.appendFileSync(outFile, `needs_recheck=true\npending_ts=${savedTs}\n`);
  console.log('[교차 재점검] 알림 보류, 별도 러너 재점검 요청');
}

// 2차 러너: "판정까지 완료했다"는 마커. 잡 성공 여부가 아니라 이 마커로
// 유실 안전망(recheck-lost)이 판단한다 — 커밋 단계 등 부수 실패로 인한 ⚠️ 오발송 방지
function markRecheckCompleted() {
  const outFile = process.env.GITHUB_OUTPUT;
  if (outFile) {
    try { fs.appendFileSync(outFile, 'completed=true\n'); }
    catch (err) { console.error('[재점검] 완료 마커 기록 실패:', err.message); }
  }
}

// 2차 러너: 1차가 남긴 recheckPending 기록의 판정 확정.
// 반환: { found, hadRunnerIssue } — hadRunnerIssue는 1차가 러너 고장(관측 무효)
// 회차였다는 뜻으로, 호출부가 "교차 확인 vs 단독 판정"을 구분하는 데 쓴다.
// asRunnerIssue=true면 runnerIssue로 마킹(요약 집계 제외), false면 확정 이상(recheckConfirmed).
// 단 1차가 이미 runnerIssue(관측 무효)면 확정 표시를 붙이지 않고 무효 기록으로 유지 —
// 유효 관측인 2차 결과가 별도 항목으로 저장되므로 이중 계상도 없다
function resolvePendingRecord(asRunnerIssue, note) {
  const filePath = path.join(__dirname, '..', 'docs', 'data', 'history-light.json');
  const miss = { found: false, hadRunnerIssue: false };
  try {
    if (!PENDING_TS) { console.log('[재점검] PENDING_TS 없음 → 1차 기록 갱신 건너뜀'); return miss; }
    const history = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const pending = history.find((e) => e.ts === PENDING_TS);
    if (!pending) { console.log(`[재점검] 1차 기록(${PENDING_TS}) 미발견 → 갱신 건너뜀 (1차 push 실패 가능)`); return miss; }
    const hadRunnerIssue = pending.runnerIssue === true;
    delete pending.recheckPending;
    if (asRunnerIssue) {
      pending.runnerIssue = true;
      for (const svc of SERVICES) {
        const r = pending[svc.key];
        if (r && r.ok === false) r.error = `${r.error || '오류'} · ${note}`;
      }
    } else if (!hadRunnerIssue) {
      pending.recheckConfirmed = true; // 러너 2대 교차 확인된 실제 이상
    }
    fs.writeFileSync(filePath, JSON.stringify(history, null, 2), 'utf8');
    console.log(`[재점검] 1차 기록 판정 확정: ${asRunnerIssue ? `러너 문제 (${note})` : hadRunnerIssue ? '1차 무효 유지 (2차 결과 별도 저장)' : '실제 이상'}`);
    return { found: true, hadRunnerIssue };
  } catch (err) {
    console.error('[재점검] 1차 기록 갱신 실패:', err.message);
    return miss;
  }
}

// ── 유틸 ────────────────────────────────────────────────────────
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const nowKST = () => new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

function fmtError(err) {
  if (err.message?.includes('Timeout')) return '타임아웃 (20초 초과)';
  if (err.message?.includes('net::ERR')) return `네트워크 오류: ${err.message.split('\n')[0]}`;
  return err.message?.slice(0, 120) || '알 수 없는 오류';
}

// ── 팝업 닫기 (풀점검과 동일) ───────────────────────────────────
async function dismissPopups(page) {
  const selectors = [
    'button:has-text("닫기")',
    'button:has-text("오늘 그만보기")',
    'button:has-text("오늘 하루")',
    '[aria-label="닫기"]',
    '[class*="popup"] button',
    '[class*="Popup"] button',
    '[class*="modal"] [class*="close"]',
    '[role="dialog"] [class*="close"]',
  ];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 400 })) { await el.click(); await delay(300); }
    } catch {}
  }
  const closeTexts = ['닫기', '오늘 그만보기', '오늘 하루'];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const clicked = await frame.evaluate((texts) => {
        const els = Array.from(document.querySelectorAll('button, [role="button"], a'));
        for (const el of els) {
          if (texts.some((t) => el.textContent?.includes(t))) { el.click(); return true; }
        }
        return false;
      }, closeTexts);
      if (clicked) await delay(300);
    } catch {}
  }
}

// ── 이미지 로딩 통계 (풀점검과 동일) ───────────────────────────
async function getImageStats(page) {
  const imgWaitMs = await page.evaluate(() => {
    const start = Date.now();
    const pending = Array.from(document.querySelectorAll('img[src]')).filter((img) => {
      if (img.complete) return false;
      const rect = img.getBoundingClientRect();
      return rect.top < window.innerHeight && rect.bottom > 0;
    });
    if (!pending.length) return 0;
    return Promise.race([
      Promise.all(
        pending.map((img) => new Promise((res) => {
          img.addEventListener('load', res, { once: true });
          img.addEventListener('error', res, { once: true });
        }))
      ).then(() => Date.now() - start),
      new Promise((res) => setTimeout(() => res(-1), 8000)),
    ]);
  });

  return page.evaluate((imgWaitMs) => {
    const imgs = Array.from(document.querySelectorAll('img[src]'));
    const broken = imgs.filter((img) => img.complete && img.naturalWidth === 0);
    const slowCount = imgs.filter((img) => {
      if (img.complete) return false;
      const rect = img.getBoundingClientRect();
      return rect.top < window.innerHeight && rect.bottom > 0;
    }).length;
    return {
      total: imgs.length,
      broken: broken.length,
      slowCount,
      imgWaitMs,
      brokenSrcs: broken.slice(0, 3).map((img) => img.src.split('/').slice(-1)[0]),
    };
  }, imgWaitMs);
}

// ── 스크린샷 ────────────────────────────────────────────────────
async function takeScreenshot(page, label) {
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  try {
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${label}.png`), fullPage: false });
  } catch {}
}

// ── 메인 페이지 체크 ────────────────────────────────────────────
async function checkMain(page, svc) {
  const start = Date.now();
  try {
    await page.goto(svc.url, { waitUntil: svc.waitUntil, timeout: TIMEOUT_MS });
    if (svc.readyArg !== undefined) {
      await page.waitForFunction(svc.readyFn, svc.readyArg, { timeout: svc.readyTimeout });
    } else {
      await page.waitForFunction(svc.readyFn, undefined, { timeout: svc.readyTimeout });
    }
    const elapsed = Date.now() - start;

    if (svc.postLoadDelay > 0) await delay(svc.postLoadDelay);
    if (svc.withDismissPopups) await dismissPopups(page);

    const imgStats = await getImageStats(page);
    const imgBroken = imgStats.broken >= 3;

    await takeScreenshot(page, `light-${svc.key}-ok`);
    console.log(`  ✅ ${svc.name} (${(elapsed / 1000).toFixed(1)}초) 이미지 ${imgStats.total - imgStats.broken}/${imgStats.total}`);
    return { ok: true, elapsed, slow: elapsed > THRESHOLD_WARN, imgBroken, imgStats };
  } catch (err) {
    await takeScreenshot(page, `light-${svc.key}-error`);
    console.log(`  ❌ ${svc.name}: ${fmtError(err)}`);
    return { ok: false, elapsed: null, slow: false, imgBroken: false, imgStats: null, error: fmtError(err) };
  }
}

async function withRetry(fn, label) {
  const r = await fn();
  if (r.ok) return r;
  console.log(`  ↩️  [재시도] ${label} → 3초 후 재시도`);
  await delay(3000);
  const r2 = await fn();
  if (r2.ok) console.log(`  ✅ [재시도] ${label} 성공`);
  return r2;
}

// ── history-light.json 저장 ──────────────────────────────────────
// 반환: 저장한 항목의 ts (재점검 잡이 이 ts로 1차 기록을 되찾는다). 실패 시 null
function saveHistory(results, runnerIssue = false, recheckPending = false) {
  const filePath = path.join(__dirname, '..', 'docs', 'data', 'history-light.json');
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // 파일이 오염돼도(예: git 충돌 마커) 새 결과 저장이 막히지 않도록 빈 이력으로 폴백
    let existing = [];
    if (fs.existsSync(filePath)) {
      try { existing = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
      catch { console.error('[History] 기존 파일 JSON 파싱 실패 → 빈 이력으로 재생성'); }
    }

    const entry = {
      ts: new Date().toISOString(),
      ...(runnerIssue ? { runnerIssue: true } : {}),
      ...(recheckPending ? { recheckPending: true } : {}),
    };
    for (const svc of SERVICES) {
      const r = results[svc.key];
      entry[svc.key] = {
        ok: r.ok,
        elapsed: r.elapsed,
        slow: r.slow,
        imgBroken: r.imgBroken,
        ...(r.error ? { error: r.error } : {}),
      };
    }
    // 영문 번역 판정 임베드 — 전환 감지가 이 필드로 직전 상태를 되찾는다 (별도 상태파일 불필요)
    if (results.__dotcomEn && results.__dotcomEn.checked) {
      entry.dotcomEn = { untranslated: results.__dotcomEn.untranslated, ratio: results.__dotcomEn.ratio };
      // 개별 기사 추적 맵 — 다음 회차가 since(최초 한글 관측)·alerted(중복 알림 방지)를 이어받는다
      if (results.__dotcomEn.koArticles) entry.dotcomEn.koArticles = results.__dotcomEn.koArticles;
    }

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const updated = [entry, ...existing].filter((e) => new Date(e.ts).getTime() >= cutoff);
    fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf8');
    console.log('[History] history-light.json 저장 완료');
    return entry.ts;
  } catch (err) {
    console.error('[History] 저장 실패:', err.message);
    return null;
  }
}

// ── 잔디 POST 공통 (3회 재시도) ─────────────────────────────────
// 교차 재점검 도입 후 이 발송이 이상 알림의 유일한 전달 수단 — 1회 실패로
// 묻히지 않게 재시도한다 (풀점검 postJandi와 동일 철학)
async function postJandi(payload, label) {
  for (let i = 1; i <= 3; i++) {
    try {
      await axios.post(WEBHOOK_URL, payload, { timeout: 10000 });
      console.log(`[Alert] ${label} 전송 완료`);
      return true;
    } catch (err) {
      console.error(`[Alert] ${label} 전송 실패 (${i}/3):`, err.message);
      if (i < 3) await delay(3000);
    }
  }
  return false;
}

// ── 판정 불가 통보 (⚠️) ─────────────────────────────────────────
// 1차 이상 감지 후 재점검 러너마저 카나리 실패 — 서비스 상태 미확정 상태를 알린다
async function sendInconclusive() {
  if (!WEBHOOK_URL) { console.log('[Alert] JANDI_WEBHOOK_URL 미설정 → 건너뜀'); return; }
  const ts = new Date().toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const connectInfo = [
    {
      title: '상태',
      description: '1차 점검이 이상을 감지했으나, 재점검 러너까지 연속으로 네트워크 불능(카나리 실패)이라 서비스 상태를 확정할 수 없습니다. 서비스 직접 접속 확인을 권장합니다. 다음 회차(≤30분)에서 자동 재확인됩니다.',
    },
    ...(process.env.GITHUB_RUN_URL ? [{ title: '🔗 Actions 로그', description: process.env.GITHUB_RUN_URL }] : []),
    {
      title: '※ 참고',
      description: 'GitHub 점검 서버(러너) 문제로 실제 장애가 아니어도 발송될 수 있습니다 — 서비스 직접 접속으로 교차 확인해 주세요.',
    },
  ];
  await postJandi({ body: `⚠️ 경량 모니터링 판정 불가 — 러너 연속 네트워크 문제 · ${ts}`, connectColor: '#FF9500', connectInfo }, '판정 불가 통보');
}

// ── 잔디 알림 (이상·느림·이미지 깨짐 시에만) ───────────────────
async function sendAlert(results, opts = {}) {
  if (!WEBHOOK_URL) { console.log('[Alert] JANDI_WEBHOOK_URL 미설정 → 건너뜀'); return; }

  const anyError   = SERVICES.some((s) => !results[s.key].ok);
  const anySlow    = SERVICES.some((s) => results[s.key].ok && results[s.key].slow);
  const anyImgBad  = SERVICES.some((s) => results[s.key].imgBroken);
  if (!anyError && !anySlow && !anyImgBad) return;

  const ts = new Date().toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });

  const lines = SERVICES.map((s) => {
    const r = results[s.key];
    if (!r.ok) return `❌ ${s.name} — ${r.error || '오류'}`;
    const parts = [];
    if (r.slow)     parts.push(`느림 (${(r.elapsed / 1000).toFixed(1)}초)`);
    if (r.imgBroken && r.imgStats) parts.push(`이미지 ${r.imgStats.broken}개 깨짐`);
    return parts.length ? `⚠️ ${s.name} — ${parts.join(' / ')}` : `✅ ${s.name}`;
  });

  const body = opts.crossChecked
    ? `🚨 경량 모니터링 이상 감지 (교차 재점검 확인) — ${ts}`
    : `🚨 경량 모니터링 이상 감지 — ${ts}`;
  const connectInfo = [{ title: '서비스 상태', description: lines.join('\n') }];
  if (opts.crossChecked) {
    connectInfo.push({
      title: '교차 검증',
      description: '서로 다른 러너 2대에서 연속으로 확인된 이상입니다 (러너 경로 오탐 아님). 위 상태는 2차 재점검 결과 기준.',
    });
  } else if (opts.soloJudgment) {
    connectInfo.push({
      title: '판정 경위',
      description: '직전 러너는 네트워크 불능(카나리 실패)으로 관측이 무효 처리됐고, 이번 러너의 단독 판정입니다.',
    });
  }

  const runUrl = process.env.GITHUB_RUN_URL;
  if (runUrl) connectInfo.push({ title: '🔗 Actions 로그', description: runUrl });

  // 러너 이슈 주의 문구 (2026-08-01 사용자 요청) — 이 함수는 이상일 때만 발송됨
  connectInfo.push({
    title: '※ 참고',
    description: opts.crossChecked
      ? '러너 2대 교차 확인을 거친 알림이지만, 드물게 러너·네트워크 문제가 장애처럼 보일 수 있습니다 — 서비스 직접 접속으로 최종 확인해 주세요.'
      : 'GitHub 점검 서버(러너) 문제로 실제 장애가 아니어도 발송될 수 있습니다 — 서비스 직접 접속으로 교차 확인해 주세요.',
  });

  try {
    await postJandi({ body, connectColor: '#FF3B30', connectInfo }, '잔디 이상 알림');
  } catch (err) {
    console.error('[Alert] 잔디 전송 실패:', err.message);
  }
}

// ── 영문 번역 미적용 점검 ───────────────────────────────────────
// /en 뉴스 헤드라인만 읽어(본문 안 엶) 합산 비율 + 기사별 항목을 반환.
// { ratio, denom, items: [{id, text}] }
async function readEnHeadlines(page) {
  await page.goto(EN_NEWS_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await page.waitForFunction(
    (p) => document.querySelectorAll(`a[href*="${p}"]`).length > 0,
    EN_NEWS_PATTERN, { timeout: 10000 }
  );
  await delay(1000);
  const raw = await page.$$eval(
    `a[href*="${EN_NEWS_PATTERN}"]`,
    (as) => as.map((a) => ({ href: a.getAttribute('href') || '', text: (a.innerText || '').trim() }))
             .filter((x) => x.text.length > 4)
  );
  // [인사]·[부고]는 /en에서도 국문 노출이 일상(번역 지연/제외 대상)이라 합산·개별 추적
  // 모두에서 제외 — 인사철 등 몰릴 때 번역 정상인데 임계를 넘는 오탐 방지. 제외해도
  // 전면 붕괴는 나머지 헤드라인이 전부 한글이라 판정 불변. ※ ds-monitor
  // src/translation-check.js의 EN_HEADLINE_EXCLUDE와 동일 규칙 — 변경 시 함께 수정
  const items = [];
  const seen = new Set();
  for (const { href, text } of raw) {
    const m = href.match(/\/en\/news\/(\d+)/);
    if (!m || seen.has(m[1])) continue;
    if (/^\[(인사|부고)\]/.test(text)) continue;
    seen.add(m[1]);
    items.push({ id: m[1], text });
  }
  const { ratio, denom } = hangulRatio(items.map((i) => i.text).join(' '));
  return { ratio, denom, items };
}

// 헤드라인 1건이 "한글 원문"인지 (짧으면 판정 보류 → false)
function isKoHeadline(text) {
  const { ratio, denom } = hangulRatio(text || '');
  return denom >= EN_ARTICLE_MIN_CHARS && ratio >= EN_ARTICLE_KO_THRESHOLD;
}

// { checked, untranslated, ratio } 반환. 로드 실패·텍스트 부족 시 checked:false (판정 보류).
// 항상 2회 읽어 두 판정이 일치할 때만 확정한다 — 깨짐·복구 양방향 모두 일시 오독으로 인한
// 거짓 전환(⚠️/✅ 스팸)을 차단 (2026-08-14 full-audit H2, 2026-08-18 대칭 재확인으로 확장).
async function checkEnTranslation(page) {
  try {
    const first = await readEnHeadlines(page);
    if (first.denom < EN_MIN_CHARS) {
      console.log(`  ⚠️ 영문 헤드라인 텍스트 부족(${first.denom}자) → 번역 판정 보류`);
      return { checked: false };
    }
    await delay(1500);
    const second = await readEnHeadlines(page);
    if (second.denom < EN_MIN_CHARS) {
      console.log(`  ⚠️ 영문 번역 재확인 2차 텍스트 부족(${second.denom}자) → 판정 보류`);
      return { checked: false };
    }
    const u1 = first.ratio >= EN_HANGUL_THRESHOLD;
    const u2 = second.ratio >= EN_HANGUL_THRESHOLD;
    if (u1 !== u2) {
      console.log(`  ↔️ 영문 번역 1·2차 판정 불일치(${(first.ratio * 100).toFixed(0)}% vs ${(second.ratio * 100).toFixed(0)}%) → 판정 보류`);
      return { checked: false };
    }
    console.log(`  ${u2 ? '❌' : '✅'} 영문 번역: 헤드라인 한글 ${(second.ratio * 100).toFixed(0)}%`);
    // 기사별 한글 확정: 1·2차 모두 한글로 읽힌 기사만 (일시 오독 차단 — 합산 2회 확인과 동일 철학)
    const firstKo = new Set(first.items.filter((i) => isKoHeadline(i.text)).map((i) => i.id));
    const koArticles = second.items.filter((i) => firstKo.has(i.id) && isKoHeadline(i.text));
    return { checked: true, untranslated: u2, ratio: second.ratio, koArticles };
  } catch (err) {
    console.log(`  ⚠️ 영문 번역 점검 로드 실패 → 판정 보류: ${fmtError(err)}`);
    return { checked: false };
  }
}

// ── 개별 기사 지속 추적 (순수 함수 — 테스트 용이성 위해 부수효과 없음) ──
// prevMap: 직전 회차의 추적 맵 { id: { since, alerted, title } }
// koArticles: 이번 회차 한글 확정 기사 [{ id, text }]
// 반환: { map: 새 추적 맵, due: 알림 대상 [{ id, since, title }] }
// - 이번 회차에 안 보이는 기사(번역됨/목록 이탈)는 맵에서 제거 (조용한 해소)
// - 지속 시간 미달·이미 알림된 기사는 due에 안 들어감
function trackEnKoArticles(prevMap, koArticles, nowMs) {
  const map = {};
  const due = [];
  for (const { id, text } of koArticles.slice(0, EN_ARTICLE_MAX_TRACK)) {
    const prev = prevMap && prevMap[id];
    const since = prev && prev.since ? prev.since : new Date(nowMs).toISOString();
    const alerted = !!(prev && prev.alerted);
    // 앵커 innerText에 제목 뒤 개행+본문 미리보기가 딸려오므로 첫 줄만 취해 정규화
    const title = String(text).split('\n').shift().replace(/\s+/g, ' ').trim().slice(0, 80);
    map[id] = { since, alerted, title };
    if (!alerted && nowMs - new Date(since).getTime() >= EN_ARTICLE_PERSIST_MS) {
      due.push({ id, since, title: map[id].title });
    }
  }
  return { map, due };
}

// history-light.json에서 가장 최근의 개별 기사 추적 맵을 찾는다 (없으면 빈 맵).
// dotcomEn이 있는 최신 회차 기준 — 구형 회차(koArticles 없음)는 빈 맵 취급.
function lastKnownEnKoArticles() {
  try {
    const history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    for (const e of history) {
      if (e.dotcomEn && typeof e.dotcomEn.untranslated === 'boolean') {
        return e.dotcomEn.koArticles || {};
      }
    }
  } catch {}
  return {};
}

// 개별 기사 미번역 알림 (여러 건이면 한 메시지로 묶음). 전달 성공 여부 반환 —
// 실패 시 호출부가 alerted를 기록하지 않아 다음 회차 재발송 (H2b와 동일 철학).
async function sendEnArticleAlert(due) {
  if (!WEBHOOK_URL) { console.log('[Alert] JANDI_WEBHOOK_URL 미설정 → 건너뜀'); return true; }
  const ts = new Date().toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const lines = due.map((a) => {
    const hours = ((Date.now() - new Date(a.since).getTime()) / 3600000).toFixed(1);
    return `· ${a.title}
  ${hours}시간째 국문 노출 — https://www.dongascience.com/en/news/${a.id}`;
  });
  const connectInfo = [
    { title: `대상 기사 ${due.length}건`, description: lines.join('\n') },
    { title: '※ 참고', description: `사이트 전체 번역은 정상인데 이 기사만 ${(EN_ARTICLE_PERSIST_MS / 3600000).toFixed(0)}시간 이상 번역이 붙지 않고 있습니다. 번역 파이프라인에서 해당 기사 처리 상태를 확인해 주세요. 기사당 1회만 알립니다(번역되면 별도 알림 없이 종료).` },
  ];
  return await postJandi(
    { body: `⚠️ 닷컴 영문 개별 기사 번역 미적용 — ${ts}`, connectColor: '#FF9500', connectInfo },
    '개별 기사 번역 알림'
  );
}

// history-light.json에서 가장 최근의 유효한 영문 번역 판정을 찾아 직전 상태 반환.
// checked:false·runnerIssue 등 dotcomEn 없는 회차는 건너뛴다 (누락·러너 공백에 강함).
// 판정 이력이 없으면 null.
function lastKnownEnUntranslated() {
  try {
    const history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    for (const e of history) {
      if (e.dotcomEn && typeof e.dotcomEn.untranslated === 'boolean') return e.dotcomEn.untranslated;
    }
  } catch {}
  return null;
}

// 상태 전환 시에만 발송 (broken=true: ⚠️ 미적용 / false: ✅ 복구). up/down 알림과 별개.
// 반환: 전달 성공(또는 발송 불필요) true / 3회 재시도 관통 실패 false — 호출부가
// 실패 시 상태를 확정 기록하지 않아 다음 회차가 재발송하게 한다 (H2b).
async function sendTranslationAlert(ratio, broken) {
  if (!WEBHOOK_URL) { console.log('[Alert] JANDI_WEBHOOK_URL 미설정 → 건너뜀'); return true; }
  const ts = new Date().toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const pct = (ratio * 100).toFixed(0);
  const runInfo = process.env.GITHUB_RUN_URL ? [{ title: '🔗 Actions 로그', description: process.env.GITHUB_RUN_URL }] : [];
  if (broken) {
    const connectInfo = [
      { title: '상태', description: `동아사이언스 닷컴 영문(/en)이 번역되지 않고 한국어 원문으로 노출되고 있습니다 (헤드라인 한글 ${pct}%). 번역 서버↔동아사이언스 서버 연동을 확인해 주세요.` },
      ...runInfo,
      { title: '※ 참고', description: '접속 장애가 아니라 콘텐츠(번역) 이상입니다 — 사이트 자체는 정상일 수 있습니다. 복구되면 자동으로 해제(✅) 알림이 갑니다.' },
    ];
    return await postJandi({ body: `⚠️ 닷컴 영문 번역 미적용 감지 — ${ts}`, connectColor: '#FF9500', connectInfo }, '영문 번역 이상 알림');
  }
  const connectInfo = [
    { title: '상태', description: `동아사이언스 닷컴 영문(/en) 번역이 정상으로 복구됐습니다 (헤드라인 한글 ${pct}%).` },
    ...runInfo,
  ];
  return await postJandi({ body: `✅ 닷컴 영문 번역 복구 확인 — ${ts}`, connectColor: '#34C759', connectInfo }, '영문 번역 복구 알림');
}

// ── 메인 ────────────────────────────────────────────────────────
async function main() {
  console.log(`[${nowKST()}] 경량 모니터링 시작${RECHECK_MODE ? ' (교차 재점검 — 1차 이상의 재현 확인)' : ''}`);

  let browser = null;

  try {
    const launchOpts = {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    };
    if (process.platform === 'win32') launchOpts.channel = 'chrome';
    browser = await chromium.launch(launchOpts);

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    page.on('dialog', (dialog) => dialog.accept());
    // 풀점검과 동일: 폰트·미디어만 차단, 이미지는 허용
    await page.route('**/*', (route) => {
      if (['font', 'media'].includes(route.request().resourceType())) route.abort();
      else route.continue();
    });

    for (const svc of SERVICES) {
      results[svc.key] = await withRetry(() => checkMain(page, svc), svc.name);
      await delay(1000);
    }

    // 영문 번역 미적용 점검 — up/down·재점검 흐름과 독립. 상태 전환 시에만 별도 발송.
    // 재점검(2차) 러너는 up/down 재현 확인용이므로 번역 점검 생략(1차에서 이미 처리).
    if (!RECHECK_MODE) {
      const en = await checkEnTranslation(page);
      if (en.checked) {
        const prev = lastKnownEnUntranslated(); // 이번 회차 저장 전이라 직전 상태를 반영
        const isTransition = (en.untranslated && prev !== true) || (!en.untranslated && prev === true);
        let persist = true;
        if (isTransition) {
          const delivered = await sendTranslationAlert(en.ratio, en.untranslated);
          if (!delivered) {
            // 전환 알림 전달 실패 → 이 상태를 확정 기록하지 않는다. 그래야 다음 회차가
            // 같은 전환을 다시 감지해 재발송 (H2b — 알림 유실 방지). 이번 회차 대시보드 표시는 포기.
            console.log('  ⚠️ 영문 번역 전환 알림 전달 실패 → 상태 미확정 (다음 회차 재시도)');
            persist = false;
          }
        }
        if (persist) {
          results.__dotcomEn = { checked: true, untranslated: en.untranslated, ratio: en.ratio };

          // ── 개별 기사 지속 추적 ──
          // 사이트 전체 미적용 중엔 개별 추적이 무의미(전부 한글) → 직전 맵을 그대로
          // 유지해 상태만 보존하고 알림은 안 한다 (전체 복구 후 남은 기사부터 재개)
          const prevMap = lastKnownEnKoArticles();
          if (en.untranslated) {
            results.__dotcomEn.koArticles = prevMap;
          } else {
            const { map, due } = trackEnKoArticles(prevMap, en.koArticles || [], Date.now());
            if (due.length) {
              console.log(`  ⚠️ 개별 기사 번역 미적용 ${due.length}건 (지속 ${(EN_ARTICLE_PERSIST_MS / 3600000).toFixed(0)}시간+) → 알림`);
              const sent = await sendEnArticleAlert(due);
              // 전달 성공한 경우에만 alerted 기록 — 실패 시 다음 회차 재발송 (H2b)
              if (sent) due.forEach((a) => { if (map[a.id]) map[a.id].alerted = true; });
            } else if (Object.keys(map).length) {
              console.log(`  👀 개별 기사 한글 ${Object.keys(map).length}건 추적 중 (지속 시간 미달 또는 알림 완료)`);
            }
            results.__dotcomEn.koArticles = map;
          }
        }
      }
    }
  } catch (err) {
    console.error('[FATAL]', err.message);
    for (const svc of SERVICES) {
      if (!results[svc.key]) {
        results[svc.key] = { ok: false, elapsed: null, slow: false, imgBroken: false, imgStats: null, error: err.message };
      }
    }
  } finally {
    try { await browser?.close(); } catch {}
    clearTimeout(hardTimer);
  }

  await finalize(results);

  const anyFail = SERVICES.some((s) => !results[s.key].ok);
  if (anyFail) process.exitCode = 1;
  console.log(`[${nowKST()}] 완료`);
}

main().catch((err) => {
  console.error('[UNHANDLED]', err);
  process.exit(1);
});
