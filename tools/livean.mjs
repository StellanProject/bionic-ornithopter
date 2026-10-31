import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--hide-scrollbars'] });
const p = await b.newPage({ viewport: { width: 1280, height: 760 } });
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR ' + String(e).slice(0,200)));
p.on('console', m => { if (m.type()==='error') errs.push('CONSOLE ' + m.text().slice(0,200)); });
await p.goto('https://stellanproject.github.io/bionic-ornithopter/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await p.waitForTimeout(9000);
await p.click('#btn-anatomy');
await p.waitForTimeout(2500);
const st = await p.evaluate(() => ({
  title: document.getElementById('an-title').textContent,
  step: document.getElementById('an-step').textContent,
  labels: [...document.querySelectorAll('.an-label')].filter(e=>e.style.display!=='none').length,
  paused: document.getElementById('btn-pause').textContent,
}));
console.log('LIVE-ANATOMY', JSON.stringify(st));
await p.screenshot({ path: 'media/anatomy-live.png', timeout: 60000 });
console.log('errors:', errs.length ? errs.slice(0,3).join(' | ') : 'none');
await b.close();
