// 在留出网格上挑选最优策略，并把结果写回 best.json
import fs from 'fs';
import { episode } from './env.mjs';
import { DEFAULT_POLICY } from '../src/control/adaptive.js';

const files = process.argv.slice(2);
const winds = [0, 3, 6, 9, 12];
const amps = [0.10, 0.22, 0.35];
const inerts = [0.8, 1.0, 1.3];
const conds = [];
for (const w of winds) for (const a of amps) for (const is of inerts) {
  conds.push({ wind: w, dir: (w * 37) % (Math.PI * 2), pitchCmd: a, rollCmd: a * 0.6, inertiaScale: is, massScale: 1.0, throttle: 0.85 });
}
function score(pol) {
  let sum = 0, fail = 0, pr = 0, rr = 0;
  for (const c of conds) {
    const r = episode(pol, c, { secs: 8 });
    sum += r.cost; if (!r.survived) fail++;
    pr += r.pitchRms; rr += r.rollRms;
  }
  return { cost: sum / conds.length, fail, pitch: pr / conds.length, roll: rr / conds.length };
}
const rows = [{ name: '默认(手调)', pol: DEFAULT_POLICY, ...score(DEFAULT_POLICY) }];
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  rows.push({ name: f.split('/').pop(), pol: j.policy, ...score(j.policy) });
}
rows.sort((a, b) => a.cost - b.cost);
console.log('排名（留出网格 ' + conds.length + ' 例）:');
for (const r of rows) {
  console.log('  ' + r.name.padEnd(16) + ' cost=' + r.cost.toFixed(4) + '  失败=' + r.fail +
    '  俯仰RMS=' + (r.pitch * 57.3).toFixed(2) + '°  滚转RMS=' + (r.roll * 57.3).toFixed(2) + '°');
}
if (rows[0].name !== '默认(手调)') {
  fs.writeFileSync('policy-best.json', JSON.stringify({ source: rows[0].name, policy: rows[0].pol }, null, 2));
  console.log('saved policy-best.json from ' + rows[0].name);
}
