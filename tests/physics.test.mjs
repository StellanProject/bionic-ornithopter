#!/usr/bin/env node
// ---------------------------------------------------------------------------
// tests/physics.test.mjs — 纯 Node 物理自检（无需浏览器）
//
// 运行:  node tests/physics.test.mjs            # 硬性断言任一失败 -> exit 1
//        node tests/physics.test.mjs --strict   # 额外不变式失败也 -> exit 1
//
// 覆盖（对应 task-2 交付物 1）:
//   A. 四连杆整周连续、摇杆摆动幅度（半幅口径同 tune.mjs）30°~90°、无 NaN
//   B. 油门 0.1~1.0 扫掠 5 s，任何量不出现 NaN / Infinity
//   C. 稳态电流 > 0（电机输出正功，非发电）
//   D. 扑动频率（周期平均）随油门单调不减
//   E. 约 0.80~1.00 油门时升重比 L/W 落在 0.7~1.8（可悬停）
//   F. 电机电功率 >= 机械功率，效率落在 0~1
// 以及附加不变式（默认 WARN，--strict 下视为失败）:
//   G. 左右翼镜像对称（state 第4参 gainMul=1 的几何/力/力矩）、差动扑动、气动极曲线、
//      六步换向、鲁棒性、可重复性
//
// 只读 src/，只写 tests/。发现 src 的 bug 只报告，不修改。
// ---------------------------------------------------------------------------
import process from 'node:process';
import { params } from '../src/config.js';
import { WingKinematics, fourBar } from '../src/kinematics.js';
import { evaluateWing, makeAcc, polar } from '../src/aero.js';
import { Drivetrain } from '../src/drivetrain.js';

const SUB = 1 / 240;              // 积分步长 s（与 tests/tune.mjs 一致）
const STRICT = process.argv.includes('--strict');
const DEG = 180 / Math.PI;

// ---------------------------------------------------------------------------
// 断言收集
// ---------------------------------------------------------------------------
const REQUIRED = 'hard', EXTRA = 'extra';
const results = [];
let hardFail = 0, extraFail = 0;

const f = (x, n = 3) => (Number.isFinite(x) ? x.toFixed(n) : String(x));

function section(title) {
  console.log('\n' + '='.repeat(72));
  console.log(title);
  console.log('='.repeat(72));
}

function check(level, name, pass, detail = '') {
  const tag = pass ? 'PASS' : (level === REQUIRED ? 'FAIL' : 'WARN');
  if (!pass) { if (level === REQUIRED) hardFail++; else extraFail++; }
  results.push({ level, name, pass, detail });
  console.log('  [' + tag + '] ' + name + (detail ? '  ——  ' + detail : ''));
  return pass;
}

function info(msg) { console.log('        ' + msg); }

// 数值有限且量级合理
function finiteOk(v) { return Number.isFinite(v) && Math.abs(v) < 1e9; }

// ---------------------------------------------------------------------------
// 仿真骨架（复用 tests/tune.mjs 的模型，但记录更完整且逐步检查有限性）
//   - 机体速度固定（运动学自检不耦合六自由度刚体）
//   - 统计窗口 = 后 30% 时间（与 tune.mjs 一致）
// ---------------------------------------------------------------------------
function simulate(throttle, { seconds = 5, wind = [0, 0, 0], forward = 0 } = {}) {
  const cfg = structuredClone(params);
  const kin = new WingKinematics(cfg);
  const drive = new Drivetrain(cfg);
  const stations = [];
  for (let i = 0; i < cfg.strips; i++) stations.push((i + 0.5) / cfg.strips);

  const N = Math.round(seconds / SUB);
  const bodyVel = [-forward, 0, 0];
  const bad = [];
  const scan = (tag, v) => {
    if (bad.length >= 12) return;
    if (!Number.isFinite(v)) bad.push(tag + '=' + v);
    else if (Math.abs(v) > 1e9) bad.push(tag + ' 量级异常=' + v);
  };
  // 一个数组分量和可视为整体有限性探针（NaN/Inf 会传播到和）
  const sum3 = (a) => a[0] + a[1] + a[2];

  let crank = 0;
  let cnt = 0;
  let wSum = 0, fySum = 0, fxSum = 0, mxSum = 0, mySum = 0, iSum = 0;
  let peSum = 0, pmSum = 0, thetaSum = 0, alphaSum = 0, areaSum = 0;
  let omegaMin = Infinity, omegaMax = -Infinity, omegaStepNeg = false;
  let tempMax = -Infinity, pwrGapMin = Infinity, voltageMin = Infinity, voltageMax = -Infinity;
  let socMin = Infinity;
  const sectors = new Set();
  const weight = cfg.mass * 9.81;

  for (let k = 0; k < N; k++) {
    const stR = kin.state(crank, stations, 1);
    const stL = kin.state(crank, stations, -1);
    const a = makeAcc();
    evaluateWing(stR, bodyVel, [0, 0, 0], wind, drive.omegaCrank, cfg.aero, a);
    evaluateWing(stL, bodyVel, [0, 0, 0], wind, drive.omegaCrank, cfg.aero, a);

    // --- 逐步有限性：翼面状态 ---
    for (const [w, tag] of [[stR, 'R'], [stL, 'L']]) {
      for (let i = 0; i < w.length; i++) {
        const st = w[i];
        scan(tag + '[' + i + '].pos', sum3(st.pos));
        scan(tag + '[' + i + '].eSpan', sum3(st.eSpan));
        scan(tag + '[' + i + '].eChord', sum3(st.eChord));
        scan(tag + '[' + i + '].eNormal', sum3(st.eNormal));
        scan(tag + '[' + i + '].uFlap', sum3(st.uFlap));
        scan(tag + '[' + i + '].uTheta', sum3(st.uTheta));
        scan(tag + '[' + i + '].chord', st.chord);
        scan(tag + '[' + i + '].area', st.area);
        scan(tag + '[' + i + '].flap', st.flap);
        scan(tag + '[' + i + '].theta', st.theta);
      }
    }
    // --- 气动合力/力矩/功率 ---
    scan('aero.F[0]', a.F[0]); scan('aero.F[1]', a.F[1]); scan('aero.F[2]', a.F[2]);
    scan('aero.M[0]', a.M[0]); scan('aero.M[1]', a.M[1]); scan('aero.M[2]', a.M[2]);
    scan('aero.Q', a.Q); scan('aero.Qtheta', a.Qtheta);
    scan('ctl.flap', kin.latest.flap); scan('ctl.dFlap', kin.latest.dFlap);
    scan('ctl.theta', kin.latest.theta); scan('ctl.dTheta', kin.latest.dTheta);

    const tauLoad = -(a.Q * kin.latest.dFlap + a.Qtheta * kin.latest.dTheta);
    const omegaBefore = drive.omegaCrank;
    drive.step(SUB, throttle, tauLoad, kin.latest.dFlap);
    crank += drive.omegaCrank * SUB;
    if (drive.omegaCrank < 0) omegaStepNeg = true;

    // --- 逐步有限性：电驱/电池/热 ---
    scan('drive.omegaCrank', drive.omegaCrank);
    scan('drive.current', drive.current);
    scan('drive.voltage', drive.voltage);
    scan('drive.temp', drive.temp);
    scan('drive.soc', drive.soc);
    scan('drive.torque', drive.torque);
    scan('drive.loadTorque', drive.loadTorque);
    scan('drive.pElec', drive.pElec);
    scan('drive.pMech', drive.pMech);
    scan('drive.elecAngle', drive.elecAngle);
    if (!Number.isInteger(drive.sector) || drive.sector < 0 || drive.sector > 5) {
      scan('drive.sector', drive.sector);
    }

    omegaMin = Math.min(omegaMin, drive.omegaCrank);
    omegaMax = Math.max(omegaMax, drive.omegaCrank);
    tempMax = Math.max(tempMax, drive.temp);
    voltageMin = Math.min(voltageMin, drive.voltage);
    voltageMax = Math.max(voltageMax, drive.voltage);
    socMin = Math.min(socMin, drive.soc);
    sectors.add(drive.sector);

    if (k > N * 0.7) {
      cnt++;
      wSum += drive.omegaCrank;
      fySum += a.F[1]; fxSum += a.F[0];
      mxSum += a.M[0]; mySum += a.M[1];
      iSum += drive.current; peSum += drive.pElec; pmSum += drive.pMech;
      thetaSum += kin.latest.theta;
      alphaSum += a.alphaSum; areaSum += a.areaSum;
      pwrGapMin = Math.min(pwrGapMin, drive.pElec - drive.pMech);
    }
    void omegaBefore;
  }

  const meanOmega = wSum / cnt;
  const meanFy = fySum / cnt;
  return {
    throttle,
    seconds,
    fHz: meanOmega / (2 * Math.PI),
    fInst: drive.flapHz,
    rpm: drive.rpm,
    L: meanFy,
    LsW: meanFy / weight,
    Fx: fxSum / cnt,
    Mx: mxSum / cnt,
    My: mySum / cnt,
    I: iSum / cnt,
    P: peSum / cnt,
    eff: peSum > 1e-9 ? pmSum / peSum : 0,
    effOk: peSum > 1e-9 && pmSum >= -1e-12 && pmSum <= peSum * (1 + 1e-12),
    pwrGapMin,
    theta: thetaSum / cnt,
    alpha: areaSum > 0 ? alphaSum / areaSum : 0,
    omegaMin, omegaMax,
    omegaStepNeg,
    tempMax,
    voltageMin, voltageMax,
    socMin,
    sectors: [...sectors].sort(),
    bad,
  };
}

// ---------------------------------------------------------------------------
// 一、四连杆 + 运动学
// ---------------------------------------------------------------------------
function testLinkage() {
  section('一、四连杆曲柄摇杆机构与运动学');
  const kin = new WingKinematics(params);
  const link = kin.link;

  check(REQUIRED, 'A1 机构可装配（analyzeLinkage 未退化）', !link.degenerate,
    'sign=' + link.sign + ', 半摆幅=' + f(link.range * DEG, 2) + '°, dpsiMax=' + f(link.dpsiMax, 2));

  // 整周 720 点求解
  const N = 720;
  let nullCnt = 0, badCnt = 0, maxJump = 0, psiMin = Infinity, psiMax = -Infinity;
  let prev = null;
  const dthetaMaxArr = [];
  for (let i = 0; i <= N; i++) {
    const th = (i / N) * Math.PI * 2;
    const psi = fourBar(th, params.mech, link.sign);
    if (psi === null) { nullCnt++; continue; }
    if (!Number.isFinite(psi)) { badCnt++; continue; }
    psiMin = Math.min(psiMin, psi);
    psiMax = Math.max(psiMax, psi);
    if (prev !== null) maxJump = Math.max(maxJump, Math.abs(psi - prev));
    prev = psi;
    dthetaMaxArr.push(i);
  }
  check(REQUIRED, 'A2 四连杆整周可解且无 NaN', nullCnt === 0 && badCnt === 0,
    'null=' + nullCnt + ', NaN=' + badCnt + ' (' + (N + 1) + ' 个曲柄角)');
  const halfRangeDeg = (psiMax - psiMin) / 2 * DEG;
  const fullRangeDeg = (psiMax - psiMin) * DEG;
  // 口径与 tests/tune.mjs 一致：link.range / 2*(psiMax-psiMin) 为半幅（单边摆幅）
  check(REQUIRED, 'A3 摇杆摆动幅度（半幅）30°~90°', halfRangeDeg >= 30 && halfRangeDeg <= 90,
    '半幅=' + f(halfRangeDeg, 2) + '°（全摆幅=' + f(fullRangeDeg, 2) + '°）, link.range=' + f(link.range * DEG, 2) + '°');
  check(REQUIRED, 'A3b 摇杆为往复摆动而非整周回转（全摆幅<180°）',
    fullRangeDeg > 0 && fullRangeDeg < 180 && Math.abs(fullRangeDeg - 2 * link.range * DEG) < 1e-6,
    '全摆幅=' + f(fullRangeDeg, 2) + '°');
  check(REQUIRED, 'A4 四连杆整周连续（无分支跳变）', maxJump < 0.6,
    '相邻 0.5° 采样最大跳变=' + f(maxJump, 5) + ' rad (阈值 0.6)');

  // 控制量及其解析导数 vs 数值差分
  let maxRel = 0, ctlBad = 0, flapAbs = 0, thetaLo = Infinity, thetaHi = -Infinity;
  const h = 1e-3;
  for (let j = 0; j < 48; j++) {
    const c = (j / 48) * Math.PI * 2;
    const ctl = kin.control(c);
    const p1 = kin.control(c + h), p0 = kin.control(c - h);
    const vals = [ctl.flap, ctl.dFlap, ctl.theta, ctl.dTheta, p1.flap, p0.flap];
    if (vals.some((v) => !Number.isFinite(v))) ctlBad++;
    const ndFlap = (p1.flap - p0.flap) / (2 * h);
    const ndTheta = (p1.theta - p0.theta) / (2 * h);
    const e1 = Math.abs(ndFlap - ctl.dFlap) / Math.max(1, Math.abs(ctl.dFlap));
    const e2 = Math.abs(ndTheta - ctl.dTheta) / Math.max(1, Math.abs(ctl.dTheta));
    maxRel = Math.max(maxRel, e1, e2);
    flapAbs = Math.max(flapAbs, Math.abs(ctl.flap));
    thetaLo = Math.min(thetaLo, ctl.theta);
    thetaHi = Math.max(thetaHi, ctl.theta);
  }
  check(REQUIRED, 'A5 扑动角/桨距解析导数与差分一致', ctlBad === 0 && maxRel < 1e-3,
    '48 个曲柄角，最大相对误差=' + maxRel.toExponential(2) + ', 非有限=' + ctlBad);
  info('扑动角幅值=' + f(flapAbs * DEG, 1) + '°, 桨距角范围=' + f(thetaLo * DEG, 1) + '° ~ ' + f(thetaHi * DEG, 1) + '°');

  // 翼面站位几何
  const stations = [];
  for (let i = 0; i < params.strips; i++) stations.push((i + 0.5) / params.strips);
  const stR = kin.state(1.0, stations, 1);
  const stL = kin.state(1.0, stations, -1);
  let chordDec = true, geomBad = 0, areaSum = 0, orthoErr = 0;
  for (let i = 0; i < stR.length; i++) {
    const st = stR[i];
    if (i > 0 && st.chord > stR[i - 1].chord + 1e-12) chordDec = false;
    if (!(st.area > 0)) geomBad++;
    areaSum += st.area;
    const nS = Math.hypot(...st.eSpan), nC = Math.hypot(...st.eChord), nN = Math.hypot(...st.eNormal);
    const dotSC = st.eSpan[0] * st.eChord[0] + st.eSpan[1] * st.eChord[1] + st.eSpan[2] * st.eChord[2];
    orthoErr = Math.max(orthoErr, Math.abs(nS - 1), Math.abs(nC - 1), Math.abs(nN - 1), Math.abs(dotSC));
  }
  check(REQUIRED, 'A6 翼面站位几何合法（弦长递减/面积>0/局部正交标架）',
    // 单翼面积取决于翼型参数（当前 0.40/0.25 弦长 ≈ 0.19 m²），这里给物理合理区间
    chordDec && geomBad === 0 && orthoErr < 1e-9 && areaSum > 0.05 && areaSum < 0.35,
    '单翼面积=' + f(areaSum, 4) + ' m², 正交误差=' + orthoErr.toExponential(2));

  // 左右镜像（额外不变式）—— 曾暴露 "左翼翼根偏移被镜像两次" 的 bug
  const mirror = mirrorSymmetry(kin, stations);
  check(EXTRA, 'G1 左右翼镜像对称（几何/力/力矩，state(sign, gainMul=1)）', mirror.pass, mirror.detail);
  const diff = differentialFlap(kin, stations);
  check(EXTRA, 'G2 差动扑动 state(gainMul<1)：该翼升力下降且产生滚转力矩', diff.pass, diff.detail);
}

function mirrorSymmetry(kin, stations) {
  const cranks = [0.3, 1.1, 2.0, 3.2, 4.5, 5.6];
  const aero = params.aero;
  let maxPosErr = 0, maxVecErr = 0, maxFErr = 0, maxFErrRot = 0;
  let maxRollYawResidual = 0, maxPitchRel = 0, maxPitchVal = 0;
  for (const c of cranks) {
    // 显式覆盖 4 参接口: sign=+1/-1, gainMul=1（对称扑动）
    const R = kin.state(c, stations, 1, 1);
    const L = kin.state(c, stations, -1, 1);
    for (let i = 0; i < R.length; i++) {
      const p = R[i].pos, q = L[i].pos;
      // 机体坐标 x 前向 / y 垂向 / z 展向，左右翼关于 z=0 平面镜像: (x,y,z)->(x,y,-z)
      maxPosErr = Math.max(maxPosErr,
        Math.abs(q[0] - p[0]), Math.abs(q[1] - p[1]), Math.abs(q[2] + p[2]));
      for (const key of ['eSpan', 'eChord', 'eNormal', 'uFlap', 'uTheta']) {
        const a = R[i][key], b = L[i][key];
        maxVecErr = Math.max(maxVecErr, Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] + a[2]));
      }
    }
    // (1) 零机体角速度：力镜面对称；力矩是赝矢量 M_L=(-Mx,-My,+Mz)
    //     故 ΣMx、ΣMy（滚转/偏航）应抵消，ΣMz（俯仰）应叠加 = 2*Mz_R
    const aR = makeAcc(), aL = makeAcc();
    evaluateWing(R, [0, 0, 0], [0, 0, 0], [0, 0, 0], 40, aero, aR);
    evaluateWing(L, [0, 0, 0], [0, 0, 0], [0, 0, 0], 40, aero, aL);
    const scale = Math.max(1, Math.hypot(...aR.F));
    maxFErr = Math.max(maxFErr,
      Math.abs(aL.F[0] - aR.F[0]) / scale,
      Math.abs(aL.F[1] - aR.F[1]) / scale,
      Math.abs(aL.F[2] + aR.F[2]) / scale);
    maxRollYawResidual = Math.max(maxRollYawResidual,
      Math.abs(aR.M[0] + aL.M[0]), Math.abs(aR.M[1] + aL.M[1]));
    maxPitchVal = Math.max(maxPitchVal, Math.abs(aR.M[2] + aL.M[2]));
    maxPitchRel = Math.max(maxPitchRel, Math.abs(aL.M[2] - aR.M[2]) / Math.max(1e-12, Math.abs(aR.M[2])));
    // (2) 有角速度时（ω×r 项）左右气动载荷同样应镜像，
    //     注意角速度是赝矢量：镜像后的 ω' = (-ωx, -ωy, +ωz)
    const om = [1.2, -0.7, 0.9];
    const omMirror = [-om[0], -om[1], om[2]];
    const bR = makeAcc(), bL = makeAcc();
    evaluateWing(R, [0, 0, 0], om, [0, 0, 0], 40, aero, bR);
    evaluateWing(L, [0, 0, 0], omMirror, [0, 0, 0], 40, aero, bL);
    const s2 = Math.max(1, Math.hypot(...bR.F));
    maxFErrRot = Math.max(maxFErrRot,
      Math.abs(bL.F[0] - bR.F[0]) / s2,
      Math.abs(bL.F[1] - bR.F[1]) / s2,
      Math.abs(bL.F[2] + bR.F[2]) / s2);
  }
  const pass = maxPosErr < 1e-9 && maxVecErr < 1e-9 && maxFErr < 1e-9 &&
    maxFErrRot < 1e-9 && maxRollYawResidual < 1e-6 && maxPitchRel < 1e-9;
  return {
    pass,
    detail: '几何偏差=' + maxPosErr.toExponential(2) + ', 方向偏差=' + maxVecErr.toExponential(2) +
      ', 力镜像误差=' + maxFErr.toExponential(2) + ', 有ω时（ω 按赝矢量反射）力镜像误差=' + maxFErrRot.toExponential(2) +
      ', ΣMx/ΣMy残余=' + maxRollYawResidual.toExponential(2) + ' N·m, ΣMz=' + f(maxPitchVal, 3) +
      ' N·m, ΣMz 相对误差=' + maxPitchRel.toExponential(2) +
      '（约定：镜像面 z=0 => ΣMx=ΣMy=0, ΣMz=2·Mz_R）',
  };
}

/** 差动扑动：左翼 gainMul<1 -> 左翼升力下降、出现净滚转力矩 */
function differentialFlap(kin, stations) {
  const aero = params.aero;
  const c = 1.1;
  const R = kin.state(c, stations, 1, 1);
  const L1 = kin.state(c, stations, -1, 1);
  const L07 = kin.state(c, stations, -1, 0.7);
  const aR = makeAcc(), a1 = makeAcc(), a07 = makeAcc();
  evaluateWing(R, [0, 0, 0], [0, 0, 0], [0, 0, 0], 40, aero, aR);
  evaluateWing(L1, [0, 0, 0], [0, 0, 0], [0, 0, 0], 40, aero, a1);
  evaluateWing(L07, [0, 0, 0], [0, 0, 0], [0, 0, 0], 40, aero, a07);
  const liftDown = a07.F[1] < a1.F[1];
  const roll = aR.M[0] + a07.M[0];
  let scanOk = true;
  for (const gm of [0, 0.3, 0.7, 0.9, 1.3]) {
    const st = kin.state(c, stations, -1, gm);
    for (const s of st) {
      if (!Number.isFinite(s.pos[0] + s.pos[1] + s.pos[2] + s.flap + s.theta + s.area)) scanOk = false;
    }
  }
  const finite = [a1.F[1], a07.F[1], roll].every((v) => Number.isFinite(v));
  const pass = finite && scanOk && liftDown && Math.abs(roll) > 0.05;
  return {
    pass,
    detail: '左翼 Fy: gainMul=1 -> ' + f(a1.F[1], 3) + ' N, gainMul=0.7 -> ' + f(a07.F[1], 3) +
      ' N（下降 ' + f((1 - a07.F[1] / a1.F[1]) * 100, 1) + '%）；差动滚转 ΣMx=' + f(roll, 3) +
      ' N·m；gainMul 广扫(0~1.3)有限=' + scanOk,
  };
}

// ---------------------------------------------------------------------------
// 二、气动极曲线
// ---------------------------------------------------------------------------
function testAero() {
  section('二、气动极曲线（Viterna 失速后）');
  const A = params.aero;
  const p0 = polar(0, A);
  check(EXTRA, 'G3 零迎角极曲线', Math.abs(p0.cl) < 1e-12 && Math.abs(p0.cd - A.cd0) < 1e-12,
    'CL=' + p0.cl + ', CD=' + f(p0.cd, 4) + ' (=CD0)');

  let bad = 0, maxCl = 0, maxCd = 0, minCd = Infinity, asymErr = 0, maxDCl = 0, prevCl = null, maxDCd = 0, prevCd = null;
  for (let i = -180; i <= 180; i++) {
    const a = (i * Math.PI) / 180;
    const p = polar(a, A);
    if (!Number.isFinite(p.cl) || !Number.isFinite(p.cd)) { bad++; continue; }
    maxCl = Math.max(maxCl, Math.abs(p.cl)); maxCd = Math.max(maxCd, p.cd); minCd = Math.min(minCd, p.cd);
    const pm = polar(-a, A);
    asymErr = Math.max(asymErr, Math.abs(p.cl + pm.cl), Math.abs(p.cd - pm.cd));
    if (prevCl !== null) {
      maxDCl = Math.max(maxDCl, Math.abs(p.cl - prevCl));
      maxDCd = Math.max(maxDCd, Math.abs(p.cd - prevCd));
    }
    prevCl = p.cl; prevCd = p.cd;
  }
  check(EXTRA, 'G4 极曲线全迎角有限/连续/反对称/CD>0',
    bad === 0 && minCd >= 0.005 && maxCl < 1.6 && maxDCl < 0.25 && maxDCd < 0.3 && asymErr < 1e-12,
    '非有限=' + bad + ', |CL|max=' + f(maxCl, 3) + ', CDmin=' + f(minCd, 4) + ', CDmax=' + f(maxCd, 3) +
    ', 1° 最大跳变 dCL=' + f(maxDCl, 4) + ', 反对称误差=' + asymErr.toExponential(2));

  // 静止时单翼段气动力应可忽略（V 下限 0.08 m/s）
  const kin = new WingKinematics(params);
  const stations = [];
  for (let i = 0; i < params.strips; i++) stations.push((i + 0.5) / params.strips);
  const st = kin.state(2.0, stations, 1);
  // 用 evaluateWing 汇总（贴近实际调用路径）
  const acc = makeAcc();
  evaluateWing(st, [0, 0, 0], [0, 0, 0], [0, 0, 0], 0, A, acc);
  const fmax = Math.hypot(...acc.F);
  check(EXTRA, 'G5 静止且不扑动时气动力可忽略', fmax < 0.05,
    '单翼合力=' + f(fmax, 5) + ' N (V 下限 0.08 m/s 的数值下限)');
}

// ---------------------------------------------------------------------------
// 三、油门扫掠
// ---------------------------------------------------------------------------
function printSweepTable(sims) {
  console.log('');
  console.log('  油门    f(Hz)   L/W     I(A)    P(W)    η       Tmax(°C)  Vmin(V)  SOCmin');
  console.log('  ' + '-'.repeat(76));
  for (const s of sims) {
    console.log(
      '  ' + f(s.throttle, 2).padStart(4) +
      '  ' + f(s.fHz, 2).padStart(6) +
      '  ' + f(s.LsW, 2).padStart(6) +
      '  ' + f(s.I, 1).padStart(6) +
      '  ' + f(s.P, 0).padStart(6) +
      '  ' + f(s.eff, 3).padStart(6) +
      '  ' + f(s.tempMax, 1).padStart(8) +
      '  ' + f(s.voltageMin, 2).padStart(7) +
      '  ' + f(s.socMin * 100, 1).padStart(6)
    );
  }
}

function testSweep() {
  section('三、油门 0.1~1.0 扫掠（每档 5 s 仿真，后 30% 取稳态）');
  const throttles = [];
  for (let t = 0.1; t <= 1.0001; t += 0.05) throttles.push(Math.round(t * 100) / 100);
  const t0 = Date.now();
  const sims = throttles.map((t) => simulate(t));
  const simMs = Date.now() - t0;
  printSweepTable(sims);
  info(throttles.length + ' 档 × 5 s × 240 Hz，用时 ' + simMs + ' ms');

  // C1 无 NaN / Infinity
  const badRuns = sims.filter((s) => s.bad.length > 0);
  check(REQUIRED, 'B1 全油门范围任何量无 NaN/Infinity/量级爆炸', badRuns.length === 0,
    badRuns.length === 0 ? throttles.length + ' 档全部有限' :
      badRuns.map((s) => '油门' + f(s.throttle, 2) + ': ' + s.bad.slice(0, 4).join('; ')).join(' | '));

  // C2 稳态电流 > 0
  const nonPos = sims.filter((s) => !(s.I > 0) || !(s.P > 0));
  check(REQUIRED, 'C1 稳态电流 > 0 且电功率 > 0（电机做正功，非发电）', nonPos.length === 0,
    'I: ' + f(sims[0].I, 2) + '~' + f(sims[sims.length - 1].I, 1) + ' A; P: ' +
    f(sims[0].P, 0) + '~' + f(sims[sims.length - 1].P, 0) + ' W; 异常档=' + nonPos.length);

  // C3 频率单调不减
  let monoViol = [];
  for (let i = 1; i < sims.length; i++) {
    if (sims[i].fHz < sims[i - 1].fHz - 0.02) {
      monoViol.push(f(sims[i - 1].throttle, 2) + '→' + f(sims[i].throttle, 2) +
        ': ' + f(sims[i - 1].fHz, 2) + '→' + f(sims[i].fHz, 2) + ' Hz');
    }
  }
  check(REQUIRED, 'D1 扑动频率（周期平均）随油门单调不减', monoViol.length === 0,
    monoViol.length === 0 ? f(sims[0].fHz, 2) + ' Hz → ' + f(sims[sims.length - 1].fHz, 2) + ' Hz (共 ' + sims.length + ' 档，容差 0.02 Hz)'
      : monoViol.join(' | '));

  // C4 L/W 悬停窗口
  const hoverPts = sims.filter((s) => s.throttle >= 0.80 - 1e-9 && s.throttle <= 1.00 + 1e-9);
  const outside = hoverPts.filter((s) => s.LsW < 0.7 || s.LsW > 1.8);
  check(REQUIRED, 'E1 0.80~1.00 油门升重比 L/W 落于 0.7~1.8', outside.length === 0,
    hoverPts.map((s) => '油门' + f(s.throttle, 2) + ' L/W=' + f(s.LsW, 2)).join(', ') +
    (outside.length ? '  ← 越界 ' + outside.length + ' 档' : ''));
  // 悬停点插值（信息性）
  let hoverTh = null;
  for (let i = 1; i < sims.length; i++) {
    const a = sims[i - 1], b = sims[i];
    if ((a.LsW - 1) * (b.LsW - 1) <= 0 && a.LsW !== b.LsW) {
      hoverTh = a.throttle + ((1 - a.LsW) / (b.LsW - a.LsW)) * (b.throttle - a.throttle);
      break;
    }
  }
  info('L/W=1 的悬停油门约 ' + (hoverTh === null ? '未在扫掠范围内' : f(hoverTh, 3)) +
    '；0.80~1.00 档 L/W=' + f(Math.min(...hoverPts.map((s) => s.LsW)), 2) + '~' + f(Math.max(...hoverPts.map((s) => s.LsW)), 2));

  // C5 功率关系
  const effBad = sims.filter((s) => !(s.eff >= 0 && s.eff <= 1) || !s.effOk || s.pwrGapMin < -1e-9);
  check(REQUIRED, 'F1 电功率 >= 机械功率，效率 ∈ [0,1]', effBad.length === 0,
    "窗口效率 " + f(sims[0].eff, 3) + '~' + f(sims[sims.length - 1].eff, 3) +
    '，逐步 min(P_elec-P_mech)=' + minOf(sims.map((s) => s.pwrGapMin)).toExponential(2) + ' W');
  void effBad;

  // C6 电气/热/电量边界
  const bndBad = sims.filter((s) =>
    s.tempMax > params.motor.tempMax || s.voltageMin < 0.5 || s.voltageMax > params.battery.cells * params.battery.cellV + 0.5 ||
    s.socMin < 0 || s.socMin > 1);
  check(REQUIRED, 'C2 电压/温度/电量处于物理边界内', bndBad.length === 0,
    'V=' + f(minOf(sims.map((s) => s.voltageMin)), 2) + '~' + f(maxOf(sims.map((s) => s.voltageMax)), 2) +
    ' V, Tmax=' + f(maxOf(sims.map((s) => s.tempMax)), 1) + ' °C (上限 ' + params.motor.tempMax + '), SOCmin=' +
    f(minOf(sims.map((s) => s.socMin)) * 100, 2) + '%');

  // C7 曲柄单向
  const revBad = sims.filter((s) => s.omegaStepNeg || s.omegaMin < 0);
  check(REQUIRED, 'C3 曲柄角速度非负（单向旋转）', revBad.length === 0,
    'omega ' + f(minOf(sims.map((s) => s.omegaMin)), 2) + '~' + f(maxOf(sims.map((s) => s.omegaMax)), 1) + ' rad/s');

  // C8 六步换向扇区
  const secBad = sims.filter((s) => s.sectors.length !== 6);
  check(EXTRA, 'G6 BLDC 六步换向：6 个扇区全部出现', secBad.length === 0,
    '各档扇区数=' + [...new Set(sims.map((s) => s.sectors.length))].join('/') + '，例：油门0.10 -> [' +
    sims[0].sectors.join(',') + ']');

  // C9 鲁棒性（前飞 + 风）
  const rb = simulate(0.85, { wind: [0.8, 0, 0.3], forward: 3 });
  check(EXTRA, 'G7 前飞 3 m/s + 风扰下仍有限', rb.bad.length === 0,
    'L/W=' + f(rb.LsW, 2) + ', I=' + f(rb.I, 1) + ' A' + (rb.bad.length ? ', 异常: ' + rb.bad.slice(0, 3).join('; ') : ''));

  // C10 可重复性
  const rep1 = simulate(0.85);
  const rep2 = simulate(0.85);
  const repErr = Math.max(Math.abs(rep1.fHz - rep2.fHz), Math.abs(rep1.LsW - rep2.LsW), Math.abs(rep1.I - rep2.I));
  check(EXTRA, 'G8 同参数两次仿真结果一致（确定性）', repErr < 1e-9,
    '最大差异=' + repErr.toExponential(2));

  return sims;
}

const minOf = (a) => a.reduce((m, v) => Math.min(m, v), Infinity);
const maxOf = (a) => a.reduce((m, v) => Math.max(m, v), -Infinity);

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
function summarize() {
  const hard = results.filter((r) => r.level === REQUIRED);
  const extra = results.filter((r) => r.level === EXTRA);
  const hardPass = hard.filter((r) => r.pass).length;
  const extraPass = extra.filter((r) => r.pass).length;

  section('测试汇总');
  console.log('  硬性断言: ' + hardPass + '/' + hard.length + ' 通过' + (hard.length - hardPass ? '，' + (hard.length - hardPass) + ' 失败' : ''));
  console.log('  附加不变式: ' + extraPass + '/' + extra.length + ' 通过' + (extra.length - extraPass ? '，' + (extra.length - extraPass) + ' 失败' : ''));

  if (hardFail > 0) {
    console.log('\n  失败项:');
    for (const r of hard.filter((x) => !x.pass)) console.log('   - ' + r.name + '  ' + r.detail);
  }
  if (extraFail > 0) {
    console.log('\n  警告项（附加不变式，默认不影响退出码，--strict 下视为失败）:');
    for (const r of extra.filter((x) => !x.pass)) console.log('   - ' + r.name + '  ' + r.detail);
  }

  const failed = STRICT ? hardFail + extraFail : hardFail;
  console.log('');
  if (failed === 0) {
    console.log('  结果: ✅ 通过' + (extraFail && !STRICT ? '（存在 ' + extraFail + ' 项附加警告）' : ''));
  } else {
    console.log('  结果: ❌ 失败（' + failed + ' 项）');
  }
  console.log('');
  process.exitCode = failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
try {
  console.log('物理自检 · bionic-ornithopter');
  console.log('质量=' + params.mass + ' kg, 重力=' + f(params.mass * 9.81, 3) + ' N, 积分步长=' + f(SUB * 1000, 3) + ' ms' +
    (STRICT ? '（--strict 模式）' : ''));
  testLinkage();
  testAero();
  testSweep();
  summarize();
} catch (e) {
  console.error('\n  ❌ 测试脚本异常: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
}
