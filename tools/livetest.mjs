import { chromium } from 'playwright-core';
const URL = 'https://stellanproject.github.io/bionic-ornithopter/';
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--hide-scrollbars'] });
const p = await b.newPage({ viewport: { width: 1280, height: 760 } });
const errs = [], failed = [];
p.on('pageerror', e => errs.push('PAGEERROR ' + String(e).slice(0,200)));
p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0,200)); });
p.on('requestfailed', r => failed.push(r.url() + ' ' + (r.failure()||{}).errorText));
p.on('response', r => { if (r.status() >= 400) failed.push(r.status() + ' ' + r.url()); });
await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await p.waitForTimeout(9000);
const st = await p.evaluate(() => {
  const o = window.__ORNI;
  return o ? { ok: true, frames: window.__frameCall, alt: +o.sim.tele.alt.toFixed(2), lw: +o.sim.tele.lw.toFixed(2),
    hz: +o.sim.tele.flapHz.toFixed(2), ctl: o.sim.cfg.controller, phase: o.sim.cfg.phaseDeg,
    loadingHidden: document.getElementById('loading').classList.contains('done') }
    : { ok: false };
});
console.log('LIVE', JSON.stringify(st));
await p.screenshot({ path: 'media/github-pages.png', timeout: 60000 });
console.log('errors:', errs.length ? errs.slice(0,4).join(' | ') : 'none');
console.log('failed requests:', failed.length ? failed.slice(0,4).join(' | ') : 'none');
await b.close();
