// ---------------------------------------------------------------------------
// 动力传动机构：三相无刷电机 + 同步带一级减速 + 曲柄摇杆四连杆 + 扭力管
// 全部零件按仿真中的真实角度驱动
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { PALETTE } from './scene.js';

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3();

function rod(mat) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 10), mat);
  m.castShadow = true;
  return m;
}
function setRod(m, a, b, r) {
  _a.copy(a); _b.copy(b);
  _d.subVectors(_b, _a);
  const len = _d.length() || 1e-5;
  m.position.copy(_a).addScaledVector(_d, 0.5);
  m.scale.set(r, len, r);
  m.quaternion.setFromUnitVectors(UP, _d.normalize());
}

export class Mechanism {
  constructor(cfg) {
    this.cfg = cfg;
    this.group = new THREE.Group();
    this.group.name = 'mechanism';
    this.rotorAngle = 0;
    this.beltPhase = 0;

    const m = cfg.mech;
    // 平面坐标: u = z, v = y
    this.O2 = { u: 0, v: -0.017 };            // 曲柄中心
    this.O4 = { u: 0, v: this.O2.v + m.ground }; // 摇杆(扭力管)中心
    this.crankA = m.crank;
    this.crankB = m.coupler;
    this.crankC = m.rocker;

    const carbon = new THREE.MeshStandardMaterial({ color: 0x161c24, metalness: 0.55, roughness: 0.4 });
    const alloy = new THREE.MeshStandardMaterial({ color: 0x93a2b2, metalness: 1, roughness: 0.26 });
    const brass = new THREE.MeshStandardMaterial({ color: 0x8d6a34, metalness: 0.95, roughness: 0.42 });
    const copper = new THREE.MeshStandardMaterial({ color: 0xa9612f, metalness: 0.95, roughness: 0.4 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x232c36, metalness: 0.7, roughness: 0.5 });
    this.mats = { carbon, alloy, brass, copper };

    // ---------------- 无刷电机 ----------------
    const motor = new THREE.Group();
    motor.position.set(-0.062, this.O2.v - 0.003, -0.035);
    // 定子
    const stator = new THREE.Mesh(new THREE.CylinderGeometry(0.0125, 0.0125, 0.016, 20), alloy);
    stator.rotation.z = Math.PI / 2;
    motor.add(stator);
    // 定子齿 (9 槽)
    const phaseCols = [PALETTE.cyan, PALETTE.violet, PALETTE.amber];
    for (let i = 0; i < 9; i++) {
      const ang = (i / 9) * Math.PI * 2;
      const coil = new THREE.Mesh(new THREE.TorusGeometry(0.0128, 0.0026, 6, 14, Math.PI * 0.75),
        new THREE.MeshStandardMaterial({
          color: 0x101418, emissive: phaseCols[i % 3], emissiveIntensity: 0.9,
          metalness: 0.6, roughness: 0.4,
        }));
      coil.rotation.y = Math.PI / 2;
      coil.rotation.x = ang;
      motor.add(coil);
    }
    // 转子钟形壳
    this.rotor = new THREE.Group();
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.0165, 0.0165, 0.018, 24, 1, true), brass);
    bell.rotation.z = Math.PI / 2;
    this.rotor.add(bell);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.0165, 0.0165, 0.002, 24), brass);
    cap.rotation.z = Math.PI / 2;
    cap.position.x = 0.009;
    this.rotor.add(cap);
    // 磁钢
    const magMat = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, metalness: 0.8, roughness: 0.35 });
    for (let i = 0; i < 14; i++) {
      const ang = (i / 14) * Math.PI * 2;
      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.0028, 0.0035), magMat);
      mag.position.set(0, Math.cos(ang) * 0.0145, Math.sin(ang) * 0.0145);
      mag.rotation.x = -ang;
      this.rotor.add(mag);
    }
    // 换向发光环
    this.rotorGlow = new THREE.Mesh(new THREE.TorusGeometry(0.0168, 0.0016, 6, 28),
      new THREE.MeshStandardMaterial({ color: 0x000000, emissive: PALETTE.cyan, emissiveIntensity: 1.6 }));
    this.rotorGlow.rotation.y = Math.PI / 2;
    this.rotorGlow.position.x = -0.0095;
    this.rotor.add(this.rotorGlow);
    motor.add(this.rotor);
    // 电机轴 + 小带轮
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0022, 0.0022, 0.05, 10), alloy);
    shaft.rotation.z = Math.PI / 2;
    shaft.position.x = 0.024;
    motor.add(shaft);
    this.motorPulley = new THREE.Group();
    this.motorPulley.position.x = 0.018;
    const mp = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.005, 16), alloy);
    mp.rotation.z = Math.PI / 2;
    this.motorPulley.add(mp);
    for (let i = 0; i < 14; i++) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.0052, 0.0009, 0.0012), carbon);
      const ang = (i / 14) * Math.PI * 2;
      t.position.set(0, Math.cos(ang) * 0.0062, Math.sin(ang) * 0.0062);
      t.rotation.x = -ang;
      this.motorPulley.add(t);
    }
    motor.add(this.motorPulley);
    // 电机座
    const mount = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.004, 0.03), carbon);
    mount.position.set(-0.004, -0.019, 0);
    motor.add(mount);
    this.motor = motor;
    this.group.add(motor);

    // ---------------- 同步带 ----------------
    const C1 = { u: -0.035, v: this.O2.v - 0.003 };  // 电机带轮中心 (z,y)
    const C2 = { u: 0, v: this.O2.v };               // 曲柄带轮中心
    const r1 = 0.006, r2 = 0.022;
    this.beltPath = [];
    const beltX = -0.044;
    const dz = C2.u - C1.u, dy = C2.v - C1.v;
    const dist = Math.hypot(dz, dy);
    const base = Math.atan2(dy, dz);
    const alpha = Math.acos(Math.max(-1, Math.min(1, (r2 - r1) / dist)));
    const push = (ang, rad, c, tmp) => this.beltPath.push(
      new THREE.Vector3(beltX, c.v + Math.sin(ang) * rad, c.u + Math.cos(ang) * rad));
    // 小带轮：从 base+alpha 绕过外侧到 base+2π-alpha
    const steps1 = 18, steps2 = 34;
    for (let i = 0; i <= steps1; i++) {
      const t = i / steps1;
      push(base + alpha + t * (Math.PI * 2 - 2 * alpha), r1, C1);
    }
    for (let i = 0; i <= steps2; i++) {
      const t = i / steps2;
      push(base - alpha + t * (2 * alpha), r2, C2);
    }
    const beltCurve = new THREE.CatmullRomCurve3(this.beltPath, true);
    const beltGeo = new THREE.TubeGeometry(beltCurve, 160, 0.0016, 5, true);
    const belt = new THREE.Mesh(beltGeo, new THREE.MeshStandardMaterial({
      color: 0x101418, metalness: 0.3, roughness: 0.75,
    }));
    belt.castShadow = true;
    this.group.add(belt);
    // 同步带齿（沿路径运动）
    this.beltTeeth = [];
    const toothGeo = new THREE.BoxGeometry(0.0026, 0.0011, 0.0016);
    this.beltCurve = beltCurve;
    for (let i = 0; i < 30; i++) {
      const t = new THREE.Mesh(toothGeo, dark);
      this.group.add(t);
      this.beltTeeth.push(t);
    }

    // ---------------- 曲柄 + 连杆 ----------------
    this.crankShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0032, 0.0032, 0.062, 12), alloy);
    this.crankShaft.rotation.z = Math.PI / 2;
    this.crankShaft.position.set(-0.026, this.O2.v, this.O2.u);
    this.crankShaft.castShadow = true;
    this.group.add(this.crankShaft);

    // 曲柄带轮
    this.crankPulley = new THREE.Group();
    this.crankPulley.position.set(-0.038, this.O2.v, this.O2.u);
    const cp = new THREE.Mesh(new THREE.CylinderGeometry(r2, r2, 0.006, 24), alloy);
    cp.rotation.z = Math.PI / 2;
    this.crankPulley.add(cp);
    const cpDisc = new THREE.Mesh(new THREE.CylinderGeometry(r2 * 0.82, r2 * 0.82, 0.0072, 24),
      new THREE.MeshStandardMaterial({ color: 0x1c232c, metalness: 0.5, roughness: 0.5 }));
    cpDisc.rotation.z = Math.PI / 2;
    this.crankPulley.add(cpDisc);
    for (let i = 0; i < 30; i++) {
      const ang = (i / 30) * Math.PI * 2;
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.0064, 0.0009, 0.0014), brass);
      t.position.set(0, Math.cos(ang) * (r2 + 0.0004), Math.sin(ang) * (r2 + 0.0004));
      t.rotation.x = -ang;
      this.crankPulley.add(t);
    }
    this.crankPulley.renderOrder = 1;
    this.group.add(this.crankPulley);

    // ---------------- 左右双曲柄摇杆（支持 0~180° 对置相位） ----------------
    this.crankDisc = new THREE.Group();
    this.crankDisc.position.set(-0.012, this.O2.v, this.O2.u);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.0125, 0.0125, 0.005, 22), carbon);
    disc.rotation.z = Math.PI / 2;
    this.crankDisc.add(disc);
    this.group.add(this.crankDisc);

    this.links = [];
    for (let i = 0; i < 2; i++) {
      const sSign = i === 0 ? 1 : -1;
      const xOff = -0.012 - i * 0.011;
      const rz = sSign * 0.030;
      const crankArm = rod(carbon);
      this.group.add(crankArm);
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.0024, 0.0024, 0.008, 10), alloy);
      pin.rotation.z = Math.PI / 2;
      this.group.add(pin);
      const coupler = rod(alloy);
      this.group.add(coupler);
      const rocker = new THREE.Group();
      rocker.position.set(xOff, this.O4.v, rz);
      const armM = new THREE.Mesh(new THREE.BoxGeometry(0.005, this.crankC, 0.007), carbon);
      armM.position.y = this.crankC / 2;
      armM.castShadow = true;
      rocker.add(armM);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.007, 12), alloy);
      hub.rotation.z = Math.PI / 2;
      rocker.add(hub);
      const joint = new THREE.Mesh(new THREE.SphereGeometry(0.003, 9, 7), alloy);
      joint.position.y = this.crankC;
      rocker.add(joint);
      this.group.add(rocker);
      // 翼根接头（随扑动角绕 x 轴转）
      const root = new THREE.Group();
      root.position.set(xOff, this.O4.v, rz);
      const stubLen = Math.max(0.008, Math.abs(cfg.rootZ - rz));
      const stub = new THREE.Mesh(new THREE.BoxGeometry(0.010, 0.005, stubLen), carbon);
      stub.position.z = sSign * stubLen / 2;
      stub.castShadow = true;
      root.add(stub);
      const clampM = new THREE.Mesh(new THREE.CylinderGeometry(0.0072, 0.0072, 0.014, 12), alloy);
      clampM.position.z = sSign * (stubLen - 0.006);
      root.add(clampM);
      this.group.add(root);
      this.links.push({ sSign, xOff, rz, crankArm, pin, coupler, rocker, root });
    }

    this._upd = { crank: -1, flap: 1e9, hz: 0 };
  }

  /**
   * @param crankR 右翼曲柄角
   * @param crankL 左翼曲柄角（= crankR + 相位差）
   * @param ctlR   右翼运动学状态 {flap, psi}
   * @param ctlL   左翼运动学状态
   */
  update(crankR, crankL, ctlR, ctlL, motorOmega, dt) {
    const items = [
      { crank: crankR, ctl: ctlR || { flap: 0, psi: 0 } },
      { crank: crankL, ctl: ctlL || { flap: 0, psi: 0 } },
    ];
    for (let i = 0; i < 2; i++) {
      const L = this.links[i];
      const it = items[i];
      const bu = this.crankA * Math.cos(it.crank);
      const bv = this.crankA * Math.sin(it.crank);
      const pinP = new THREE.Vector3(L.xOff, this.O2.v + bv, this.O2.u + bu);
      const psi = it.ctl.psi || 0;
      const rockP = new THREE.Vector3(
        L.xOff, this.O4.v + this.crankC * Math.sin(psi), this.O4.u + this.crankC * Math.cos(psi));
      setRod(L.crankArm, new THREE.Vector3(L.xOff, this.O2.v, this.O2.u), pinP, 0.0021);
      L.pin.position.set(L.xOff, pinP.y, pinP.z);
      setRod(L.coupler, pinP, rockP, 0.0024);
      L.rocker.rotation.x = Math.PI / 2 - psi;
      L.root.rotation.x = it.ctl.flap || 0;
    }
    this.crankDisc.rotation.x = Math.PI / 2 - crankR;

    // 转子视觉转速（高速时降采样，避免频闪）
    const wVis = Math.min(Math.abs(motorOmega), 90);
    this.rotorAngle += wVis * dt * Math.sign(motorOmega || 1);
    this.rotor.rotation.x = this.rotorAngle;
    this.motorPulley.rotation.x = this.rotorAngle;
    this.crankPulley.rotation.x = Math.PI / 2 - crankR;

    // 同步带齿
    const speed = (Math.min(Math.abs(motorOmega), 1600) * 0.006) / 0.16;
    this.beltPhase = (this.beltPhase + dt * speed * 0.6) % 1;
    const n = this.beltTeeth.length;
    const phase = Number.isFinite(this.beltPhase) ? this.beltPhase : 0;
    for (let i = 0; i < n; i++) {
      let t = (i / n + phase) % 1;
      if (!(t >= 0)) t = 0;
      t = Math.min(0.9995, t);
      const p = this.beltCurve.getPointAt(t);
      const p2 = this.beltCurve.getPointAt(Math.min(0.9995, t + 0.004));
      const tooth = this.beltTeeth[i];
      tooth.position.copy(p);
      _d.subVectors(p2, p).normalize();
      tooth.quaternion.setFromUnitVectors(UP, _d);
    }

    // 换向指示灯
    const col = new THREE.Color(PALETTE.cyan);
    this.rotorGlow.material.emissive.copy(col);
    this.rotorGlow.material.emissiveIntensity = 1.0 + 0.9 * Math.sin(crankR * 6);
  }
}
