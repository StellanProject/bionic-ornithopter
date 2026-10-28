// ---------------------------------------------------------------------------
// 离线录像 v2：逐帧推进 + 整页截图（含 HUD 面板）→ ffmpeg 合成
//   node tools/record.mjs [输出名]
// ---------------------------------------------------------------------------
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';

const OUT = process.argv[2] || 'demo';
const FPS = 25;
const W = 1280, H = 720;
const DUR = 12;                       // 秒
const SLOW = 0.5;                     // 半速（扑动看得清）
const FRAMES = Math.round(DUR * FPS);
const DIR = path.resolve('tests/shots/frames2');

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const b = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'],
});
const page = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 300)));
await page.goto('http://127.0.0.1:8137/index.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(5000);

await page.evaluate(() => {
  window.__STUDIO = true;
  const o = window.__ORNI;
  o.ui.state.paused = true;
  o.ui.setMode('hover');
  o.ui.state.altTarget = 1.7;
  o.sim.altTarget = 1.7;
  o.sim.cfg.phaseDeg = 180;
  o.sim.cfg.controller = 'adaptive';
  document.getElementById('hint').style.opacity = '0';
  for (let i = 0; i < 720; i++) o.sim.step(1 / 240, { throttle: 0.8, pitch: 0, roll: 0, yaw: 0, assist: true });
});

const t0 = Date.now();
for (let f = 0; f < FRAMES; f++) {
  const t = f / FPS;
  const seg = t < 5 ? 0 : t < 9 ? 1 : 2;
  const u = seg === 0 ? t / 5 : seg === 1 ? (t - 5) / 4 : (t - 9) / 3;
  const frame = await page.evaluate(({ seg, u, first, dSim }) => {
    const o = window.__ORNI;
    const c = o.craft.position;
    if (first) {
      // 第二段打开力矢量，第三段开机构透视
      if (seg === 1) { document.getElementById('btn-vectors').click(); }
      if (seg === 2) {
        const v = document.getElementById('btn-vectors');
        if (v.classList.contains('on')) v.click();
        document.getElementById('btn-cutaway').click();
      }
    }
    if (seg === 0) {
      const a = -1.15 + u * 1.5;
      const r = 1.62 - u * 0.06;
      o.studio.setCam([c.x + Math.cos(a) * r, c.y + 0.42 - u * 0.12, c.z + Math.sin(a) * r], [c.x, c.y + 0.03, c.z]);
    } else if (seg === 1) {
      const a = 0.35 + u * 1.15;
      const r = 1.35 + u * 0.12;
      o.studio.setCam([c.x + Math.cos(a) * r, c.y + 0.16, c.z + Math.sin(a) * r], [c.x, c.y + 0.04, c.z]);
    } else {
      const k = Math.min(1, u * 1.5);
      const r = 1.15 - k * 0.45;
      const a = 1.62;
      o.studio.setCam([c.x + Math.cos(a) * r, c.y + 0.30 - k * 0.10, c.z + Math.sin(a) * r], [c.x, c.y + 0.01, c.z]);
    }
    o.studio.step(dSim);
    return null;
  }, { seg, u, first: f === 0 || f === Math.round(5 * FPS) || f === Math.round(9 * FPS), dSim: (1 / FPS) * SLOW });
  await page.screenshot({ path: path.join(DIR, 'f' + String(f).padStart(4, '0') + '.jpg'), type: 'jpeg', quality: 90, timeout: 30000 });
  if (f % 50 === 0) console.log('frame', f, '/', FRAMES, 'elapsed', ((Date.now() - t0) / 1000).toFixed(0) + 's');
}
console.log('captured', FRAMES, 'frames in', ((Date.now() - t0) / 1000).toFixed(0) + 's', 'errors:', errs.length ? errs.slice(0, 3).join('|') : 'none');
await b.close();
