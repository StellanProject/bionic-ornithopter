#!/usr/bin/env node
// ---------------------------------------------------------------------------
// 无头实验台：闭环跑 N 秒，量化「升力脉动 / 上扑净力 / 姿态与高度波动 / 功耗」
// 可在任意 Node 20 机器上批量跑（例如 192.168.3.5），不依赖浏览器。
//
//   node tools/bench.mjs                      # 默认基线
//   node tools/bench.mjs --secs=12 --json     # 输出 JSON
//   node tools/bench.mjs --sweep=controller   # 控制器参数扫描（后续接入）
// ---------------------------------------------------------------------------
import { Sim } from '../src/sim.js';
import { params } from '../src/config.js';

const SUB = 1 / 240;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

function deepMerge(dst, src) {
  for (const k of Object.keys(src || {})) {
    const v = src[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      dst[k] = dst[k] || {};
      deepMerge(dst[k], v);
    } else dst[k] = v;
  }
  return dst;
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length);
};

/**
 * 跑一个闭环 case 并返回指标
 * @param {object} over 参数覆盖（深合并到 config.params）
 * @param {object} opt  { mode='hover', secs=10, alt=1.6, warmup=0.4, throttle=0.8 }
 */
export function runCase(over = {}, opt = {}) {
  const mode = opt.mode || 'hover';
  const secs = opt.secs ?? 10;
  const alt0 = opt.alt ?? 1.6;
  const warm = opt.warmup ?? 0.4;
  const cfg = deepMerge(structuredClone(params), over);

  const sim = new Sim(cfg);
  sim.reset(alt0);
  sim.setMode(mode);
  if (opt.altTarget != null) sim.altTarget = opt.altTarget;

  const N = Math.round(secs / SUB);
  const rec = [];
  const t0 = process.hrtime.bigint();

  for (let k = 0; k < N; k++) {
    const inp = {
      throttle: opt.throttle ?? 0.8,
      pitch: opt.pitchInput ?? 0, roll: opt.rollInput ?? 0, yaw: 0,
      assist: mode !== 'free',
    };
    sim.step(SUB, inp);
    const c = sim.ctl || {};
    const Fw = sim.Fworld || [0, 0, 0];
    rec.push({
      t: k * SUB,
      fy: Fw[1], fx: Fw[0],
      dFlap: c.dFlap || 0,
      alt: sim.body.position.y,
      pitch: sim.tele.pitch, roll: sim.tele.roll,
      p: sim.dt.pElec, hz: sim.dt.flapHz, lw: sim.tele.lw,
      i: sim.dt.current,
    });
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  // 只统计 warmup 之后的稳态窗口
  const st = rec.filter((r) => r.t >= warm);
  const lift = st.map((r) => r.fy);
  const upSamples = st.filter((r) => r.dFlap < 0);
  const dnSamples = st.filter((r) => r.dFlap > 0);
  const weight = cfg.mass * 9.81;

  // 每扑动周期上扑冲量：上扑样本的 ∫Fy dt / 周期数
  const T = 1 / Math.max(1e-3, mean(st.map((r) => r.hz)));
  const cycles = (secs - warm) / T;
  const upImpulse = (mean(upSamples.map((r) => r.fy)) * upSamples.length * SUB) / Math.max(cycles, 1e-6);
  const dnImpulse = (mean(dnSamples.map((r) => r.fy)) * dnSamples.length * SUB) / Math.max(cycles, 1e-6);

  // 相位平均升力曲线（24 相位 bin，用于前馈/整形设计）
  const NB = 24;
  const bins = new Array(NB).fill(0), bn = new Array(NB).fill(0);
  for (const r of st) {
    if (!Number.isFinite(r.fy)) continue;
    const ph = ((r.t * mean(st.map((x) => x.hz))) % 1 + 1) % 1;
    const bi = Math.min(NB - 1, Math.floor(ph * NB));
    bins[bi] += r.fy; bn[bi]++;
  }
  const phaseLift = bins.map((v, i) => (bn[i] ? +(v / bn[i]).toFixed(3) : 0));

  const alt = st.map((r) => r.alt);
  return {
    secs, mode,
    // ---- 升力 / 脉动 ----
    liftMean: +mean(lift).toFixed(3),
    liftStd: +std(lift).toFixed(3),
    liftP2P: +(Math.max(...lift) - Math.min(...lift)).toFixed(3),
    liftMin: +Math.min(...lift).toFixed(3),
    pulsation: +(std(lift) / Math.max(1e-6, Math.abs(mean(lift)))).toFixed(3),
    lwMean: +mean(lift).toFixed(2) / weight,
    // ---- 上扑 / 下扑 ----
    upMeanFy: +mean(upSamples.map((r) => r.fy)).toFixed(3),
    dnMeanFy: +mean(dnSamples.map((r) => r.fy)).toFixed(3),
    upImpulse: +upImpulse.toFixed(4),     // N·s / cycle，<0 表示上扑净向下
    dnImpulse: +dnImpulse.toFixed(4),
    upFrac: +(upSamples.length / st.length).toFixed(2),
    // ---- 姿态 / 高度 ----
    altMean: +mean(alt).toFixed(3),
    altStd: +std(alt).toFixed(4),
    altP2P: +(Math.max(...alt) - Math.min(...alt)).toFixed(4),
    pitchRmsDeg: +((std(st.map((r) => r.pitch)) * 180) / Math.PI).toFixed(2),
    rollRmsDeg: +((std(st.map((r) => r.roll)) * 180) / Math.PI).toFixed(2),
    // ---- 动力 ----
    hzMean: +mean(st.map((r) => r.hz)).toFixed(2),
    powerMean: +mean(st.map((r) => r.p)).toFixed(0),
    currentMean: +mean(st.map((r) => r.i)).toFixed(1),
    wPerN: +(mean(st.map((r) => r.p)) / weight).toFixed(1),
    // ---- 其他 ----
    phaseLift,
    ms: Math.round(ms),
  };
}

function fmt(r) {
  const f = (x, n = 2) => (typeof x === 'number' ? x.toFixed(n) : String(x));
  return [
    '案例 ' + (r.name || ''),
    '  升力: mean=' + f(r.liftMean) + 'N  std=' + f(r.liftStd) + 'N  p2p=' + f(r.liftP2P) +
      'N  脉动=' + f(r.pulsation * 100, 0) + '%',
    '  上扑: 平均 ' + f(r.upMeanFy) + 'N  冲量 ' + f(r.upImpulse, 4) + ' N·s/周期(负=向下)   占比 ' + f(r.upFrac * 100, 0) + '%',
    '  下扑: 平均 ' + f(r.dnMeanFy) + 'N  冲量 ' + f(r.dnImpulse, 4) + ' N·s/周期',
    '  姿态: 高度 ' + f(r.altMean) + 'm ±' + f(r.altStd, 3) + ' (峰峰 ' + f(r.altP2P, 3) + ')  俯仰RMS ' + f(r.pitchRmsDeg) + '°  滚转RMS ' + f(r.rollRmsDeg) + '°',
    '  动力: ' + f(r.hzMean) + 'Hz  ' + f(r.powerMean, 0) + 'W  ' + f(r.currentMean, 1) + 'A  ' + f(r.wPerN, 1) + ' W/N  耗时 ' + r.ms + 'ms',
  ].join('\n');
}

// ------------------------------ CLI ------------------------------
const args = process.argv.slice(2);
const arg = (k, d) => {
  const a = args.find((x) => x.startsWith('--' + k + '='));
  return a ? a.split('=')[1] : d;
};
const asJson = args.includes('--json');
const secs = Number(arg('secs', 10));
const alt = Number(arg('alt', 1.6));

if (import.meta.url === 'file://' + process.argv[1]) {
  const r = runCase({}, { secs, alt });
  if (asJson) console.log(JSON.stringify(r));
  else {
    console.log('=== ORNI-X 无头实验台（Node ' + process.version + '）===');
    console.log(fmt(r));
    console.log('  相位平均升力(24 bin): ' + JSON.stringify(r.phaseLift));
  }
}
