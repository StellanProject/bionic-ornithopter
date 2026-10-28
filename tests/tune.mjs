// 物理标定：验证扑翼能否在合理油门/功率下产生足够升力
import { params } from '../src/config.js';
import { WingKinematics } from '../src/kinematics.js';
import { evaluateWing, makeAcc } from '../src/aero.js';
import { Drivetrain } from '../src/drivetrain.js';

const SUB = 1 / 240;

function run(over, throttle, seconds = 5, opts = {}) {
  const cfg = structuredClone(params);
  Object.assign(cfg, over);
  Object.assign(cfg.aero, opts.aero || {});
  const kin = new WingKinematics(cfg);
  const dt = new Drivetrain(cfg);
  const stations = [];
  for (let i = 0; i < cfg.strips; i++) stations.push((i + 0.5) / cfg.strips);
  let crank = 0;
  const nAcc = makeAcc();
  let accW = makeAcc();
  const fwd = opts.forward || 0;
  const windY = opts.windY || 0;
  const bodyVel = [-(opts.forward || 0), 0, 0];
  const wind = [0, windY, 0];
  let wSum = 0, cnt = 0, fySum = 0, fxSum = 0, iSum = 0, pSum = 0;
  let fyMin = 1e9, fyMax = -1e9, mSum = 0;
  const N = Math.round(seconds / SUB);
  for (let k = 0; k < N; k++) {
    const stR = kin.state(crank, stations, 1);
    const stL = kin.state(crank, stations, -1);
    accW = makeAcc();
    evaluateWing(stR, bodyVel, [0, 0, 0], wind, dt.omegaCrank, cfg.aero, accW);
    evaluateWing(stL, bodyVel, [0, 0, 0], wind, dt.omegaCrank, cfg.aero, accW);
    const tauLoad = -(accW.Q * kin.latest.dFlap + accW.Qtheta * kin.latest.dTheta);
    dt.step(SUB, throttle, tauLoad, kin.latest.dFlap);
    crank += dt.omegaCrank * SUB;
    if (k > N * 0.7) {
      fySum += accW.F[1]; fxSum += accW.F[0]; iSum += dt.current; pSum += dt.pElec;
      fyMin = Math.min(fyMin, accW.F[1]); fyMax = Math.max(fyMax, accW.F[1]);
      mSum += accW.M[0];
      cnt++;
    }
  }
  const weight = cfg.mass * 9.81;
  return {
    fHz: dt.flapHz, rpm: dt.rpm, cur: iSum / cnt, pw: pSum / cnt,
    fy: fySum / cnt, fx: fxSum / cnt, mx: mSum / cnt,
    ratio: fySum / cnt / weight, v: dt.voltage, flapRange: kin.link.range,
    jWing: dt.jWing, alpha: accW.alphaSum / accW.areaSum, sec: dt.flightSeconds,
  };
}

function show(tag, r) {
  console.log(
    tag.padEnd(22),
    'f=' + r.fHz.toFixed(2) + 'Hz',
    'rpm=' + r.rpm.toFixed(0),
    'I=' + r.cur.toFixed(1) + 'A',
    'P=' + r.pw.toFixed(0) + 'W',
    'Fy=' + r.fy.toFixed(2) + 'N',
    'Fx=' + r.fx.toFixed(2) + 'N',
    'L/W=' + r.ratio.toFixed(2),
    'Mx=' + r.mx.toFixed(2),
    'end=' + r.sec.toFixed(0) + 's'
  );
}

const kin0 = new WingKinematics(params);
console.log('link range(deg):', (kin0.link.range * 180 / Math.PI).toFixed(1), 'ratio:', kin0.link.ratio.toFixed(3), 'deg=', (kin0.link.range * 180 / Math.PI * 2).toFixed(0));
console.log('wing inertia kg m^2:', (2 * params.wingMass * params.span ** 2 / 3).toFixed(5));

for (const th of [0.4, 0.55, 0.7, 0.85, 1.0]) show('throttle ' + th, run({}, th));

console.log('\n--- 俯仰中位角 feather0 ---');
for (const f0 of [0.3, 0.5, 0.72, 0.9, 1.1, 1.3]) show('f0=' + f0, run({ feather0: f0 }, 0.75));

console.log('\n--- 俯仰幅度 featherAmp ---');
for (const fa of [0.4, 0.6, 0.72, 0.9, 1.1]) show('fa=' + fa, run({ featherAmp: fa }, 0.75));

console.log('\n--- 俯仰相位 featherLag ---');
for (const lg of [-0.8, -0.4, 0, 0.4, 0.8, 1.2]) show('lag=' + lg, run({ featherLag: lg }, 0.8));
console.log('\n--- 冲程平面倾角 strokeTilt ---');
for (const st of [-0.4, -0.2, 0, 0.2, 0.4]) show('tilt=' + st, run({ strokeTilt: st }, 0.8));
