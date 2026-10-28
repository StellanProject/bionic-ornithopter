// ---------------------------------------------------------------------------
// 视觉特效：风流线 / 翼尖轨迹 / 力矢量箭头
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { PALETTE } from './scene.js';

function makeLabel(text, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 34px ui-monospace, monospace';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = color; g.shadowBlur = 14;
  g.fillStyle = color;
  g.fillText(text, 128, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, depthTest: false }));
  s.scale.set(0.16, 0.04, 1);
  s.renderOrder = 20;
  return s;
}

class Arrow {
  constructor(color, label, scene) {
    this.group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.55, metalness: 0.3, roughness: 0.5,
    });
    this.shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0055, 1, 8), mat);
    this.head = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.05, 12), mat);
    this.group.add(this.shaft, this.head);
    this.label = makeLabel(label, '#' + new THREE.Color(color).getHexString());
    this.label.position.set(0, 0.05, 0);
    this.group.add(this.label);
    this.group.visible = false;
    scene.add(this.group);
  }
  set(origin, dir, length) {
    if (length < 0.004) { this.group.visible = false; return; }
    this.group.visible = true;
    this.group.position.copy(origin);
    const d = dir.clone().normalize();
    this.shaft.position.copy(d).multiplyScalar(length * 0.5);
    this.shaft.scale.set(1, length, 1);
    this.shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
    this.head.position.copy(d).multiplyScalar(length + 0.02);
    this.head.quaternion.copy(this.shaft.quaternion);
    this.label.position.copy(d).multiplyScalar(length + 0.09);
  }
}

export class Vfx {
  constructor(scene, cfg) {
    this.scene = scene;
    this.cfg = cfg;
    this.showVectors = false;
    this.showFlow = true;

    // ---------- 风流线 ----------
    this.count = 320;
    const streakGeo = new THREE.BoxGeometry(0.0022, 0.0022, 0.42);
    const streakMat = new THREE.MeshBasicMaterial({
      color: 0x7fe9ff, transparent: true, opacity: 0.42,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.streaks = new THREE.InstancedMesh(streakGeo, streakMat, this.count);
    this.streaks.frustumCulled = false;
    this.streaks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.streaks);
    this.sp = [];
    const R = 7;
    for (let i = 0; i < this.count; i++) {
      this.sp.push(new THREE.Vector3(
        (Math.random() - 0.5) * R * 2, (Math.random() - 0.5) * 3.2 + 1.6, (Math.random() - 0.5) * R * 2
      ));
    }
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3(1, 1, 1);
    this._up = new THREE.Vector3(0, 0, 1);

    // ---------- 翼尖轨迹 ----------
    const mk = (col) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(90 * 3), 3));
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({
        color: col, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      l.frustumCulled = false;
      scene.add(l);
      return l;
    };
    this.trailR = mk(PALETTE.cyan);
    this.trailL = mk(PALETTE.violet);

    // ---------- 力矢量 ----------
    this.arrows = {
      lift: new Arrow(PALETTE.green, 'LIFT', scene),
      weight: new Arrow(0x8899aa, 'W', scene),
      thrust: new Arrow(PALETTE.cyan, 'THRUST', scene),
      drag: new Arrow(PALETTE.red, 'DRAG', scene),
      net: new Arrow(PALETTE.amber, 'NET', scene),
    };
    this.FORCE_SCALE = 0.055;
  }

  setVectors(v) {
    this.showVectors = v;
    for (const k in this.arrows) this.arrows[k].group.visible = false;
  }
  setFlow(v) { this.showFlow = v; this.streaks.visible = v; }

  /** @param craft THREE.Group 机体组（世界变换） */
  update(dt, t, craft, sim, tele) {
    // --- 风流线 ---
    if (this.showFlow) {
      const w = sim.windWorld;
      const speed = w.length();
      const downwash = Math.min(2.2, Math.abs(tele.lift) * 0.32 + speed * 0.2);
      const mat = this.streaks.material;
      mat.opacity = 0.10 + Math.min(0.42, speed * 0.045 + 0.10);
      const center = craft.position;
      const dir = speed > 0.05
        ? new THREE.Vector3(w.x, w.y, w.z).normalize()
        : new THREE.Vector3(0, -1, 0);
      const vel = speed > 0.05
        ? w.clone().multiplyScalar(0.55).add(new THREE.Vector3(0, -downwash * 0.35, 0))
        : new THREE.Vector3(0, -downwash, 0);
      this._q.setFromUnitVectors(this._up, dir);
      for (let i = 0; i < this.count; i++) {
        const p = this.sp[i];
        p.addScaledVector(vel, dt);
        // 环绕中心回卷
        if (p.x - center.x > 7) p.x -= 14; else if (p.x - center.x < -7) p.x += 14;
        if (p.z - center.z > 7) p.z -= 14; else if (p.z - center.z < -7) p.z += 14;
        if (p.y - center.y > 4) p.y -= 8; else if (p.y - center.y < -4) p.y += 8;
        this._m.compose(p, this._q, this._s);
        this.streaks.setMatrixAt(i, this._m);
      }
      this.streaks.instanceMatrix.needsUpdate = true;
    }

    // --- 翼尖轨迹 ---
    craft.updateMatrixWorld();
    const updTrail = (line, pts) => {
      const arr = line.geometry.attributes.position.array;
      const n = Math.min(90, pts.length);
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        const v = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(craft.matrixWorld);
        arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z;
      }
      line.geometry.attributes.position.needsUpdate = true;
      line.geometry.setDrawRange(0, n);
    };
    updTrail(this.trailR, sim.tipTrailR);
    updTrail(this.trailL, sim.tipTrailL);

    // --- 力矢量 ---
    if (this.showVectors) {
      const q = craft.quaternion;
      const origin = craft.position.clone();
      const bodyDir = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(q);
      const S = this.FORCE_SCALE;
      this.arrows.lift.set(origin, bodyDir(0, 1, 0), Math.abs(tele.lift) * S);
      this.arrows.weight.set(origin, new THREE.Vector3(0, -1, 0), this.cfg.mass * 9.81 * S);
      this.arrows.thrust.set(origin, bodyDir(1, 0, 0), Math.abs(tele.thrust) * S);
      this.arrows.drag.set(origin, bodyDir(-1, 0, 0), Math.abs(tele.drag) * S * 0.6);
      const netY = tele.lift - this.cfg.mass * 9.81;
      this.arrows.net.set(origin, new THREE.Vector3(0, 1, 0), Math.abs(netY) * S * 1.4);
    }
  }
}
