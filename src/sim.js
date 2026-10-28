// ---------------------------------------------------------------------------
// 飞行仿真核心：六自由度刚体(cannon-es) + 扑翼气动 + 无刷电机传动
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import * as CANNON from '../vendor/cannon-es.js';
import { WingKinematics } from './kinematics.js';
import { evaluateWing, makeAcc, stripForce } from './aero.js';
import { Drivetrain } from './drivetrain.js';
import { AdaptiveHover } from './control/adaptive.js';

export const SUBSTEP = 1 / 240;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;

export class Sim {
  constructor(cfg) {
    this.cfg = cfg;
    this.kin = new WingKinematics(cfg);
    this.dt = new Drivetrain(cfg);
    this.stations = [];
    for (let i = 0; i < cfg.strips; i++) this.stations.push((i + 0.5) / cfg.strips);
    this.acc = makeAcc();

    // --- 世界 ---
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.81, 0) });
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.allowSleep = false;
    this.world.solver.iterations = 12;

    const contact = new CANNON.Material('ground');
    this.groundMat = contact;
    this.world.defaultContactMaterial.friction = 0.45;
    this.world.defaultContactMaterial.restitution = 0.18;

    // 地面（用于着陆）
    this.ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), material: contact });
    this.ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(this.ground);

    // 机体：碰撞用小块，转动惯量按翼展设置
    const shape = new CANNON.Box(new CANNON.Vec3(0.17, 0.06, 0.075));
    this.body = new CANNON.Body({
      mass: cfg.mass, shape,
      position: new CANNON.Vec3(0, 1.7, 0),
      material: new CANNON.Material('body'),
    });
    this.body.allowSleep = false;
    this.body.linearDamping = 0.015;
    this.body.angularDamping = 0.02;
    const I = cfg.inertia;
    this.body.inertia.set(I[0], I[1], I[2]);
    this.body.invInertia.set(1 / I[0], 1 / I[1], 1 / I[2]);
    this.body.updateInertiaWorld(true);
    this.world.addBody(this.body);

    // --- 数学临时量 ---
    this.q = new THREE.Quaternion();
    this.invQ = new THREE.Quaternion();
    this.vBody = new THREE.Vector3();
    this.wBody = new THREE.Vector3();
    this.windWorld = new THREE.Vector3();
    this.windBody = new THREE.Vector3();
    this.euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.tmpV = new THREE.Vector3();
    this.tmpF = new THREE.Vector3();
    this.loadTorque = 0;

    // 尾翼气动面
    this.tail = [
      { name: 'HT', eSpan: [0, 0, 1], eChord: [-1, 0, 0], eNormal: [0, 1, 0],
        area: cfg.aero.tailAreaH, pos: [-cfg.aero.tailArm, 0.01, 0] },
      { name: 'VT', eSpan: [0, 1, 0], eChord: [-1, 0, 0], eNormal: [0, 0, 1],
        area: cfg.aero.tailAreaV, pos: [-cfg.aero.tailArm, 0.05, 0] },
    ];

    this.ctlAd = new AdaptiveHover(cfg);
    this.mode = 'hover';
    this.reset();
  }

  reset(alt = 1.7) {
    this.body.position.set(0, alt, 0);
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
    this.body.quaternion.set(0, 0, 0, 1);
    this.body.force.set(0, 0, 0);
    this.body.torque.set(0, 0, 0);
    this.body.wakeUp();
    this.dt.reset();
    this.crank = 0;
    this.time = 0;
    this.altTarget = alt;
    this.altInt = 0;
    this.trimThrottle = 0.80;
    this.gust = new THREE.Vector3();
    this.tetherAlt = alt;
    this.tele = {
      lift: 0, thrust: 0, drag: 0, side: 0, wingForce: 0, net: 0,
      alt: alt, vy: 0, ias: 0, pitch: 0, roll: 0, yaw: 0,
      flapHz: 0, rpm: 0, amp: 0, volt: 11.1, pwr: 0, pwrMech: 0, eff: 0, temp: 25,
      soc: 1, endurance: 0, flapDeg: 0, pitchDeg: 0, tipSpeed: 0, alpha: 0,
      aeroPower: 0, torque: 0, lw: 0, throttle: 0, sector: 0, mode: 'hover',
    };
    this.throttleEff = 0;
    this.ctlR = this.ctlL = this.ctl = null;
    this.anchor = this.cfg && this.cfg.holdPosition ? { x: 0, y: alt, z: 0 } : null;
    this.phaseRad = 0;
    this.tipTrailR = [];
    this.tipTrailL = [];
    this.wingLoad = [0, 0, 0, 0, 0, 0, 0, 0]; // 每翼 4 段法向载荷（用于翼膜鼓起）
  }

  setMode(m) {
    const cfg = this.cfg;
    // 离开"掠式悬停"时恢复原有桨距调度
    if (this.mode === 'scull' && m !== 'scull' && this._savedFeather) {
      cfg.feather0 = this._savedFeather.f0;
      cfg.featherAmp = this._savedFeather.fa;
      cfg.featherHold = this._savedFeather.hold;
      this._savedFeather = null;
    }
    this.mode = m;
    if (m === 'scull') {
      // 掠式(昆虫式)悬停：大桨距 + 小摆幅，桨面几乎贴着扑动方向掠过，
      // 力主要来自"升力"而不是"兜风的阻力"，机体接近竖直以让体轴推力朝上。
      if (!this._savedFeather) {
        this._savedFeather = { f0: cfg.feather0, fa: cfg.featherAmp, hold: cfg.featherHold };
      }
      cfg.feather0 = 1.34;
      cfg.featherAmp = 0.32;
      cfg.featherHold = 0.1;
    }
    this.pitchTrim = m === 'scull' ? 1.30 : 0;
    if (m === 'hover' || m === 'scull') this.altTarget = Math.max(0.8, this.body.position.y);
  }

  /** 世界风（含阵风与湍流） */
  updateWind(t) {
    const w = this.cfg.wind;
    const rad = (w.dir * Math.PI) / 180;
    const base = this.windWorld.set(Math.cos(rad), 0, Math.sin(rad)).multiplyScalar(w.speed);
    const g = base.length() * w.gust;
    const s = w.speed > 0.05 ? 1 : 1;
    this.gust.set(
      (Math.sin(t * 2.31) * 0.6 + Math.sin(t * 7.7 + 1.2) * 0.4) * g,
      (Math.sin(t * 3.7 + 2.1) * 0.7 + Math.sin(t * 9.1) * 0.3) * g * 0.5,
      (Math.sin(t * 5.3 + 0.7) * 0.6 + Math.sin(t * 11.3 + 2.4) * 0.4) * g
    );
    this.windWorld.add(this.gust);
    return this.windWorld;
  }

  step(dt, input) {
    const cfg = this.cfg;
    const b = this.body;
    this.time += dt;
    this.updateWind(this.time);

    // --- 位姿与速度（转机体系） ---
    this.q.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    this.invQ.copy(this.q).invert();
    this.vBody.set(b.velocity.x, b.velocity.y, b.velocity.z).applyQuaternion(this.invQ);
    this.wBody.set(b.angularVelocity.x, b.angularVelocity.y, b.angularVelocity.z).applyQuaternion(this.invQ);
    this.windBody.copy(this.windWorld).applyQuaternion(this.invQ);

    // --- 电机/传动 ---
    const throttleCmd = input.throttle;
    let thr = throttleCmd;
    // Euler 'YXZ': R = Ry(yaw)·Rx(roll)·Rz(pitch)
    // 机体系 +x 前 / +y 上 / +z 右  =>  俯仰绕 z，滚转绕 x，偏航绕 y
    this.euler.setFromQuaternion(this.q, 'YXZ');
    const pitch = this.euler.z, roll = this.euler.x, yaw = this.euler.y;

    // 辅助飞行：高度保持 + 姿态稳定
    let assistTorque = new THREE.Vector3();
    const ctlMode = cfg.controller || 'adaptive';
    if (ctlMode === 'trained' && this._lastCtlMode !== 'trained') {
      this.ctlAd.setPolicy(cfg.trainedPolicy || {});
      this._lastCtlMode = 'trained';
    } else if (ctlMode !== 'trained' && this._lastCtlMode === 'trained') {
      this.ctlAd.setPolicy({ kpP: 3.4, kdP: 0.42, kpR: 3.4, kdR: 0.42, kiP: 0.9, kiR: 0.9, kiGain: 1.2,
        kz: 2.6, kv: 3.2, uTrimRate: 0.028, notchQ: 3.0, ffGain: 3.0, ffGainR: 0.0, ilcRate: 0.9,
        leadBins: 4, vSched: 0, yawKp: 0.55, yawKd: 0.30 });
      this._lastCtlMode = 'adaptive';
    }
    const adaptive = (ctlMode === 'adaptive' || ctlMode === 'trained') &&
      (this.mode === 'hover' || this.mode === 'scull') && input.assist;

    if (adaptive) {
      // ---- 自适应飞控：辨识 + 重复控制 ----
      const vy = b.velocity.y;
      const ay = (vy - (this._prevVy ?? vy)) / Math.max(dt, 1e-5);
      this._prevVy = vy;
      const out = this.ctlAd.step(dt, {
        alt: b.position.y, vy, ay,
        pitch, roll, yaw,
        p: this.wBody.x, q: this.wBody.y, r: this.wBody.z,
        phase: (this.crank / (Math.PI * 2)) % 1,
        flapHz: this.dt.flapHz,
        ias: this.tele.ias,
      }, {
        altTarget: this.altTarget,
        pitchCmd: this.mode === 'scull' ? this.pitchTrim
          : (input.pitchRad != null ? input.pitchRad : clamp(input.pitch, -1, 1) * 0.30),
        rollCmd: input.rollRad != null ? input.rollRad : clamp(input.roll, -1, 1) * 0.36,
      });
      thr = out.throttle;
      assistTorque.set(out.torque[0], out.torque[1], out.torque[2]);
      this.ctlEst = {
        hoverU: this.ctlAd.uTrim, b: this.ctlAd.vert.b, g: this.ctlAd.vert.g,
        Ihat: this.ctlAd.thetaI, ilc: this.ctlAd.uFF,
      };
    } else if ((this.mode === 'hover' || this.mode === 'scull') && input.assist) {
      const alt = b.position.y;
      const vy = b.velocity.y;
      const yawT = 0;
      const altTarget = this.altTarget;
      const vyCmd = clamp((altTarget - alt) * 1.15, -1.1, 1.1);
      const err = vyCmd - vy;
      // 积分项要有足够权限，否则换翼型/换载荷后配平油门超出范围会失控
      this.altInt = clamp(this.altInt + err * dt * 0.9, -1.2, 1.2);
      const thrTrim = this.mode === 'scull' ? 0.55 : this.trimThrottle;
      thr = clamp(thrTrim + err * 0.10 + this.altInt * 0.30, 0.12, 1.0);
      // 姿态：PD + 小积分
      const body = b.position;
      let pitchCmd, rollCmd;
      if (this.mode === 'scull') {
        // 掠式悬停：机体接近竖直(pitchTrim)，用世界水平速度 + 位置积分配平
        this.hxInt = clamp((this.hxInt || 0) + body.x * dt * 0.10, -0.35, 0.35);
        pitchCmd = this.pitchTrim - clamp(b.velocity.x * 0.22, -0.26, 0.26) - this.hxInt * 0.5
          + clamp(input.pitch, -1, 1) * 0.15;
        rollCmd = -clamp(b.velocity.z * 0.22, -0.26, 0.26) + clamp(input.roll, -1, 1) * 0.25;
      } else {
        // 机翼平均推力朝前 -> 抬头才能减速/回中，故位置误差取 +x
        this.hxInt = clamp((this.hxInt || 0) + body.x * dt * 0.14, -0.5, 0.5);
        this.hzInt = clamp((this.hzInt || 0) + body.z * dt * 0.14, -0.4, 0.4);
        const vxCmd = clamp(this.vBody.x * 0.55, -0.35, 0.35);
        const vzCmd = clamp(-this.vBody.z * 0.45, -0.3, 0.3);
        pitchCmd = clamp(input.pitch, -1, 1) * 0.30 + vxCmd + this.hxInt;
        rollCmd = clamp(input.roll, -1, 1) * 0.36 + vzCmd + this.hzInt;
      }
      this.pitchInt = clamp((this.pitchInt || 0) + (pitchCmd - pitch) * dt * 0.9, -0.45, 0.45);
      this.rollInt = clamp((this.rollInt || 0) + (rollCmd - roll) * dt * 0.9, -0.45, 0.45);
      const kp = 3.4, kd = 0.42;
      // τ = Kp·(期望−当前) − Kd·ω + Ki·∫e    （误差为正表示需要正向修正力矩）
      assistTorque.set(
        kp * (rollCmd - roll) - kd * this.wBody.x + 1.2 * this.rollInt,
        -0.55 * (yawT - yaw) - 0.30 * this.wBody.y,
        kp * (pitchCmd - pitch) - kd * this.wBody.z + 1.2 * this.pitchInt
      );
    } else {
      // 手动：升降舵/方向舵/差动扑动
      this.pitchInt = (this.pitchInt || 0) * 0.9;
      this.rollInt = (this.rollInt || 0) * 0.9;
    }
    this.throttleEff = thr;

    // --- 气动 ---
    const acc = this.acc;
    acc.F[0] = acc.F[1] = acc.F[2] = 0;
    acc.M[0] = acc.M[1] = acc.M[2] = 0;
    acc.Q = acc.Qtheta = 0;
    acc.tauLoad = 0;
    acc.wingFx = acc.wingFy = acc.wingFz = 0;
    acc.alphaSum = acc.areaSum = acc.maxV = 0;

    const vArr = [this.vBody.x, this.vBody.y, this.vBody.z];
    const wArr = [this.wBody.x, this.wBody.y, this.wBody.z];
    const windArr = [this.windBody.x, this.windBody.y, this.windBody.z];
    const omegaCrank = this.dt.omegaCrank;
    const rollTrim = this.mode === 'free' ? clamp(input.roll, -1, 1) * 0.22 : 0;
    const gR = 1 + rollTrim, gL = 1 - rollTrim;

    // 左右翼可以是不同相位（对置扑动：phaseDeg=180°，升力脉冲错峰）
    this.phaseRad = ((cfg.phaseDeg || 0) * Math.PI) / 180;
    const crankL = this.crank + this.phaseRad;
    const stR = this.kin.state(this.crank, this.stations, 1, gR);
    const stL = this.kin.state(crankL, this.stations, -1, gL);
    evaluateWing(stR, vArr, wArr, windArr, omegaCrank, cfg.aero, acc);
    evaluateWing(stL, vArr, wArr, windArr, omegaCrank, cfg.aero, acc);
    this.stripsR = stR; this.stripsL = stL;
    this.ctlR = stR.ctl || this.kin.latest;
    this.ctlL = stL.ctl || this.kin.latest;
    this.ctl = this.ctlR;

    // 尾翼
    const elev = clamp(input.pitch, -1, 1) * 0.38;
    const rud = clamp(input.yaw, -1, 1) * 0.34;
    for (const pan of this.tail) {
      let ec = pan.eChord.slice(), en = pan.eNormal.slice();
      if (pan.name === 'HT') {
        const c = Math.cos(elev), s = Math.sin(elev);
        // 绕机体 z 轴偏转（升降舵）
        ec = [-c, -s, 0];
        en = [s, c, 0];
      } else {
        const c = Math.cos(rud), s = Math.sin(rud);
        ec = [-c, 0, -s];
        en = [s, 0, -c];
      }
      const p = pan.pos;
      const vp = [
        vArr[0] + (wArr[1] * p[2] - wArr[2] * p[1]),
        vArr[1] + (wArr[2] * p[0] - wArr[0] * p[2]),
        vArr[2] + (wArr[0] * p[1] - wArr[1] * p[0]),
      ];
      const st = { eSpan: pan.eSpan, eChord: ec, eNormal: en, area: pan.area };
      stripForce(st, vp, windArr, cfg.aero, this.tmpF);
      const F = [this.tmpF[0], this.tmpF[1], this.tmpF[2]];
      acc.F[0] += F[0]; acc.F[1] += F[1]; acc.F[2] += F[2];
      acc.M[0] += p[1] * F[2] - p[2] * F[1];
      acc.M[1] += p[2] * F[0] - p[0] * F[2];
      acc.M[2] += p[0] * F[1] - p[1] * F[0];
    }

    // 机体阻力
    const bd = cfg.bodyDragArea, cd = cfg.bodyCd, rho = cfg.aero.rho;
    for (let i = 0; i < 3; i++) {
      const v = vArr[i] - windArr[i];
      acc.F[i] -= 0.5 * rho * cd * bd[i] * v * Math.abs(v);
    }

    // 施力（转到世界系）
    const Fw = new THREE.Vector3(acc.F[0], acc.F[1], acc.F[2]).applyQuaternion(this.q);
    const Mw = new THREE.Vector3(acc.M[0], acc.M[1], acc.M[2]).applyQuaternion(this.q);
    if (this.mode === 'hover' && input.assist) {
      const at = assistTorque.applyQuaternion(this.q);
      Mw.add(at);
    }
    b.force.set(Fw.x, Fw.y, Fw.z);
    b.torque.set(Mw.x, Mw.y, Mw.z);
    this.Fworld = [Fw.x, Fw.y, Fw.z];
    this.dbg = {
      wingM: [acc.M[0], acc.M[1], acc.M[2]],
      assist: [assistTorque.x, assistTorque.y, assistTorque.z],
      pitch, roll, w: [this.wBody.x, this.wBody.y, this.wBody.z],
    };

    // --- 电机负载与步进 ---
    const tauLoad = acc.tauLoad;
    this.loadTorque = tauLoad;
    this.dt.step(dt, thr, tauLoad, this.ctl.dFlap);
    this.crank += this.dt.omegaCrank * dt;
    if (this.crank > Math.PI * 2) this.crank -= Math.PI * 2;

    // --- 刚体积分 ---
    this.world.step(dt);
    this.body.wakeUp();

    // 风洞模式：平移锁定（只保留转动动力学），用于姿态控制训练/评估
    if (cfg.holdPosition) {
      if (!this.anchor) this.anchor = { x: b.position.x, y: b.position.y, z: b.position.z };
      b.position.set(this.anchor.x, this.anchor.y, this.anchor.z);
      b.velocity.set(0, 0, 0);
    }

    if (this.mode === 'tether') {
      this.body.position.set(0, this.tetherAlt, 0);
      this.body.velocity.set(0, 0, 0);
      this.body.angularVelocity.set(0, 0, 0);
      this.body.quaternion.set(0, 0, 0, 1);
    }
    if (this.body.position.y < 0.06) {
      this.body.position.y = 0.06;
      if (this.body.velocity.y < 0) this.body.velocity.y *= -0.2;
    }

    // --- 遥测 ---
    this.updateTelemetry(dt, acc, pitch, roll, yaw);
    return this.tele;
  }

  updateTelemetry(dt, acc, pitch, roll, yaw) {
    const t = this.tele, b = this.body, cfg = this.cfg;
    const alpha = 1 - Math.exp(-dt / 0.10);
    const weight = cfg.mass * 9.81;
    const v = b.velocity;
    const ias = Math.hypot(v.x - this.windWorld.x, v.y - this.windWorld.y, v.z - this.windWorld.z);
    // 力分解（机体系）
    // 统一用世界坐标分解：升力=竖直分量，推力=水平前向分量
    // （掠式悬停时机体接近竖直，体轴 y 不再是"升力"，只有世界系才可比）
    const Fw = this.Fworld || [0, 0, 0];
    const Fy = Fw[1], Fx = Fw[0], Fz = Fw[2];
    t.lift = lerp(t.lift, Fy, alpha);
    t.thrust = lerp(t.thrust, Fx, alpha);
    t.side = lerp(t.side, Fz, alpha);
    t.drag = lerp(t.drag, Math.hypot(Fx, Fz), alpha);
    t.lw = t.lift / weight;
    t.alt = b.position.y;
    t.vy = v.y;
    t.ias = ias;
    t.pitch = lerp(t.pitch, pitch, alpha);
    t.roll = lerp(t.roll, roll, alpha);
    t.yaw = yaw;
    t.flapDeg = this.ctl ? -(this.ctl.flap * 180) / Math.PI : 0;
    t.pitchDeg = this.ctl ? (this.ctl.theta * 180) / Math.PI : 0;
    t.flapHz = this.dt.flapHz;
    t.rpm = this.dt.rpm;
    t.volt = this.dt.voltage;
    t.pwr = this.dt.pElec;
    t.pwrMech = Math.max(0, this.dt.pMech);
    t.eff = this.dt.efficiency;
    t.temp = this.dt.temp;
    t.soc = this.dt.soc;
    t.endurance = this.dt.flightSeconds;
    t.torque = this.loadTorque;
    t.sector = this.dt.sector;
    t.throttle = this.dt.throttle;
    t.mode = this.mode;
    t.tipSpeed = Math.abs(this.ctl ? this.ctl.dFlap : 0) * this.dt.omegaCrank * cfg.span * 1.3;
    t.alpha = (acc.alphaSum / Math.max(acc.areaSum, 1e-6)) * (180 / Math.PI);
    t.aeroPower = Math.abs(
      (acc.Q * this.ctl.dFlap + acc.Qtheta * this.ctl.dTheta) * this.dt.omegaCrank
    );
    // 翼段法向载荷（用于翼膜鼓起动画）
    this.updateWingLoad();
    // 翼尖轨迹
    this.pushTipTrails(dt);
    return t;
  }

  updateWingLoad() {
    if (!this.stripsR) return;
    const acc = makeAcc();
    const vArr = [this.vBody.x, this.vBody.y, this.vBody.z];
    const wArr = [this.wBody.x, this.wBody.y, this.wBody.z];
    const windArr = [this.windBody.x, this.windBody.y, this.windBody.z];
    const st = this.stripsR;
    const n = st.length;
    for (let i = 0; i < n; i++) {
      const s = st[i];
      const p = s.pos;
      const wf = this.dt.omegaCrank * this.ctl.dFlap;
      const wt = this.dt.omegaCrank * this.ctl.dTheta;
      const vp = [
        vArr[0] + (wArr[1] * p[2] - wArr[2] * p[1]) + wf * s.uFlap[0] + wt * s.uTheta[0],
        vArr[1] + (wArr[2] * p[0] - wArr[0] * p[2]) + wf * s.uFlap[1] + wt * s.uTheta[1],
        vArr[2] + (wArr[0] * p[1] - wArr[1] * p[0]) + wf * s.uFlap[2] + wt * s.uTheta[2],
      ];
      stripForce(s, vp, windArr, this.cfg.aero, this.tmpF);
      const load = this.tmpF[0] * s.eNormal[0] + this.tmpF[1] * s.eNormal[1] + this.tmpF[2] * s.eNormal[2];
      const idx = Math.min(3, Math.floor((i / n) * 4));
      this.wingLoad[idx] = lerp(this.wingLoad[idx], load, 0.25);
    }
  }

  pushTipTrails(dt) {
    const maxPts = 90;
    const add = (arr, s) => {
      const p = s.pos;
      arr.push([p[0], p[1], p[2]]);
      if (arr.length > maxPts) arr.shift();
    };
    if (!this.stripsR) return;
    add(this.tipTrailR, this.stripsR[this.stripsR.length - 1]);
    add(this.tipTrailL, this.stripsL[this.stripsL.length - 1]);
  }
}
