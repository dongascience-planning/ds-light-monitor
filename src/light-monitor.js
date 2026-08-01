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
// 최악 케이스: 3서비스 × (goto 20초 + ready 15초 + 재시도) ≈ 4.7분 → 5분으로 커버.
// 강제 종료 전에 그 시점까지의 부분 결과를 저장·알림하고 종료한다
// (타임아웃 순간이 곧 장애 순간이므로 기록·알림이 반드시 남아야 함).
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
      console.log(`[진단] ${reason} → 러너 네트워크 문제로 판정, 잔디 알림 생략`);
      for (const svc of SERVICES) {
        const r = res[svc.key];
        if (r && !r.ok) r.error = `${r.error || '오류'} · 러너 네트워크 이상 의심`;
      }
    }
  }

  if (RECHECK_MODE) {
    // 2차(재점검) 러너 — 1차가 보류한 기록(recheckPending)의 최종 판정을 여기서 확정
    if (runnerIssue) {
      // 재점검 러너마저 카나리 실패 → 이번 회차는 판정 불가. 1차 기록도 러너 문제로 처리
      resolvePendingRecord(true, '재점검 러너도 네트워크 이상 → 판정 불가');
      saveHistory(res, true);
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
    console.log('[재점검] 이상 재현 — 러너 2대 교차 확인, 알림 발송');
    // 확정 경로는 새 이력 항목을 만들지 않는다 — 실제 장애 1건이 이력에 2건으로
    // 잡혀 요약의 "24h 내 3회 반복 → 🚨" 임계값을 왜곡함 (full-audit 발견).
    // 1차 기록 갱신이 불가능한 경우(1차 push 실패로 미발견)만 새 항목으로 대체 저장.
    const resolved = resolvePendingRecord(false);
    if (!resolved) saveHistory(res, false);
    await sendAlert(res, { crossChecked: true });
    markRecheckCompleted();
    return;
  }

  // 1차 러너
  if (runnerIssue || !alertWorthy) {
    saveHistory(res, runnerIssue);
    return;
  }
  const savedTs = saveHistory(res, false, true); // recheckPending 표시
  await requestRecheck(res, savedTs);
}

// 1차 러너: 알림 대신 워크플로우에 재점검 잡 실행을 요청한다.
// CI 밖(GITHUB_OUTPUT 없음)에서는 재점검 잡이 존재하지 않으므로 기존처럼 즉시 알림.
async function requestRecheck(res, savedTs) {
  const outFile = process.env.GITHUB_OUTPUT;
  if (!outFile || !savedTs) {
    if (!outFile) console.log('[교차 재점검] CI 밖 실행 → 재점검 없이 즉시 알림 (기존 동작)');
    else console.log('[교차 재점검] 이력 저장 실패로 재점검 연계 불가 → 즉시 알림');
    await sendAlert(res);
    return;
  }
  fs.appendFileSync(outFile, `needs_recheck=true\npending_ts=${savedTs}\n`);
  console.log('[교차 재점검] 이상 감지 — 알림 보류, 별도 러너 재점검 요청');
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

// 2차 러너: 1차가 남긴 recheckPending 기록의 판정 확정. 갱신 성공 여부 반환.
// asRunnerIssue=true면 runnerIssue로 마킹(요약 집계 제외), false면 확정 이상(recheckConfirmed)
function resolvePendingRecord(asRunnerIssue, note) {
  const filePath = path.join(__dirname, '..', 'docs', 'data', 'history-light.json');
  try {
    if (!PENDING_TS) { console.log('[재점검] PENDING_TS 없음 → 1차 기록 갱신 건너뜀'); return false; }
    const history = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const pending = history.find((e) => e.ts === PENDING_TS);
    if (!pending) { console.log(`[재점검] 1차 기록(${PENDING_TS}) 미발견 → 갱신 건너뜀 (1차 push 실패 가능)`); return false; }
    delete pending.recheckPending;
    if (asRunnerIssue) {
      pending.runnerIssue = true;
      for (const svc of SERVICES) {
        const r = pending[svc.key];
        if (r && r.ok === false) r.error = `${r.error || '오류'} · ${note}`;
      }
    } else {
      pending.recheckConfirmed = true; // 러너 2대 교차 확인된 실제 이상
    }
    fs.writeFileSync(filePath, JSON.stringify(history, null, 2), 'utf8');
    console.log(`[재점검] 1차 기록 판정 확정: ${asRunnerIssue ? `러너 문제 (${note})` : '실제 이상'}`);
    return true;
  } catch (err) {
    console.error('[재점검] 1차 기록 갱신 실패:', err.message);
    return false;
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
  }

  const runUrl = process.env.GITHUB_RUN_URL;
  if (runUrl) connectInfo.push({ title: '🔗 Actions 로그', description: runUrl });

  try {
    await axios.post(WEBHOOK_URL, { body, connectColor: '#FF3B30', connectInfo }, { timeout: 10000 });
    console.log('[Alert] 잔디 이상 알림 전송 완료');
  } catch (err) {
    console.error('[Alert] 잔디 전송 실패:', err.message);
  }
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
