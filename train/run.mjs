// ---------------------------------------------------------------------------
// 训练入口：CMA-ES 在"域随机化"的风洞姿态跟踪任务上优化控制器策略
//   node20 train/run.mjs --gens=60 --pop=16 --seed=1 --conds=3 --out=pol1.json
// ---------------------------------------------------------------------------
import fs from 'fs';
import { episode, sampleCond } from './env.mjs';
import { CMAES, makeRng } from './cmaes.mjs';
import { DEFAULT_POLICY } from '../src/control/adaptive.js';

const arg = (k, d) => {
  const a = process.argv.find((x) => x.startsWith('--' + k + '='));
  return a ? a.split('=')[1] : d;
};
const GENS = +arg('gens', 60);
const POP = +arg('pop', 16);
const SEED = +arg('seed', 1);
const CONDS = +arg('conds', 3);
const SECS = +arg('secs', 7);
const OUT = arg('out', 'policy.json');

const KEYS = Object.keys(DEFAULT_POLICY);
const x0 = KEYS.map((k) => DEFAULT_POLICY[k]);
const SIGMA = 0.35;                       // 相对初始值 35% 的扰动
const scale = KEYS.map((k) => Math.max(0.02, Math.abs(DEFAULT_POLICY[k]) || 0.1));
const toPolicy = (x) => {
  const p = {};
  KEYS.forEach((k, i) => (p[k] = x[i]));
  return p;
};

const rnd = makeRng(SEED * 7919 + 13);
const es = new CMAES(x0.slice(), SIGMA, POP, SEED * 104729 + 7);

const t0 = Date.now();
let best = { f: Infinity, x: x0.slice() };
console.log('CMA-ES: n=' + KEYS.length + ' pop=' + POP + ' gens=' + GENS + ' conds/个体=' + CONDS + ' seed=' + SEED);

for (let g = 0; g < GENS; g++) {
  const pop = es.ask();
  for (const ind of pop) {
    const pol = toPolicy(ind.x);
    let f = 0, fails = 0;
    for (let c = 0; c < CONDS; c++) {
      const cond = sampleCond(rnd);
      const r = episode(pol, cond, { secs: SECS });
      f += r.cost;
      if (!r.survived) fails++;
    }
    ind.f = f / CONDS + fails * 8;
  }
  const bestOfGen = es.tell(pop);
  if (bestOfGen.f < best.f) { best = { f: bestOfGen.f, x: bestOfGen.x.slice() }; }
  if (g % 5 === 0 || g === GENS - 1) {
    console.log('gen ' + String(g).padStart(3) + '  best=' + best.f.toFixed(4) +
      '  gen_best=' + bestOfGen.f.toFixed(4) + '  sigma=' + es.sigma.toFixed(4) +
      '  ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
  }
}
const pol = toPolicy(best.x);
fs.writeFileSync(OUT, JSON.stringify({ best: best.f, policy: pol, gens: GENS, pop: POP, seed: SEED, secs: SECS }, null, 2));
console.log('saved ' + OUT + '  best cost=' + best.f.toFixed(4));
console.log(JSON.stringify(pol));
