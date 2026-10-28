import { Sim } from '../src/sim.js';
import { params } from '../src/config.js';

export function fly(over, mode, seconds = 8, throttle = 0.8) {
  const cfg = structuredClone(params);
  Object.assign(cfg, over);
  const sim = new Sim(cfg);
  sim.reset(1.6);
  sim.setMode(mode);
  if (over.altTarget) sim.altTarget = over.altTarget;
  const log = [];
  const N = Math.round(seconds * 240);
  let fSum = 0, pSum = 0, iSum = 0, lwSum = 0, n = 0, altSum = 0;
  for (let k = 0; k < N; k++) {
    sim.step(1/240, { throttle, pitch: 0, roll: 0, yaw: 0, assist: true });
    if (k > N * 0.4) {
      fSum += sim.dt.flapHz; pSum += sim.dt.pElec; iSum += sim.dt.current; lwSum += sim.tele.lw; altSum += sim.body.position.y; n++;
    }
    if (k % Math.round(N / 8) === 0) log.push({ t: +(k/240).toFixed(1), alt: +sim.body.position.y.toFixed(2), hz: +sim.dt.flapHz.toFixed(2), p: +sim.dt.pElec.toFixed(0), lw: +sim.tele.lw.toFixed(2), pitch: +(sim.tele.pitch*57.3).toFixed(0), thr: +sim.tele.throttle.toFixed(2) });
  }
  return { log, avgHz: fSum/n, avgP: pSum/n, avgI: iSum/n, avgLW: lwSum/n, avgAlt: altSum/n, weight: cfg.mass*9.81 };
}

if (process.argv[1] && process.argv[1].endsWith('flightharness.mjs')) {
  const m = process.argv[2] || 'hover';
  const r = fly({}, m, 8, 0.8);
  console.log(m, JSON.stringify(r.log));
  console.log('avg: Hz=' + r.avgHz.toFixed(2) + ' P=' + r.avgP.toFixed(0) + 'W I=' + r.avgI.toFixed(1) + 'A L/W=' + r.avgLW.toFixed(2) + ' alt=' + r.avgAlt.toFixed(2));
}
