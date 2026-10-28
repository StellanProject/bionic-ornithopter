// ---------------------------------------------------------------------------
// 翼面网格：可变形的翼膜 + 前缘梁 + 翼肋（每帧由运动学驱动，与物理完全同源）
// ---------------------------------------------------------------------------
import * as THREE from 'three';

// 程序化翼膜贴图：半透明膜 + 放射状翅脉
function makeMembraneTexture() {
  const W = 512, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(214,168,124,0.88)');
  grad.addColorStop(0.35, 'rgba(140,178,198,0.66)');
  grad.addColorStop(1, 'rgba(88,150,190,0.5)');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  // 翅脉：从翼根向翼尖放射
  g.lineCap = 'round';
  for (let i = 0; i < 9; i++) {
    const y0 = (i / 8) * H;
    const y1 = y0 + (Math.random() - 0.5) * 26;
    g.strokeStyle = 'rgba(24,44,60,0.85)';
    g.lineWidth = 3.4 - i * 0.22;
    g.beginPath();
    g.moveTo(6, y0 * 0.35 + H * 0.33);
    g.bezierCurveTo(W * 0.32, y0 * 0.75 + H * 0.2, W * 0.62, y1 * 0.95, W, y1);
    g.stroke();
  }
  // 前缘加粗
  g.strokeStyle = 'rgba(20,34,48,0.95)';
  g.lineWidth = 10;
  g.beginPath(); g.moveTo(0, H * 0.5); g.lineTo(W, H * 0.52); g.stroke();
  // 横脉
  g.strokeStyle = 'rgba(30,52,70,0.35)';
  g.lineWidth = 1.2;
  for (let i = 1; i < 9; i++) {
    g.beginPath();
    const y = (i / 9) * H;
    g.moveTo(W * 0.1, y);
    g.quadraticCurveTo(W * 0.55, y + 10, W * 0.98, y + 4);
    g.stroke();
  }
  // 微粒质感
  for (let i = 0; i < 1400; i++) {
    const x = Math.random() * W, y = Math.random() * H;
    g.fillStyle = 'rgba(255,255,255,' + (Math.random() * 0.06).toFixed(3) + ')';
    g.fillRect(x, y, 1.4, 1.4);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function createTube(ringCount, sides, material) {
  const pos = new Float32Array(ringCount * sides * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const idx = [];
  for (let i = 0; i < ringCount - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const a = i * sides + j, b = i * sides + ((j + 1) % sides);
      const cc = (i + 1) * sides + j, d = (i + 1) * sides + ((j + 1) % sides);
      idx.push(a, cc, b, b, cc, d);
    }
  }
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  const t = new THREE.Vector3(), n1 = new THREE.Vector3(), n2 = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0), alt = new THREE.Vector3(1, 0, 0);
  function update(pts, radiusFn) {
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (i === 0) t.subVectors(pts[1], pts[0]);
      else if (i === n - 1) t.subVectors(pts[n - 1], pts[n - 2]);
      else t.subVectors(pts[i + 1], pts[i - 1]);
      t.normalize();
      n1.crossVectors(t, up);
      if (n1.lengthSq() < 1e-8) n1.crossVectors(t, alt);
      n1.normalize();
      n2.crossVectors(t, n1).normalize();
      const rr = radiusFn(i / (n - 1));
      for (let j = 0; j < sides; j++) {
        const ang = (j / sides) * Math.PI * 2;
        const ca = Math.cos(ang) * rr, sa = Math.sin(ang) * rr;
        const o = (i * sides + j) * 3;
        pos[o] = p.x + n1.x * ca + n2.x * sa;
        pos[o + 1] = p.y + n1.y * ca + n2.y * sa;
        pos[o + 2] = p.z + n1.z * ca + n2.z * sa;
      }
    }
    geo.attributes.position.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
  }
  return { mesh, update };
}

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class WingMesh {
  constructor(cfg, kin, sign) {
    this.cfg = cfg;
    this.kin = kin;
    this.sign = sign;
    this.NS = 30;
    this.NC = 6;
    this.stations = [];
    for (let i = 0; i < this.NS; i++) this.stations.push(i / (this.NS - 1));
    this.group = new THREE.Group();
    this.group.name = 'wing' + (sign > 0 ? 'R' : 'L');
    this.billow = 0;

    const tex = makeMembraneTexture();
    this.membraneMat = new THREE.MeshPhysicalMaterial({
      map: tex, color: 0xffffff, metalness: 0.0, roughness: 0.34,
      transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false,
      envMapIntensity: 1.4, clearcoat: 0.85, clearcoatRoughness: 0.4,
      sheen: 0.7, sheenColor: new THREE.Color(0x8fd8ff), emissive: 0x0a1a24,
      emissiveIntensity: 0.10,
    });
    this.membrane = new THREE.Mesh(this._membraneGeometry(), this.membraneMat);
    this.membrane.castShadow = false;
    this.membrane.receiveShadow = false;
    this.membrane.frustumCulled = false;
    this.membrane.renderOrder = 2;
    this.group.add(this.membrane);

    this.sparMat = new THREE.MeshStandardMaterial({ color: 0x161c24, metalness: 0.6, roughness: 0.34 });
    this.spar = createTube(this.NS, 7, this.sparMat);
    this.spar.mesh.castShadow = true;
    this.group.add(this.spar.mesh);

    this.tipMat = new THREE.MeshStandardMaterial({ color: 0x0e1319, metalness: 0.7, roughness: 0.3 });
    this.ribs = [];
    const ribCount = 6;
    const ribGeo = new THREE.BoxGeometry(1, 0.004, 0.0032);
    for (let i = 0; i < ribCount; i++) {
      const m = new THREE.Mesh(ribGeo, this.tipMat);
      m.castShadow = true;
      this.group.add(m);
      this.ribs.push(m);
    }
    // 翼尖爪
    this.claw = new THREE.Mesh(new THREE.ConeGeometry(0.007, 0.045, 7), this.tipMat);
    this.group.add(this.claw);

    // 翼根接头
    this.rootJoint = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.03, 12),
      new THREE.MeshStandardMaterial({ color: 0x2a3644, metalness: 0.85, roughness: 0.28 }));
    this.rootJoint.rotation.x = Math.PI / 2;
    this.group.add(this.rootJoint);
  }

  _membraneGeometry() {
    const { NS, NC } = this;
    const pos = new Float32Array(NS * NC * 3);
    const uv = new Float32Array(NS * NC * 2);
    const idx = [];
    for (let i = 0; i < NS; i++) {
      for (let j = 0; j < NC; j++) {
        const k = i * NC + j;
        uv[k * 2] = j / (NC - 1);
        uv[k * 2 + 1] = i / (NS - 1);
      }
    }
    for (let i = 0; i < NS - 1; i++) {
      for (let j = 0; j < NC - 1; j++) {
        const a = i * NC + j, b = (i + 1) * NC + j;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  }

  chordAt(s) { return this.kin.chordAt(s); }

  /**
   * @param crank 曲柄角
   * @param gainMul 差动扑动系数
   * @param load 翼段法向载荷（4 段），用于翼膜鼓起
   */
  update(crank, gainMul, load) {
    const cfg = this.cfg, sign = this.sign;
    const strips = this.kin.state(crank, this.stations, sign, gainMul);
    const rootZ = sign * cfg.rootZ;
    const geo = this.membrane.geometry;
    const pos = geo.attributes.position.array;
    const span = cfg.span;
    const zs = sign; // 左翼局部 z 取负

    // 载荷鼓起平滑
    const target = (load ? (load[0] + 2 * load[1] + 2 * load[2] + load[3]) / 6 : 0);
    this.billow += (Math.max(-1.4, Math.min(1.4, target * 0.05)) - this.billow) * 0.18;

    for (let i = 0; i < this.NS; i++) {
      const st = strips[i];
      const A = st.A;
      const s = this.stations[i];
      const c = this.chordAt(s);
      const scallop = 1 - 0.075 * Math.pow(s, 1.6) * (0.65 + 0.35 * Math.sin(s * 22.0));
      for (let j = 0; j < this.NC; j++) {
        const t = j / (this.NC - 1);
        const x = -t * c * scallop;
        const camber = Math.sin(Math.PI * t) * (0.055 * c - this.billow * 0.05 * Math.sin(Math.PI * t));
        const y = camber;
        const z = zs * st.r;   // 折叠翼：展向位置由运动学给出（含收缩）
        // A 为行主序 3x3
        const px = A[0] * x + A[1] * y + A[2] * z;
        const py = A[3] * x + A[4] * y + A[5] * z;
        const pz = A[6] * x + A[7] * y + A[8] * z;
        const k = (i * this.NC + j) * 3;
        pos[k] = px;
        pos[k + 1] = py + cfg.rootY;
        pos[k + 2] = pz + rootZ;
      }
    }
    geo.attributes.position.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    // 前缘梁
    const pts = [];
    for (let i = 0; i < this.NS; i++) {
      const st = strips[i];
      const A = st.A;
      const s = this.stations[i];
      const z = zs * st.r;
      pts.push(new THREE.Vector3(
        A[2] * z, A[5] * z + cfg.rootY, A[8] * z + rootZ
      ));
    }
    this.spar.update(pts, (u) => 0.0068 * (1 - 0.55 * u) + 0.0012);

    // 翼肋
    const ribPositions = [0.1, 0.26, 0.43, 0.6, 0.76, 0.9];
    for (let i = 0; i < this.ribs.length; i++) {
      const s = ribPositions[i];
      const idx = Math.min(this.NS - 1, Math.round(s * (this.NS - 1)));
      const st = strips[idx];
      const A = st.A;
      const c = this.chordAt(s);
      const z = zs * st.r;
      const mid = new THREE.Vector3(
        A[0] * (-0.5 * c) + A[2] * z,
        A[3] * (-0.5 * c) + A[5] * z + cfg.rootY,
        A[6] * (-0.5 * c) + A[8] * z + rootZ
      );
      const tip = new THREE.Vector3(
        A[0] * (-c) + A[2] * z,
        A[3] * (-c) + A[5] * z + cfg.rootY,
        A[6] * (-c) + A[8] * z + rootZ
      );
      const dir = tip.clone().sub(mid).normalize();
      const rib = this.ribs[i];
      rib.position.copy(mid);
      rib.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      rib.scale.set(c * 0.94, 1, 1);
    }

    // 翼尖爪
    const last = strips[this.NS - 1];
    const A = last.A;
    const z = zs * last.r;
    this.claw.position.set(A[2] * z, A[5] * z + cfg.rootY, A[8] * z + rootZ);
    const tipDir = new THREE.Vector3(A[0], A[3], A[6]).normalize();
    this.claw.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tipDir);

    // 翼根接头
    this.rootJoint.position.set(-0.01, cfg.rootY, rootZ);
    return strips;
  }
}
