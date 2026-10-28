// ---------------------------------------------------------------------------
// 自适应扑翼飞控（"会感知自己"的控制器）
//
//  1) 垂向辨识  a_y = b·u − g。为避免被扑动脉动污染，只用**整周期平均**数据做 RLS；
//     得到 b（油门→垂直加速度效率）与 g，悬停油门 u_h = g/b —— 即"知道自己要多大油门吊住自己"。
//  2) 重复控制  ILC：按扑动相位分 32 bin，逐周期记录每 bin 的平均加速度误差，
//     下一周期用 −err/b 前馈抵消 → 专门吃掉"每扇一下"的脉动。
//  3) 陷波      在扑动频率对阻尼通道做 biquad notch，避免把周期性扰动力放大。
//  4) 惯量      α=τ/I 的标量 RLS（限幅、慢速），仅用于姿态增益缩放（可选）。
// ---------------------------------------------------------------------------
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const NB = 32;

class RLS2 {
  constructor(lambda = 0.999) {
    this.lambda = lambda;
    this.theta = [16, 9.81];          // [b, g]
    this.P = [[2, 0], [0, 2]];
  }
  update(a1, a2, y) {
    const P = this.P;
    const Pphi = [P[0][0] * a1 + P[0][1] * a2, P[1][0] * a1 + P[1][1] * a2];
    const denom = this.lambda + a1 * Pphi[0] + a2 * Pphi[1];
    if (!Number.isFinite(denom) || denom < 1e-9) return;
    const k = [Pphi[0] / denom, Pphi[1] / denom];
    const err = y - (this.theta[0] * a1 + this.theta[1] * a2);
    this.theta[0] = clamp(this.theta[0] + k[0] * err, 8, 60);
    this.theta[1] = clamp(this.theta[1] + k[1] * err, 7, 13);
    const kp0 = k[0] * Pphi[0], kp1 = k[0] * Pphi[1];
    const kq0 = k[1] * Pphi[0], kq1 = k[1] * Pphi[1];
    this.P = [
      [(P[0][0] - kp0) / this.lambda, (P[0][1] - kp1) / this.lambda],
      [(P[1][0] - kq0) / this.lambda, (P[1][1] - kq1) / this.lambda],
    ];
  }
  get b() { return this.theta[0]; }
  get g() { return this.theta[1]; }
}

class Notch {
  constructor(f, fs = 240, q = 3) { this.f = 0; this.x1 = this.x2 = this.y1 = this.y2 = 0; this.set(f, fs, q); }
  set(f, fs = 240, q = 3) {
    if (Math.abs(f - this.f) < 0.05) return;
    const w0 = (2 * Math.PI * f) / fs;
    const al = Math.sin(w0) / (2 * q), c = Math.cos(w0), a0 = 1 + al;
    this.b0 = 1 / a0; this.b1 = (-2 * c) / a0; this.b2 = 1 / a0;
    this.a1 = (-2 * c) / a0; this.a2 = (1 - al) / a0;
    this.f = f;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

export const DEFAULT_POLICY = {
  kpP: 3.4, kdP: 0.42, kpR: 3.4, kdR: 0.42, kiP: 0.9, kiR: 0.9, kiGain: 1.2,
  kz: 2.6, kv: 3.2, uTrimRate: 0.028,
  notchQ: 3.0, ffGain: 3.0, ffGainR: 0.0, ilcRate: 0.9, leadBins: 4,
  vSched: 0.0, yawKp: 0.55, yawKd: 0.30,
};

export class AdaptiveHover {
  constructor(cfg, pol) { this.cfg = cfg; this.pol = Object.assign({}, DEFAULT_POLICY, pol || {}); this.reset(); }
  setPolicy(pol) { Object.assign(this.pol, pol); this.attF[0].set(this.attF[0].f || 5.5, 240, this.pol.notchQ); this.attF[1].set(this.attF[1].f || 5.5, 240, this.pol.notchQ); }

  reset() {
    this.vert = new RLS2();
    this.ilc = new Float64Array(NB);
    this.ilcP = new Float64Array(NB);   // 俯仰力矩前馈
    this.ilcR = new Float64Array(NB);   // 滚转力矩前馈
    this.binRoll = new Float64Array(NB);
    this.binPitch = new Float64Array(NB);
    this.ilcOn = false;
    this.attF = [new Notch(5.5, 240, this.pol ? this.pol.notchQ : 3), new Notch(5.5, 240, this.pol ? this.pol.notchQ : 3)];
    this.u = 0.80;                 // 当前油门
    this.uTrim = 0.80;             // 自适应配平（悬停所需油门，在线学习）
    this.ditherT = 0;
    this.hoverU = 0.62;
    this.thetaI = 0.032;
    this.pInt = 0; this.rInt = 0;
    this.binErr = new Float64Array(NB);
    this.binN = new Float64Array(NB);
    this.binU = new Float64Array(NB);
    this.binAy = new Float64Array(NB);
    this.cycU = 0; this.cycAy = 0; this.cycN = 0;
    this.lastPhase = 0;
    this.cycles = 0;
    this.time = 0;
    this.uFF = 0;
    this.prevR = 0;
  }

  step(dt, s, cmd) {
    this.time += dt;
    const f = clamp(s.flapHz || 5.4, 1.5, 15);
    for (const n of this.attF) n.set(f);

    // ---------- 外环：高度/速度 → 期望垂直加速度 ----------
    const P = this.pol;
    const aCmd = clamp(P.kz * (cmd.altTarget - s.alt) - P.kv * s.vy, -5.0, 5.0);
    const b = Math.max(2, this.vert.b);
    const g = clamp(this.vert.g, 4, 16);

    // 自适应配平：对"加速度误差"做慢积分，学出吊住自重所需的油门（= 自重的代理量）
    const aErrInst = aCmd - s.ay;
    this.uTrim = clamp(this.uTrim + P.uTrimRate * aErrInst * dt, 0.05, 1.05);

    // ---------- 相位 bin ----------
    const ph = (((s.phase % 1) + 1) % 1);
    const bin = Math.min(NB - 1, Math.floor(ph * NB));
    const wrapped = ph < this.lastPhase - 0.5;
    this.lastPhase = ph;

    // ---------- 每周期一次：RLS + ILC 学习 ----------
    if (wrapped && this.cycles >= 1 && this.cycN > NB * 0.5) {
      const uMean = this.cycU / this.cycN;
      const ayMean = this.cycAy / this.cycN;
      this.vert.update(uMean, 1, ayMean);
      for (let i = 0; i < NB; i++) {
        if (this.binN[i] > 0) {
          const err = this.binErr[i] / this.binN[i];       // 该相位的平均加速度误差
          const perr = this.binPitch[i] / this.binN[i];    // 该相位的平均俯仰误差
          if (this.ilcOn) this.ilc[i] = clamp(this.ilc[i] + 0.06 * (err / b), -0.2, 0.2);
          const rerr = this.binRoll[i] / this.binN[i];
          this.ilcP[i] = clamp(this.ilcP[i] + this.pol.ilcRate * perr, -1.2, 1.2);
          this.ilcR[i] = clamp(this.ilcR[i] + this.pol.ilcRate * rerr, -1.2, 1.2);
        }
        this.binErr[i] = 0; this.binN[i] = 0; this.binPitch[i] = 0; this.binRoll[i] = 0;
      }
      this.cycU = 0; this.cycAy = 0; this.cycN = 0;
      this.cycles++;
    }
    // 累积本步数据到当前 bin
    this.binErr[bin] += aCmd - s.ay;
    this.binPitch[bin] += cmd.pitchCmd - s.pitch;
    this.binRoll[bin] += cmd.rollCmd - s.roll;
    this.binN[bin] += 1;
    this.binU[bin] += this.u;
    this.binAy[bin] += s.ay;
    this.cycU += this.u; this.cycAy += s.ay; this.cycN++;
    if (wrapped) this.cycles = Math.max(1, this.cycles);
    this.hoverU = clamp(g / b, 0.05, 1.2);

    // ---------- 油门：自适应配平 + 期望加速度前馈 + 小dither(用于辨识) ----------
    const B0 = 16;                                   // 名义"油门→垂直加速度"效率
    this.ditherT = (this.ditherT || 0) + dt;
    const dither = 0.018 * Math.sin(2 * Math.PI * 0.7 * this.ditherT);
    const uFb = clamp(aCmd / B0, -0.6, 0.6);
    this.uFF = this.ilcOn ? this.ilc[bin] : 0;
    const uTarget = clamp(this.uTrim + uFb + this.uFF + dither, 0, 1);
    this.u += (uTarget - this.u) * Math.min(1, dt * 80);
    this.u = clamp(this.u, 0, 1);

    // ---------- 姿态：PD + 扑动频率陷波 ----------
    const wx = this.attF[0].run(s.p);
    const wz = this.attF[1].run(s.r);
    // 空速调度：气动阻尼随空速增大，增益按 (1 + vSched·V) 放大
    const ias = s.ias || 0;
    const sched = 1 + P.vSched * ias;
    const kpP = P.kpP * sched, kdP = P.kdP * sched;
    const kpR = P.kpR * sched, kdR = P.kdR * sched;
    this.pInt = clamp(this.pInt + (cmd.pitchCmd - s.pitch) * dt * P.kiP, -0.5, 0.5);
    this.rInt = clamp(this.rInt + (cmd.rollCmd - s.roll) * dt * P.kiR, -0.5, 0.5);
    // 相位前馈：提前 2 个 bin（≈22°）补偿执行-响应的时延
    const lead = (bin + Math.round(P.leadBins)) % NB;
    const tzFF = P.ffGain * this.ilcP[lead];
    const txFF = P.ffGainR * this.ilcR[lead];
    const tz = kpP * (cmd.pitchCmd - s.pitch) - kdP * wz + P.kiGain * this.pInt + tzFF;
    const tx = kpR * (cmd.rollCmd - s.roll) - kdR * wx + P.kiGain * this.rInt + txFF;
    const ty = -(P.yawKp * (0 - s.yaw) + P.yawKd * s.q);
    return { throttle: this.u, torque: [tx, ty, tz] };
  }
}
