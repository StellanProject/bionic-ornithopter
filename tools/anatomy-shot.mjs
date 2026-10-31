import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--hide-scrollbars'] });
const p = await b.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 1 });
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR ' + String(e).slice(0,300)));
p.on('console', m => { if (m.type()==='error') errs.push('CONSOLE ' + m.text().slice(0,200)); });
await p.goto('http://127.0.0.1:8137/index.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForTimeout(6000);
await p.click('#btn-anatomy');
await p.waitForTimeout(2500);
for (let i = 0; i < 8; i++) {
  const info = await p.evaluate(() => ({
    title: document.getElementById('an-title').textContent,
    step: document.getElementById('an-step').textContent,
    labels: [...document.querySelectorAll('.an-label')].filter(e => e.style.display !== 'none').map(e => e.querySelector('b').textContent),
  }));
  console.log('step', i, JSON.stringify(info));
  await p.screenshot({ path: 'media/anatomy-' + i + '.png', timeout: 60000 });
  await p.click('#an-next');
  await p.waitForTimeout(1800);
}
console.log('errors:', errs.length ? errs.slice(0,4).join(' | ') : 'none');
await b.close();
