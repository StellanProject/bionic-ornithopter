import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1000, height: 640 } });
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR ' + String(e).slice(0,300)));
p.on('console', m => { if (m.type()==='error') errs.push('CONSOLE ' + m.text().slice(0,200)); });
await p.goto('http://127.0.0.1:8137/index.html?lite=1', { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForTimeout(6000);
const st = await p.evaluate(() => {
  const o = window.__ORNI, t = o.sim.tele;
  return { frames: window.__frameCall, simTime: +o.sim.time.toFixed(2), alt: +t.alt.toFixed(2), lw: +t.lw.toFixed(2),
    rpm: +t.rpm.toFixed(0), flapHz: +t.flapHz.toFixed(2), pwr: +t.pwr.toFixed(0), soc: +t.soc.toFixed(3),
    hudLw: document.getElementById('t-lw').textContent, pitch: +(t.pitch*57.3).toFixed(1), roll: +(t.roll*57.3).toFixed(1) };
});
console.log('STATE', JSON.stringify(st));
console.log('ERRORS', errs.length ? errs.slice(0,4).join(' | ') : 'none');
await b.close();
