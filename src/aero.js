// ---------------------------------------------------------------------------
// 准定常叶素理论 (Blade Element, quasi-steady) + Viterna 失速后极曲线
// ---------------------------------------------------------------------------
import { v3 } from './linalg.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/**
 * 翼型极曲线：附着流线性段 + Viterna 平板延伸（含失速后）
 * @returns {{cl:number, cd:number}}
 */
export function polar(alphaRad, A) {
  const as = A.alphaStall;
  const aa = Math.abs(alphaRad);
  const sgn = alphaRad < 0 ? -1 : 1;
  let a = Math.min(aa, Math.PI / 2);
  if (a <= as) {
    return { cl: A.clAlpha * alphaRad, cd: A.cd0 + A.kInd * alphaRad * alphaRad };
  }
  const clS = A.clAlpha * as;
  const cdS = A.cd0 + A.kInd * as * as;
  const cdMax = A.cdMaxBase + A.cdMaxK * A.ar;
  const sinA = Math.sin(as), cosA = Math.cos(as);
  const A2 = ((clS - cdMax * sinA * cosA) * sinA) / (cosA * cosA);
  const B2 = cdS - cdMax * sinA * sinA;
  const s2 = Math.sin(2 * a), c2 = Math.cos(a) * Math.cos(a), s1 = Math.sin(a);
  const cl = (cdMax / 2) * s2 + (A2 * c2) / Math.max(s1, 1e-6);
  const cd = cdMax * s1 * s1 + B2 * c2;
  return { cl: cl * sgn, cd: Math.max(cd, 0.005) };
}

/**
 * 单片翼段的气动力（机体坐标）
 * vPoint: 该点相对空气的速度（机体坐标）, 即 机体速度 + ω×r + 扑动速度
 * W = 相对风 = wind - vPoint
 */
export function stripForce(strip, vPoint, windBody, A, out) {
  const W0 = [windBody[0] - vPoint[0], windBody[1] - vPoint[1], windBody[2] - vPoint[2]];
  const ws = v3.dot(W0, strip.eSpan);
  const W = [W0[0] - ws * strip.eSpan[0], W0[1] - ws * strip.eSpan[1], W0[2] - ws * strip.eSpan[2]];
  let V = Math.hypot(W[0], W[1], W[2]);
  if (V < 0.08) V = 0.08;
  const Wh = [W[0] / V, W[1] / V, W[2] / V];
  const alpha = Math.atan2(v3.dot(Wh, strip.eNormal), v3.dot(Wh, strip.eChord));
  const { cl, cd } = polar(alpha, A);
  const q = 0.5 * A.rho * V * V * strip.area;
  // 法向/切向分解：F = q S (Fn·n + Fd·d)，在任意迎角下都无奇点
  const ca = Math.cos(alpha), sa = Math.sin(alpha);
  const sc = ca >= 0 ? 1 : -1;
  const Fn = cl * ca * sc + cd * sa;
  const Fd = -cl * sa * sc + cd * ca;
  const n = strip.eNormal, d = strip.eChord;
  out[0] = q * (Fn * n[0] + Fd * d[0]);
  out[1] = q * (Fn * n[1] + Fd * d[1]);
  out[2] = q * (Fn * n[2] + Fd * d[2]);
  return { alpha: alpha, V: V, cl, cd, q };
}

/**
 * 积分一整个翼面
 * @param strips WingKinematics.state() 输出
 * @param bodyVel 质心速度(机体坐标)
 * @param omega 机体系角速度
 * @param windBody 机体系风速
 * @param crankOmega 曲柄角速度 (rad/s)
 * @param A aero 参数
 * @param acc 累加器 {F:[3], M:[3], Q:number, Qtheta:number, Fx, Fy, Fz, Fsigned...}
 */
const tmpV = [0, 0, 0];
const tmpF = [0, 0, 0];
export function evaluateWing(strips, bodyVel, omega, windBody, crankOmega, A, acc) {
  const ctl = strips.ctl;
  let q = 0, qt = 0; // 本翼的广义力（用于按各自相位折算曲柄负载）
  for (let i = 0; i < strips.length; i++) {
    const st = strips[i];
    const p = st.pos;
    // 机体刚体运动速度 + 扑动速度
    const wx = omega[0], wy = omega[1], wz = omega[2];
    const wf = crankOmega * ctl.dFlap;
    const wt = crankOmega * ctl.dTheta;
    tmpV[0] = bodyVel[0] + (wy * p[2] - wz * p[1]) + wf * st.uFlap[0] + wt * st.uTheta[0];
    tmpV[1] = bodyVel[1] + (wz * p[0] - wx * p[2]) + wf * st.uFlap[1] + wt * st.uTheta[1];
    tmpV[2] = bodyVel[2] + (wx * p[1] - wy * p[0]) + wf * st.uFlap[2] + wt * st.uTheta[2];
    const info = stripForce(st, tmpV, windBody, A, tmpF);
    const F = [tmpF[0], tmpF[1], tmpF[2]];
    acc.F[0] += F[0]; acc.F[1] += F[1]; acc.F[2] += F[2];
    acc.M[0] += p[1] * F[2] - p[2] * F[1];
    acc.M[1] += p[2] * F[0] - p[0] * F[2];
    acc.M[2] += p[0] * F[1] - p[1] * F[0];
    const qs = F[0] * st.uFlap[0] + F[1] * st.uFlap[1] + F[2] * st.uFlap[2];
    const qts = F[0] * st.uTheta[0] + F[1] * st.uTheta[1] + F[2] * st.uTheta[2];
    q += qs; qt += qts;
    acc.Q += qs;
    acc.Qtheta += qts;
    acc.alphaSum += info.alpha * st.area;
    acc.areaSum += st.area;
    acc.wingFx += F[0]; acc.wingFy += F[1]; acc.wingFz += F[2];
    acc.maxV = Math.max(acc.maxV, info.V);
  }
  // 该翼对曲柄的反作用力矩（各自相位，不能共用一个 ctl）
  acc.tauLoad += -(q * ctl.dFlap + qt * ctl.dTheta);
}

export function makeAcc() {
  return {
    F: [0, 0, 0], M: [0, 0, 0], Q: 0, Qtheta: 0, tauLoad: 0,
    wingFx: 0, wingFy: 0, wingFz: 0,
    alphaSum: 0, areaSum: 0, maxV: 0,
  };
}
