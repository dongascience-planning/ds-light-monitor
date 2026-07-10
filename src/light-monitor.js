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

const THRESHOLD_WARN = 12000;
const TIMEOUT_MS = 20000;
const WEBHOOK_URL = process.env.JANDI_WEBHOOK_URL;
const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots-light');

// ── 하드 타임아웃 (4분) ──────────────────────────────────────────
const hardTimer = setTimeout(() => {
  console.error('[HARD TIMEOUT] 4분 초과, 강제 종료');
  process.exit(1);
}, 4 * 60 * 1000);

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
function saveHistory(results) {
  const filePath = path.join(__dirname, '..', 'docs', 'data', 'history-light.json');
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const existing = fs.existsSync(filePath)
      ? JSON.parse(fs.readFileSync(filePath, 'utf8'))
      : [];

    const entry = { ts: new Date().toISOString() };
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
  } catch (err) {
    console.error('[History] 저장 실패:', err.message);
  }
}

// ── 잔디 알림 (이상·느림·이미지 깨짐 시에만) ───────────────────
async function sendAlert(results) {
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

  const body = `🚨 경량 모니터링 이상 감지 — ${ts}`;
  const connectInfo = [{ title: '서비스 상태', description: lines.join('\n') }];

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
  console.log(`[${nowKST()}] 경량 모니터링 시작`);

  const results = {};
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

  saveHistory(results);
  await sendAlert(results);

  const anyFail = SERVICES.some((s) => !results[s.key].ok);
  if (anyFail) process.exitCode = 1;
  console.log(`[${nowKST()}] 완료`);
}

main().catch((err) => {
  console.error('[UNHANDLED]', err);
  process.exit(1);
});
