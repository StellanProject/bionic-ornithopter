import { params } from '../src/config.js';
import { WingKinematics } from '../src/kinematics.js';
import { evaluateWing, makeAcc } from '../src/aero.js';
const cfg = structuredClone(params);
const kin = new WingKinematics(cfg);
const N = cfg.strips, st = [];
for (let i = 0; i < N; i++) st.push((i + 0.5) / N);
for (const offset of [0, Math.PI / 2, Math.PI]) {
  const om = 2 * Math.PI * 5.4;
  let s = 0, s2 = 0, n = 0, min = 1e9, max = -1e9;
  for (let k = 0; k < 240; k++) {
    const crank = (k / 240) * Math.PI * 2;
    const a = makeAcc();
    evaluateWing(kin.state(crank, st, 1), [0,0,0],[0,0,0],[0,0,0], om, cfg.aero, a);
    evaluateWing(kin.state(crank + offset, st, -1), [0,0,0],[0,0,0],[0,0,0], om, cfg.aero, a);
    const f = a.F[1];
    s += f; s2 += f * f; n++; min = Math.min(min, f); max = Math.max(max, f);
  }
  const mean = s / n, sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
  console.log('相位差 ' + (offset * 180 / Math.PI).toFixed(0).padStart(3) + '°  升力mean=' + mean.toFixed(2) + 'N  std=' + sd.toFixed(2) +
    'N  脉动=' + (sd / Math.abs(mean) * 100).toFixed(0) + '%  峰峰=' + (max - min).toFixed(1) + 'N');
}
