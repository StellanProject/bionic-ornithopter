// ---------------------------------------------------------------------------
// 训练环境：风洞锁定平移、只保留转动动力学；指令为俯仰/滚转方波跟踪
// 条件维度：风速 / 姿态幅值 / 惯量缩放 / 油門(=>扑动频率)
// ---------------------------------------------------------------------------
import { Sim } from '../src/sim.js';
import { params } from '../src/config.js';
import { DEFAULT_POLICY } from '../src/control/adaptive.js';

const SUB = 1 / 240;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

function deepMerge(dst, src) {
  for (const k of Object.keys(src || {})) {
    const v = src[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) { dst[k] = dst[k] || {}; deepMerge(dst[k], v); }
    else dst[k] = v;
  }
  return dst;
}

export function sampleCond(rnd) {
  const pick = () => (rnd() < 0.3 ? 0 : (rnd() * 2 - 1));
  return {
    wind: rnd() * 12,                        // m/s 空速
    dir: rnd() * Math.PI * 2,
    pitchCmd: pick() * 0.45,                 // 固定姿态指令 rad (±26°)
    rollCmd: pick() * 0.35,                  // (±20°)
    inertiaScale: 0.75 + rnd() * 0.6,        // 0.75~1.35
    massScale: 0.85 + rnd() * 0.3,
    throttle: 0.70 + rnd() * 0.30,
  };
}

/**
 * 跑一个回合
 * @returns {cost, pitchRms, rollRms, rateRms, maxErr, thrRms, survived}
 */
export function episode(pol, cond, opt = {}) {
  const secs = opt.secs ?? 8;
  const cfg = deepMerge(structuredClone(params), {
    phaseDeg: opt.phaseDeg ?? 180,
    controller: 'adaptive',
    holdPosition: true,
  });
  cfg.wind.speed = cond.wind;
  cfg.wind.dir = (cond.dir * 180) / Math.PI;
  cfg.wind.gust = 0;
  cfg.mass = params.mass * (cond.massScale ?? 1);
  const is = cond.inertiaScale ?? 1;
  cfg.inertia = params.inertia.map((v) => v * is);
  const sim = new Sim(cfg);
  sim.reset(1.6);
  sim.setMode('hover');
  sim.altTarget = 1.6;
  if (pol) sim.ctlAd.setPolicy(pol);

  const N = Math.round(secs / SUB);
  const warm = Math.round(2.5 / SUB);        // 2.5 s 后认为进入稳态
  const pitchCmd = cond.pitchCmd || 0;
  const rollCmd = cond.rollCmd || 0;
  let sp = 0, sr = 0, spv = 0, srv = 0, maxErr = 0, n = 0, thr = 0;
  for (let k = 0; k < N; k++) {
    sim.step(SUB, {
      throttle: cond.throttle ?? 0.85, pitch: 0, roll: 0, yaw: 0, assist: true,
      pitchRad: pitchCmd, rollRad: rollCmd,
    });
    if (k > warm) {
      const ep = sim.tele.pitch - pitchCmd;
      const er = sim.tele.roll - rollCmd;
      sp += ep * ep; sr += er * er;
      spv += sim.wBody.z * sim.wBody.z; srv += sim.wBody.x * sim.wBody.x;
      maxErr = Math.max(maxErr, Math.abs(ep), Math.abs(er));
      thr += sim.dt.throttle;
      n++;
    }
  }
  const pitchRms = Math.sqrt(sp / n);
  const rollRms = Math.sqrt(sr / n);
  const rateRms = Math.sqrt((spv + srv) / (2 * n));
  const survived = maxErr < 0.9 && Number.isFinite(pitchRms + rollRms);
  const cost = survived
    ? 4 * (pitchRms + rollRms) + 0.35 * rateRms
    : 50 + 10 * maxErr;
  return { cost, pitchRms, rollRms, rateRms, maxErr, survived, thrMean: thr / n };
}

export function evalPolicy(pol, conds, opt) {
  let sum = 0, worst = 0, fail = 0;
  const rows = [];
  for (const c of conds) {
    const r = episode(pol, c, opt);
    sum += r.cost; worst = Math.max(worst, r.cost);
    if (!r.survived) fail++;
    rows.push(r);
  }
  return { cost: sum / conds.length, worst, fail, rows };
}

export { DEFAULT_POLICY };
