#!/usr/bin/env node
// 参数扫描：找出能降低"升力脉动 / 上扑负冲量"的配置（远程批量跑）
import { runCase } from './bench.mjs';

const cases = [];
for (const foldGain of [0, 0.55, 0.85]) {
  for (const featherHold of [0.1, 0.45]) {
    for (const featherLag of [-0.6, 0, 0.6]) {
      cases.push({
        name: 'fold=' + foldGain + ' hold=' + featherHold + ' lag=' + featherLag,
        over: { foldGain, featherHold, featherLag },
      });
    }
  }
}
const rows = [];
const t0 = Date.now();
for (const c of cases) {
  const r = runCase(c.over, { secs: 8 });
  rows.push({ ...c, ...r });
}
rows.sort((a, b) => Math.abs(a.pulsation) - Math.abs(b.pulsation));
const f = (x, n = 2) => (typeof x === 'number' ? x.toFixed(n) : String(x));
console.log('排序：脉动（std/mean）从小到大 —— ' + cases.length + ' 例，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log('配置'.padEnd(28) + '脉动%'.padStart(7) + '升力N'.padStart(8) + '峰峰N'.padStart(8) +
  '上扑冲量'.padStart(10) + '高度std'.padStart(9) + '俯仰RMS'.padStart(9) + 'Hz'.padStart(7) + 'W'.padStart(7));
for (const r of rows) {
  console.log(r.name.padEnd(28) +
    f(r.pulsation * 100, 0).padStart(7) +
    f(r.liftMean).padStart(8) +
    f(r.liftP2P).padStart(8) +
    f(r.upImpulse, 4).padStart(10) +
    f(r.altStd, 3).padStart(9) +
    f(r.pitchRmsDeg).padStart(9) +
    f(r.hzMean).padStart(7) +
    f(r.powerMean, 0).padStart(7));
}
