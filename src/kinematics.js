// ---------------------------------------------------------------------------
// 扑翼运动学：曲柄摇杆四连杆 + 俯仰(桨距)调度 + 展向柔性分布
// 机体坐标: +x 前, +y 上, +z 右翼
// 所有输出均为机体坐标系（已镜像、已加翼根偏移）
// ---------------------------------------------------------------------------
import { m3, v3 } from './linalg.js';

const X = [1, 0, 0];
const Z = [0, 0, 1];
const ZSkew = m3.skew(Z);

/** 给定曲柄角, 解四连杆摇杆角 psi (rad)。sign 选择装配分支。 */
export function fourBar(th, mech, sign = 1) {
  const a = mech.crank, b = mech.coupler, c = mech.rocker, d = mech.ground;
  const bu = a * Math.cos(th), bv = a * Math.sin(th); // 曲柄销 B
  const du = -bu, dv = d - bv;                        // B -> O4
  const r = Math.hypot(du, dv);
  if (r < 1e-9) return null;
  let cb = (b * b + r * r - c * c) / (2 * b * r);
  if (cb > 1 || cb < -1) return null;                  // 无法装配
  const beta = Math.acos(cb);
  const ang = Math.atan2(dv, du);
  const phi = ang + sign * beta;
  const au = bu + b * Math.cos(phi), av = bv + b * Math.sin(phi);
  return Math.atan2(av - d, au);
}

/** 扫描整周，选出连续的分支并给出摇杆摆角范围/中位。 */
function analyzeLinkage(mech) {
  const N = 720;
  let best = null;
  for (const sign of [1, -1]) {
    let ok = true, prev = null, mn = Infinity, mx = -Infinity, tv = 0;
    const arr = [];
    for (let i = 0; i <= N; i++) {
      const th = (i / N) * Math.PI * 2;
      const psi = fourBar(th, mech, sign);
      if (psi === null) { ok = false; break; }
      if (prev !== null) {
        let d = psi - prev;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        tv += Math.abs(d);
        if (Math.abs(d) > 0.6) ok = false;
      }
      prev = psi;
      arr.push(psi);
      mn = Math.min(mn, psi); mx = Math.max(mx, psi);
    }
    if (!ok) continue;
    const range = (mx - mn) / 2;
    // 输出端必须是摆动（< 180°），否则不是曲柄摇杆机构
    const score = range >= Math.PI / 2 ? tv + 100 : tv;
    if (!best || score < best.score) best = { sign, arr, mn, mx, tv, N, score, range };
  }
  if (!best) {
    // 退化：退回小角度近似，保证程序可运行
    return { sign: 1, mn: -0.5, mx: 0.5, arr: null, degenerate: true };
  }
  best.psi0 = (best.mn + best.mx) / 2;
  best.range = (best.mx - best.mn) / 2;
  best.ratio = best.range / Math.PI; // 摇杆半摆幅 / π
  // 循环中最大角速比 |dψ/dθ|max（用于俯仰调度归一化）
  let dmax = 0, prev = null;
  for (const v of best.arr) {
    if (prev !== null) dmax = Math.max(dmax, Math.abs((v - prev) / ((Math.PI * 2) / best.N)));
    prev = v;
  }
  best.dpsiMax = dmax;
  return best;
}

// 俯仰(桨距)波形：可削顶正弦；hold 越大越接近方波（真实鸟类/昆虫的快速翻转）
function pitchWave(x, hold) {
  const s = Math.sin(x);
  const p = 1 / (1 + 2.2 * hold);
  return Math.sign(s) * Math.pow(Math.abs(s), p);
}
function pitchWaveD(x, hold, h = 1e-3) {
  return (pitchWave(x + h, hold) - pitchWave(x - h, hold)) / (2 * h);
}

export class WingKinematics {
  constructor(cfg) {
    this.cfg = cfg;
    this.link = analyzeLinkage(cfg.mech);
    // 冲程平面法向轴（绕机体 z 轴倾斜）
    this.axis = [Math.cos(cfg.strokeTilt), Math.sin(cfg.strokeTilt), 0];
    this._cache = new Map();
    this.latest = null;
  }

  /** 折叠系数 0..1：上扑时大于 0（气弹式被动收拢），下扑为 0 */
  foldAt(normalizedRate, gain) {
    // 上扑方向归一化角速度 -> 折叠量（0.45 阈值为饱和点：上扑中段即完全收拢）
    const u = Math.max(0, Math.min(1, -normalizedRate / 0.45));
    const sh = u * u * (3 - 2 * u);
    return Math.max(0, Math.min(0.92, gain)) * sh;
  }

  /** 有效展向位置 r(s) 及其导数（折叠时收缩，物理与视觉共用） */
  spanAt(s, fold) {
    const span = this.cfg.span;
    return span * s * (1 - fold * Math.pow(s, 1.15));
  }
  spanSlope(s, fold) {
    const span = this.cfg.span;
    return span * (1 - fold * 2.15 * Math.pow(s, 1.15));
  }

  /** 展向弦长：线性收缩 + 翼尖收圆（视觉与气动共用同一函数） */
  chordAt(s) {
    const c = this.cfg;
    const base = c.chordRoot + (c.chordTip - c.chordRoot) * s;
    const tip = 1 - (c.tipRound ?? 0.62) * Math.pow(Math.max(0, s - 0.62) / 0.38, 2.2);
    return base * tip;
  }

  /** 曲柄角 -> 翼根扑动角 / 桨距角 及其导数（带缓存，左右翼共用） */
  control(crank) {
    if (this._ctl && this._ctl.crank === crank) return this._ctl;
    const cfg = this.cfg, mech = cfg.mech, sgn = this.link.sign;
    const h = 4e-4;
    const psi = fourBar(crank, mech, sgn);
    const p1 = fourBar(crank + h, mech, sgn);
    const p0 = fourBar(crank - h, mech, sgn);
    let dpsi = 0, d2psi = 0;
    if (psi !== null && p1 !== null && p0 !== null) {
      dpsi = (p1 - p0) / (2 * h);
      const pp = fourBar(crank + 2 * h, mech, sgn);
      const pm = fourBar(crank - 2 * h, mech, sgn);
      if (pp !== null && pm !== null) d2psi = (pp - 2 * psi + pm) / (4 * h * h);
    }
    const gain = cfg.flapGain || 1;
    const flap = (psi === null ? 0 : (psi - this.link.psi0) * gain);
    const dFlap = dpsi * gain;

    // 俯仰（桨距）：由归一化扑动角速度驱动 —— 下扑高速时桨面兜风(约0°)，
    // 上扑时转为刀锋(约90°)，这是扑翼机的核心"被动扭转"机制。
    const dMax = this.link.dpsiMax * gain || 1;
    const flapMax = this.link.range * gain || 1;
    const hold = Math.max(0, Math.min(0.95, cfg.featherHold));
    // 平滑削顶：tanh 饱和，导数处处有界（避免 |x|^q 在 0 处的奇点）
    const K = 2.2;
    const thK = Math.tanh(K);
    const shape = (x) => (1 - hold) * x + hold * (Math.tanh(K * x) / thK);
    const dshape = (x) => {
      const c = 1 / Math.cosh(K * x);
      return (1 - hold) + hold * (K * c * c) / thK;
    };
    // 相位混合：lag=0 纯角速度驱动；lag=π/2 纯位置驱动
    const cl_ = Math.cos(cfg.featherLag), sl_ = Math.sin(cfg.featherLag);
    const nr = dFlap / dMax, np = flap / flapMax;
    const w = cl_ * shape(nr) + sl_ * shape(np);
    const dw = cl_ * dshape(nr) * (d2psi * gain) / dMax + sl_ * dshape(np) * (dpsi * gain) / flapMax;
    const theta = cfg.feather0 - cfg.featherAmp * w;
    const dTheta = -cfg.featherAmp * dw;
    // 上扑折叠：由归一化扑动角速度驱动（上扑越快收得越多），下扑为 0
    const fold = cfg.wingType === 'folding' ? this.foldAt(nr, cfg.foldGain) : 0;
    const out = { crank, flap, dFlap, theta, dTheta, psi, fold, d2Flap: d2psi * gain };
    this._ctl = out;
    return out;
  }

  /**
   * 生成翼面站位状态。
   * @param crank 曲柄角
   * @param stations s ∈ [0,1] 数组
   * @param sign +1 右翼 / -1 左翼
   */
  state(crank, stations, sign, gainMul = 1) {
    const cfg = this.cfg;
    let ctl = this.control(crank);
    if (gainMul !== 1) {
      ctl = { ...ctl, flap: ctl.flap * gainMul, dFlap: ctl.dFlap * gainMul };
    }
    this.latest = ctl;
    const out = [];
    // 注意：翼根偏移用正的 rootZ，左翼由末尾统一做 z 镜像（否则会被镜像两次）
    const rootOff = [0, cfg.rootY, cfg.rootZ];
    const fold = ctl.fold || 0;
    const nSt = stations.length;
    const ds = 1 / Math.max(1, nSt - 1);
    for (let i = 0; i < stations.length; i++) {
      const s = stations[i];
      const shape = 1 + cfg.flex * (2 * s - 1);
      // 折叠时翼尖额外上卷（气弹形状，物理与视觉一致）
      const flapS = ctl.flap * shape + cfg.dihedral * s - fold * (cfg.foldCurl || 0) * Math.pow(s, 2);
      const thetaS = ctl.theta + cfg.twist * s;
      const Rphi = m3.axisAngle(this.axis, flapS);
      const Rtheta = m3.rotZ(thetaS);
      let A = m3.mul(Rphi, Rtheta);
      const chord = this.chordAt(s);
      const r = this.spanAt(s, fold);
      const pLocal = [-0.25 * chord, 0, r]; // 气动中心（1/4 弦）
      let pos = m3.apply(A, pLocal);
      pos = [pos[0] + rootOff[0], pos[1] + rootOff[1], pos[2] + rootOff[2]];
      let eSpan = m3.apply(A, Z);
      let eChord = m3.apply(A, [-1, 0, 0]);
      let eNormal = v3.cross(eChord, eSpan);
      // 扑动方向单位速度 (∂v/∂φ̇)
      let uFlap = v3.cross(this.axis, m3.apply(A, pLocal));
      // 俯仰方向单位速度 (∂v/∂θ̇) = Rφ · (ẑ × (Rθ pLocal))
      let uTheta = m3.apply(Rphi, v3.cross(Z, m3.apply(Rtheta, pLocal)));
      if (sign < 0) {
        // 镜像：M A M，所有矢量的 z 分量取反
        pos = [pos[0], pos[1], -pos[2]];
        eSpan = [eSpan[0], eSpan[1], -eSpan[2]];
        eChord = [eChord[0], eChord[1], -eChord[2]];
        eNormal = [eNormal[0], eNormal[1], -eNormal[2]];
        uFlap = [uFlap[0], uFlap[1], -uFlap[2]];
        uTheta = [uTheta[0], uTheta[1], -uTheta[2]];
        const M = [1, 0, 0, 0, 1, 0, 0, 0, -1];
        A = m3.mul(m3.mul(M, A), M);
      }
      out.push({
        s, r, chord, pos, A,
        eSpan, eChord, eNormal,
        uFlap, uTheta,
        dr: this.spanSlope(s, fold) * ds,
        area: chord * Math.max(0.15, this.spanSlope(s, fold)) * ds,
        flap: flapS, theta: thetaS, fold,
      });
    }
    out.ctl = ctl;
    return out;
  }
}
