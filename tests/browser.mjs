#!/usr/bin/env node
// ---------------------------------------------------------------------------
// tests/browser.mjs — 无头浏览器冒烟测试（playwright-core + 本机 Chrome）
//
// 运行:  node tests/browser.mjs
//        node tests/browser.mjs --url http://127.0.0.1:8137
//        node tests/browser.mjs --headed        # 调试用
//
// 覆盖（对应 task-2 交付物 2）:
//   1) 访问页面，收集 console error / pageerror / HTTP>=400 资源（JS 异常算失败）
//   2) 截图到 tests/shots/：初始视角、机构特写、开启风与力矢量
//   3) canvas 存在且非全黑（像素采样：亮度均值/方差/颜色数）+ 画面在动（两帧差异）
//   4) HUD 数值无 NaN/Infinity/undefined，且关键读数在物理合理区间
//   5) 点击若干按钮、拖动滑杆、按键后再无异常
//
// 退出码: 0 通过 / 1 测试失败 / 2 环境问题（服务未启动等）
// 浏览器: executablePath=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
//         args=['--use-angle=swiftshader','--enable-unsafe-swiftshader']
// ---------------------------------------------------------------------------
import process from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots');
const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
// 默认用 ?lite=1（无 bloom，软件渲染下快很多）
const URL = argOf('--url', process.env.ORNITHOPTER_URL || 'http://127.0.0.1:8137/?lite=1');
const HEADED = argv.includes('--headed');
const BOOT_WAIT_MS = 8000;          // 无头软件渲染约 1 fps，启动后再多给 8 s
const GOTO_TIMEOUT_MS = 60000;
const APP_READY_TIMEOUT_MS = 300000; // 软件渲染首帧/着色器编译可能很慢

const results = [];
let hardFail = 0;
const f = (x, n = 3) => (Number.isFinite(x) ? x.toFixed(n) : String(x));

function check(name, pass, detail = '') {
  const tag = pass ? 'PASS' : 'FAIL';
  if (!pass) hardFail++;
  results.push({ name, pass, detail });
  console.log('  [' + tag + '] ' + name + (detail ? '  ——  ' + detail : ''));
}
function info(msg) { console.log('        ' + msg); }
function section(t) {
  console.log('\n' + '='.repeat(72));
  console.log(t);
  console.log('='.repeat(72));
}

// ---------------------------------------------------------------------------
// 像素统计：在页面内用 Image 解码截图，避免引入 PNG 解码依赖
// ---------------------------------------------------------------------------
async function pixelStats(page, dataUrl) {
  return page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, sum2 = 0, n = 0, dark = 0, lit = 0;
    const buckets = new Set();
    for (let i = 0; i < d.length; i += 4 * 7) {
      const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
      sum += l; sum2 += l * l; n++;
      if (l < 6) dark++;
      if (l > 10) lit++;
      buckets.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4));
    }
    const mean = sum / n;
    return {
      w: img.width, h: img.height,
      mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)),
      darkRatio: dark / n, litRatio: lit / n, colorBuckets: buckets.size,
    };
  }, dataUrl);
}

async function pixelDiff(page, urlA, urlB) {
  return page.evaluate(async ([a, b]) => {
    const load = async (u) => {
      const img = new Image(); img.src = u; await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
      return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
    };
    const da = await load(a), db = await load(b);
    if (da.length !== db.length) return { diffRatio: 1, meanAbs: 255 };
    let diff = 0, sumAbs = 0, n = 0;
    for (let i = 0; i < da.length; i += 4 * 5) {
      const d0 = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
      sumAbs += d0 / 3; if (d0 > 12) diff++;
      n++;
    }
    return { diffRatio: diff / n, meanAbs: sumAbs / n };
  }, [urlA, urlB]);
}

// ---------------------------------------------------------------------------
// HUD 检查
// ---------------------------------------------------------------------------
const HUD_IDS = [
  't-lw', 't-alt', 't-vy', 't-ias', 't-lift', 't-thrust', 't-drag',
  't-rpm', 't-amp', 't-volt', 't-pwr', 't-eff', 't-temp', 't-flap', 't-torque',
  't-soc', 't-endurance', 't-tip', 't-flapdeg', 't-pitchdeg', 't-aeropw',
  't-pitch', 't-roll', 'chip-mode', 'chip-sector', 'chip-pwm', 'chip-alpha', 'chip-fps',
];

async function readHud(page) {
  return page.evaluate((ids) => {
    const out = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) out[id] = (el.textContent || '').trim();
    }
    return out;
  }, HUD_IDS);
}

// 物理合理区间（读数单位见 index.html）
const RANGES = {
  't-lw': [0, 5], 't-alt': [-5, 50], 't-vy': [-30, 30], 't-ias': [0, 60],
  't-lift': [0, 100], 't-thrust': [-50, 100], 't-drag': [-50, 100],
  't-rpm': [0, 40000], 't-amp': [-50, 80], 't-volt': [0, 20],
  't-pwr': [-100, 500], 't-eff': [-100, 100.001], 't-temp': [-10, 200],
  't-flap': [0, 60], 't-torque': [-5, 5], 't-soc': [0, 100.001],
  't-endurance': [0, 100000], 't-tip': [0, 120],
  't-flapdeg': [-180, 180], 't-pitchdeg': [-180, 180], 't-aeropw': [-500, 500],
  't-pitch': [-90, 90], 't-roll': [-90, 90],
};

// ---------------------------------------------------------------------------
async function main() {
  await mkdir(SHOTS, { recursive: true });
  const consoleErrors = [];   // {phase,text}
  const pageErrors = [];
  const httpErrors = [];
  let phase = 'boot';

  const browser = await chromium.launch({
    executablePath: EXE,
    headless: !HEADED,
    args: [
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--hide-scrollbars',
      '--mute-audio',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(120000);

  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push({ phase, text: m.text().slice(0, 400) });
  });
  page.on('pageerror', (e) => pageErrors.push({ phase, text: String(e && e.stack ? e.stack : e).slice(0, 600) }));
  page.on('requestfailed', (req) => {
    const u = req.url();
    if (u.includes('favicon')) return;
    httpErrors.push({ phase, url: u, status: 'failed: ' + (req.failure()?.errorText || '?') });
  });
  page.on('response', (res) => {
    const u = res.url();
    if (res.status() >= 400 && !u.includes('favicon')) httpErrors.push({ phase, url: u, status: res.status() });
  });

  try {
    // ---- 1. 打开页面 ----
    section('一、加载页面 ' + URL);
    try {
      const resp = await page.goto(URL, { waitUntil: 'commit', timeout: GOTO_TIMEOUT_MS });
      check('B0 页面 HTTP 响应成功', !!resp && resp.status() < 400,
        resp ? 'status=' + resp.status() : '无响应');
    } catch (e) {
      console.error('  [FAIL] 无法访问 ' + URL + '：' + (e.message || e).split('\n')[0]);
      console.error('         请先启动静态服务器（如 python3 -m http.server 8137）后重试。');
      process.exitCode = 2;
      return;
    }

    // 等待应用真正跑起来：window.__ORNI 就绪 + #loading.done（软件渲染可能很慢）
    const t0 = Date.now();
    let loadingHidden = false;
    try {
      await page.waitForFunction(() => {
        const el = document.getElementById('loading');
        const done = el && (el.classList.contains('done') || getComputedStyle(el).opacity < 0.05);
        return !!window.__ORNI && !!done;
      }, { timeout: APP_READY_TIMEOUT_MS, polling: 1000 });
      loadingHidden = true;
    } catch { loadingHidden = false; }
    const bootMs = Date.now() - t0;
    if (bootMs > 30000) info('注意：软件渲染(swiftshader)启动耗时 ' + (bootMs / 1000).toFixed(1) + ' s，属环境性能差异，不作为失败判据');
    await page.waitForTimeout(BOOT_WAIT_MS);
    info('启动遮罩消失=' + loadingHidden + '（' + bootMs + ' ms），随后静置 ' + BOOT_WAIT_MS + ' ms');

    check('B1 启动遮罩已消失（应用完成初始化）', loadingHidden, 'boot=' + bootMs + ' ms');
    check('B2 页面标题非空', (await page.title()).length > 0, await page.title());

    // ---- 2. console / pageerror / 资源错误 ----
    section('二、JS 异常与资源加载');
    check('B3 无 pageerror（未捕获 JS 异常）', pageErrors.length === 0,
      pageErrors.length ? pageErrors.slice(0, 3).map((e) => '[' + e.phase + '] ' + e.text.split('\n')[0]).join(' | ') : '0 条');
    check('B4 无 console error', consoleErrors.length === 0,
      consoleErrors.length ? consoleErrors.slice(0, 3).map((e) => '[' + e.phase + '] ' + e.text).join(' | ') : '0 条');
    check('B5 无 HTTP>=400 / 请求失败资源', httpErrors.length === 0,
      httpErrors.length ? httpErrors.slice(0, 5).map((e) => e.url.split('/').pop() + ' -> ' + e.status).join(', ') : '0 条');
    if (httpErrors.length) {
      const missing = httpErrors.filter((e) => /\.js(\?|$)/.test(e.url));
      if (missing.length) info('缺失的 JS 模块: ' + missing.map((e) => e.url.split('/').slice(-2).join('/')).join(', '));
    }

    // ---- 3. canvas 与渲染 ----
    section('三、3D 渲染与 canvas');
    const canvas = page.locator('#scene');
    check('B6 存在 canvas#scene', await canvas.count() === 1, 'count=' + await canvas.count());
    const box = await canvas.boundingBox();
    check('B7 canvas 尺寸有效', !!box && box.width > 200 && box.height > 150,
      box ? box.width + '×' + box.height : '无边界框');

    // 隐藏 DOM 覆盖层，只截 3D canvas 区域做像素分析
    const hideOverlay = async (hide) => page.evaluate((h) => {
      for (const sel of ['#topbar', '#panel-left', '#panel-right', '#dock', '#hint', '#loading', '#vignette', '#help']) {
        const el = document.querySelector(sel);
        if (el) el.style.visibility = h ? 'hidden' : '';
      }
    }, hide);

    await hideOverlay(true);
    const shotCanvas = async () => {
      const buf = await page.screenshot({ clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(box.width, 1440 - Math.max(0, box.x)), height: Math.min(box.height, 900 - Math.max(0, box.y)) } });
      return 'data:image/png;base64,' + buf.toString('base64');
    };
    const d1 = await shotCanvas();
    await page.waitForTimeout(2000);
    const d2 = await shotCanvas();
    await page.evaluate(() => document.querySelector('#scene')?.setAttribute('data-probe', '1'));
    const st1 = await pixelStats(page, d1);
    const diff = await pixelDiff(page, d1, d2);
    await hideOverlay(false);
    info('canvas 像素: 均值=' + f(st1.mean, 1) + ', 标准差=' + f(st1.std, 1) +
      ', 暗像素占比=' + f(st1.darkRatio * 100, 1) + '%, 颜色桶=' + st1.colorBuckets + ', 尺寸=' + st1.w + '×' + st1.h);
    check('B8 canvas 非全黑（均值/方差/颜色数）',
      st1.mean > 5 && st1.std > 8 && st1.colorBuckets > 20 && st1.darkRatio < 0.85,
      'mean=' + f(st1.mean, 1) + ', std=' + f(st1.std, 1) + ', buckets=' + st1.colorBuckets + ', dark=' + f(st1.darkRatio * 100, 1) + '%');
    check('B9 画面在动（2 s 两帧有差异，主循环运行中）',
      diff.diffRatio > 0.0005,
      '差异像素=' + f(diff.diffRatio * 100, 3) + '%, 平均差=' + f(diff.meanAbs, 2));
    // 直接读 window.__ORNI.sim.time，确认物理在推进（更客观）
    const tA = await page.evaluate(() => (window.__ORNI ? window.__ORNI.sim.time : null));
    await page.waitForTimeout(2000);
    const tB = await page.evaluate(() => (window.__ORNI ? window.__ORNI.sim.time : null));
    check('B9b 仿真时间在推进（window.__ORNI.sim.time 增长）',
      tA !== null && tB !== null && tB > tA,
      'sim.time: ' + f(tA, 3) + ' s -> ' + f(tB, 3) + ' s');

    // ---- 4. HUD ----
    section('四、HUD 遥测数值');
    await page.waitForTimeout(1500);
    const hud = await readHud(page);
    const badText = Object.entries(hud).filter(([, v]) => /NaN|Infinity|undefined|null/i.test(v));
    check('B10 HUD 无 NaN/Infinity/undefined', badText.length === 0,
      badText.length ? badText.map(([k, v]) => k + '=' + v).join(', ') : Object.keys(hud).length + ' 个字段均无异常串');

    const parseNum = (s) => {
      const m = String(s ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
      return m ? parseFloat(m[0]) : NaN;
    };
    const missing = [];
    const outOfRange = [];
    for (const [id, [lo, hi]] of Object.entries(RANGES)) {
      if (!(id in hud)) { missing.push(id); continue; }
      const v = parseNum(hud[id]);
      if (!Number.isFinite(v)) { missing.push(id + '="' + hud[id] + '"'); continue; }
      if (v < lo || v > hi) outOfRange.push(id + '=' + v + ' 不在[' + lo + ',' + hi + ']');
    }
    check('B11 关键 HUD 读数均为有效数字', missing.length === 0,
      missing.length ? '无效: ' + missing.join(', ') : Object.keys(RANGES).length + ' 个字段可解析');
    check('B12 HUD 读数在物理合理区间', outOfRange.length === 0,
      outOfRange.length ? outOfRange.join(' | ') : '全部通过');
    check('B13 飞控核心读数非零（L/W / 转速 / 扑动频率）',
      parseNum(hud['t-lw']) > 0 && parseNum(hud['t-rpm']) > 0 && parseNum(hud['t-flap']) > 0,
      'L/W=' + hud['t-lw'] + ', rpm=' + hud['t-rpm'] + ', flap=' + hud['t-flap'] + ' Hz');

    // 初始视角截图（带 UI 覆盖层）
    const shot0 = path.join(SHOTS, 'initial.png');
    await page.screenshot({ path: shot0 });
    info('截图: ' + path.relative(HERE, shot0));

    // ---- 5. 交互：按钮 / 滑杆 / 键盘 ----
    section('五、交互健壮性（按钮 / 滑杆 / 键盘）');
    const errSnapshot = () => pageErrors.length + consoleErrors.length;
    let actionErrors = 0;
    const act = async (label, fn) => {
      const before = errSnapshot();
      try {
        await fn();
      } catch (e) {
        actionErrors++;
        info('动作失败 [' + label + ']: ' + (e.message || e).split('\n')[0]);
      }
      await page.waitForTimeout(800);
      const add = errSnapshot() - before;
      if (add > 0) { actionErrors += add; info('动作后新增异常 [' + label + ']: ' + add); }
    };

    // 模式与视图
    for (const mode of ['free', 'tether', 'hover']) {
      await act('mode:' + mode, async () => {
        const b = page.locator('button[data-mode="' + mode + '"]');
        if (await b.count()) await b.first().click();
      });
    }
    for (const view of ['mech', 'follow', 'aero', 'orbit']) {
      await act('view:' + view, async () => {
        const b = page.locator('button[data-view="' + view + '"]');
        if (await b.count()) await b.first().click();
      });
    }
    // 功能按钮
    for (const id of ['#btn-wind', '#btn-vectors', '#btn-cutaway', '#btn-launch', '#btn-pause', '#btn-pause', '#btn-reset']) {
      await act('click:' + id, async () => {
        const b = page.locator(id);
        if (await b.count()) await b.first().click();
      });
    }

    // 机构特写截图（相机已切到 mech）
    await act('view:mech', async () => {
      const b = page.locator('button[data-view="mech"]');
      if (await b.count()) await b.first().click();
    });
    await page.waitForTimeout(1800);
    const shotMech = path.join(SHOTS, 'mech-closeup.png');
    await page.screenshot({ path: shotMech });
    info('截图: ' + path.relative(HERE, shotMech));

    // 开启风与力矢量
    await act('wind-on', async () => {
      const b = page.locator('#btn-wind');
      const txt = (await b.first().textContent()) || '';
      if (!/风场\s*0+\b/.test(txt.trim()) || /0\s*$/.test(txt.trim())) await b.first().click();
    });
    await act('vectors-on', async () => {
      const b = page.locator('#btn-vectors');
      if (await b.count()) await b.first().click();
    });
    await page.waitForTimeout(1800);
    const shotWind = path.join(SHOTS, 'wind-forces.png');
    await page.screenshot({ path: shotWind });
    info('截图: ' + path.relative(HERE, shotWind));

    // 滑杆：拖动前若干条 range 输入
    const sliders = await page.locator('input[type="range"]').all();
    info('检测到滑杆 ' + sliders.length + ' 条');
    let dragged = 0;
    for (let i = 0; i < Math.min(sliders.length, 8); i++) {
      const b = await sliders[i].boundingBox();
      if (!b || b.width < 10) continue;
      await act('slider#' + i, async () => {
        const y = b.y + b.height / 2;
        const x0 = b.x + b.width * 0.2, x1 = b.x + b.width * 0.8;
        await page.mouse.move(x0, y);
        await page.mouse.down();
        await page.mouse.move((x0 + x1) / 2, y, { steps: 6 });
        await page.mouse.move(x1, y, { steps: 6 });
        await page.mouse.up();
      });
      dragged++;
    }
    check('B14 滑杆可交互', sliders.length === 0 ? true : dragged > 0,
      sliders.length === 0 ? '页面无 range 滑杆（跳过）' : '拖动 ' + dragged + '/' + sliders.length + ' 条');

    // 键盘（index.html 提示: W/S 油门, A/D 滚转, ↑/↓ 俯仰, 空格暂停）
    for (const key of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'Space']) {
      await act('key:' + key, async () => {
        await page.keyboard.press(key);
      });
    }
    // 空格会切换暂停：交互测试结束后恢复运行，否则 HUD 冻结（暂停是正常行为，不算失败）
    const isPaused = () => page.evaluate(() => !!(window.__ORNI && window.__ORNI.ui && window.__ORNI.ui.state && window.__ORNI.ui.state.paused));
    let paused = await isPaused();
    if (paused) {
      await act('resume-space', async () => { await page.keyboard.press('Space'); });
      await page.waitForTimeout(1500);
      paused = await isPaused();
      if (paused) {
        await act('resume-btn', async () => { const b = page.locator('#btn-pause'); if (await b.count()) await b.first().click(); });
        await page.waitForTimeout(1500);
        paused = await isPaused();
      }
    }
    const pauseState = await page.evaluate(() => {
      const b = document.getElementById('btn-pause');
      return b ? (b.textContent || '') + '|' + (b.className || '') : null;
    });
    check('B13b 交互后仿真处于运行态（空格/按钮可切换暂停）', paused === false,
      'paused=' + paused + ', 暂停按钮=' + pauseState);

    // 帮助弹窗
    await act('help-open', async () => {
      const b = page.locator('#btn-help');
      if (await b.count()) await b.first().click();
    });
    const helpVisible = await page.evaluate(() => {
      const el = document.getElementById('help');
      if (!el) return null;
      return !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none';
    });
    const helpLen = await page.evaluate(() => (document.getElementById('help-body')?.innerHTML || '').length);
    check('B15 帮助弹窗可打开', helpVisible === true, 'visible=' + helpVisible);
    check('B16 帮助内容非空（来自 docs/help-html.md）', helpLen > 200, 'HTML 长度=' + helpLen);
    await act('help-close', async () => {
      const b = page.locator('#btn-help-close');
      if (await b.count()) await b.first().click();
    });
    await page.waitForTimeout(300);

    check('B17 交互过程中无新增异常', actionErrors === 0,
      actionErrors === 0 ? '按钮/滑杆/键盘动作均无异常' : actionErrors + ' 次异常，详见上方日志');

    // 交互后的 HUD 与画面
    const hud2 = await readHud(page);
    const bad2 = Object.entries(hud2).filter(([, v]) => /NaN|Infinity|undefined/i.test(v));
    check('B18 交互后 HUD 仍无 NaN/Infinity', bad2.length === 0,
      bad2.length ? bad2.map(([k, v]) => k + '=' + v).join(', ') : '正常');
    // HUD 数值应随时间变化（遥测在刷新）
    await page.waitForTimeout(3500);
    const hud3 = await readHud(page);
    const num = (s) => { const m = String(s ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };
    const changed = Object.keys(hud3).filter((k) => k in hud2 && Number.isFinite(num(hud2[k])) && Number.isFinite(num(hud3[k])) && num(hud2[k]) !== num(hud3[k]));
    check('B19 HUD 遥测数值随时间变化', changed.length >= 2,
      changed.length + ' 个字段变化: ' + changed.slice(0, 8).map((k) => k + ' ' + hud2[k] + '->' + hud3[k]).join(', '));
    const postShot = await page.screenshot({ path: path.join(SHOTS, 'after-actions.png') });
    if (postShot) info('截图: shots/after-actions.png');

    // ---- 汇总 ----
    section('测试汇总');
    const pass = results.filter((r) => r.pass).length;
    console.log('  通过: ' + pass + '/' + results.length);
    if (hardFail) {
      console.log('  失败项:');
      for (const r of results.filter((x) => !x.pass)) console.log('   - ' + r.name + '  ' + r.detail);
    }
    console.log('');
    console.log('  截图目录: ' + SHOTS);
    console.log('  结果: ' + (hardFail === 0 ? '✅ 通过' : '❌ 失败（' + hardFail + ' 项）'));
    console.log('');

    const report = {
      url: URL,
      time: new Date().toISOString(),
      pass,
      total: results.length,
      hardFail,
      results,
      consoleErrors, pageErrors, httpErrors,
      hud, hudAfterActions: hud2,
      pixel: st1, frameDiff: diff,
      shots: { initial: shot0, mech: shotMech, windForces: shotWind },
    };
    await writeFile(path.join(SHOTS, 'report.json'), JSON.stringify(report, null, 2));
    process.exitCode = hardFail === 0 ? 0 : 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error('\n  ❌ 测试脚本异常: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
