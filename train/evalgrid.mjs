// ---------------------------------------------------------------------------
// 评估：在固定网格（风速 × 姿态幅值 × 惯量）上对比 默认策略 vs 训练后策略
//   node20 train/evalgrid.mjs <policy.json>
// ---------------------------------------------------------------------------
import fs from 'fs';
import { episode } from './env.mjs';
import { DEFAULT_POLICY } from '../src/control/adaptive.js';

const file = process.argv[2];
const trained = file ? JSON.parse(fs.readFileSync(file, 'utf8')).policy : null;
const policies = [['默认(手调)', DEFAULT_POLICY]];
if (trained) policies.push(['训练后', trained]);

const winds = [0, 3, 6, 9, 12];
const amps = [0.10, 0.22, 0.35];
const inerts = [0.8, 1.0, 1.3];
const conds = [];
for (const w of winds) for (const a of amps) for (const is of inerts) {
  conds.push({ wind: w, dir: (w * 37) % (Math.PI * 2), amp: a, inertiaScale: is, massScale: 1.0, throttle: 0.85, period: 2.0 });
}

const f = (x, n = 4) => x.toFixed(n);
console.log('网格：' + winds.length + ' 风速 × ' + amps.length + ' 幅值 × ' + inerts.length + ' 惯量 = ' + conds.length + ' 个条件，每例 8 s');
const summary = {};
for (const [name, pol] of policies) {
  let sum = 0, worst = 0, fail = 0, pr = 0, rr = 0, rt = 0;
  const perWind = new Map();
  for (const c of conds) {
    const r = episode(pol, c, { secs: 8 });
    sum += r.cost; worst = Math.max(worst, r.cost);
    if (!r.survived) fail++;
    pr += r.pitchRms; rr += r.rollRms; rt += r.rateRms;
    const k = c.wind;
    const cur = perWind.get(k) || { p: 0, r: 0, n: 0, fail: 0 };
    cur.p += r.pitchRms; cur.r += r.rollRms; cur.n++; if (!r.survived) cur.fail++;
    perWind.set(k, cur);
  }
  const N = conds.length;
  summary[name] = { cost: sum / N, worst, fail, pitchRms: pr / N, rollRms: rr / N, rateRms: rt / N };
  console.log('\n=== ' + name + ' ===');
  console.log('  平均代价 ' + f(sum / N) + '   最差 ' + f(worst) + '   失败 ' + fail + '/' + N);
  console.log('  俯仰RMS ' + (pr / N).toFixed(4) + ' rad (' + ((pr / N) * 57.3).toFixed(2) + '°)   滚转RMS ' +
    (rr / N).toFixed(4) + ' rad (' + ((rr / N) * 57.3).toFixed(2) + '°)   角速率RMS ' + rt.toFixed(4) + ' rad/s');
  console.log('  按风速(俯仰/滚转 RMS, 失败):');
  for (const k of winds) {
    const v = perWind.get(k);
    console.log('    ' + String(k).padStart(2) + ' m/s : ' + (v.p / v.n * 57.3).toFixed(2) + '° / ' +
      (v.r / v.n * 57.3).toFixed(2) + '°   失败 ' + v.fail + '/' + v.n);
  }
}

// 衰减：训练后相对默认
if (trained) {
  const a = summary['默认(手调)'], b = summary['训练后'];
  console.log('\n=== 提升 ===');
  const pct = (x, y) => (x === 0 ? 'n/a' : ((1 - y / x) * 100).toFixed(1) + '%');
  console.log('  俯仰RMS: ' + (a.pitchRms * 57.3).toFixed(2) + '° → ' + (b.pitchRms * 57.3).toFixed(2) + '°  (' + pct(a.pitchRms, b.pitchRms) + ')');
  console.log('  滚转RMS: ' + (a.rollRms * 57.3).toFixed(2) + '° → ' + (b.rollRms * 57.3).toFixed(2) + '°  (' + pct(a.rollRms, b.rollRms) + ')');
  console.log('  平均代价: ' + a.cost.toFixed(4) + ' → ' + b.cost.toFixed(4) + '  (' + pct(a.cost, b.cost) + ')');
}
