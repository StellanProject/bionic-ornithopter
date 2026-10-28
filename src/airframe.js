// ---------------------------------------------------------------------------
// 机体：碳纤维骨架 + 半透明蒙皮 + 头部/尾翼/起落架 + 机载电子
// 坐标：+x 前, +y 上, +z 右
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { PALETTE } from './scene.js';

export function matCarbon(env) {
  return new THREE.MeshStandardMaterial({
    color: 0x1a2028, metalness: 0.55, roughness: 0.38, envMapIntensity: 1.1,
  });
}
export function matAlloy() {
  return new THREE.MeshStandardMaterial({
    color: 0x9aa9b8, metalness: 1.0, roughness: 0.28, envMapIntensity: 1.3,
  });
}
export function matGlow(color, intensity = 2.2, opacity = 1) {
  return new THREE.MeshStandardMaterial({
    color: 0x000000, emissive: color, emissiveIntensity: intensity,
    transparent: opacity < 1, opacity, metalness: 0, roughness: 1,
  });
}

function cylinderBetween(a, b, radius, material, radialSeg = 10) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const geo = new THREE.CylinderGeometry(radius, radius, len, radialSeg, 1, false);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** 平面翼面片（前缘在 x=0 处，弦向 -x，展向 +z） */
export function panelGeometry(chordRoot, chordTip, span, spanSeg = 16, chordSeg = 5, camber = 0.0) {
  const pos = [], idx = [], uv = [];
  for (let i = 0; i <= spanSeg; i++) {
    const s = i / spanSeg;
    const c = THREE.MathUtils.lerp(chordRoot, chordTip, s);
    for (let j = 0; j <= chordSeg; j++) {
      const t = j / chordSeg;
      pos.push(-t * c, Math.sin(Math.PI * t) * camber * c, s * span);
      uv.push(t, s);
    }
  }
  for (let i = 0; i < spanSeg; i++) {
    for (let j = 0; j < chordSeg; j++) {
      const a = i * (chordSeg + 1) + j;
      const b = a + chordSeg + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function buildAirframe() {
  const group = new THREE.Group();
  group.name = 'airframe';
  const carbon = matCarbon();
  const alloy = matAlloy();
  const glowCyan = matGlow(PALETTE.cyan, 2.4);

  // ---------- 碳纤维骨架 ----------
  const frame = new THREE.Group();
  const R = 0.063;
  const xs = [0.20, 0.10, 0.0, -0.10, -0.20, -0.29];
  for (const ang of [Math.PI * 0.25, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75]) {
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const x = THREE.MathUtils.lerp(0.28, -0.34, i / 24);
      const k = Math.max(0.16, 1 - Math.pow(Math.abs(x - 0.02) / 0.34, 2.2));
      const r = R * k * (i < 2 ? 0.55 : 1);
      pts.push(new THREE.Vector3(x, Math.sin(ang) * r, Math.cos(ang) * r));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.0038, 6, false), carbon);
    tube.castShadow = true;
    frame.add(tube);
  }
  // 环形框
  for (const x of xs) {
    const k = Math.max(0.16, 1 - Math.pow(Math.abs(x - 0.02) / 0.34, 2.2));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(R * k, 0.0026, 5, 26), carbon);
    ring.rotation.y = Math.PI / 2;
    ring.position.x = x;
    frame.add(ring);
  }
  group.add(frame);

  // ---------- 半透明蒙皮 ----------
  const prof = [];
  const N = 30;
  for (let i = 0; i <= N; i++) {
    const x = THREE.MathUtils.lerp(0.30, -0.35, i / N);
    const k = Math.max(0.06, 1 - Math.pow(Math.abs(x - 0.02) / 0.345, 2.1));
    prof.push(new THREE.Vector2(R * k * 1.04 + 0.0035, x));
  }
  const skinGeo = new THREE.LatheGeometry(prof, 30);
  skinGeo.rotateZ(-Math.PI / 2);
  const skinMat = new THREE.MeshPhysicalMaterial({
    color: 0x8fb8d4, metalness: 0.0, roughness: 0.22, transparent: true, opacity: 0.20,
    side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 1.0,
    clearcoat: 0.55, clearcoatRoughness: 0.22, sheen: 0.8, sheenColor: new THREE.Color(0x63c8ff),
  });
  const skin = new THREE.Mesh(skinGeo, skinMat);
  skin.renderOrder = 3;
  group.add(skin);

  // ---------- 头部 ----------
  const nosePts = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    nosePts.push(new THREE.Vector2(Math.sin(t * Math.PI * 0.5) * 0.048 + 0.002, t * 0.14));
  }
  const noseGeo = new THREE.LatheGeometry(nosePts, 24);
  noseGeo.rotateZ(-Math.PI / 2);
  const nose = new THREE.Mesh(noseGeo, new THREE.MeshStandardMaterial({
    color: 0x232b35, metalness: 0.65, roughness: 0.26, envMapIntensity: 1.2,
  }));
  nose.position.x = 0.19;
  nose.castShadow = true;
  group.add(nose);

  // 传感器"眼"
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.021, 20, 14), matGlow(PALETTE.cyan, 3.4));
  eye.position.set(0.322, 0.002, 0);
  group.add(eye);
  const eyeRing = new THREE.Mesh(new THREE.TorusGeometry(0.024, 0.0035, 6, 24), alloy);
  eyeRing.position.copy(eye.position);
  eyeRing.rotation.y = Math.PI / 2;
  group.add(eyeRing);
  const eyeLight = new THREE.PointLight(PALETTE.cyan, 0.5, 0.6, 2);
  eyeLight.position.copy(eye.position);
  group.add(eyeLight);

  // ---------- 座舱罩 ----------
  const canopyGeo = new THREE.SphereGeometry(0.062, 26, 16, 0, Math.PI * 2, 0, Math.PI * 0.52);
  const canopyMat = new THREE.MeshPhysicalMaterial({
    color: 0x0a121b, metalness: 0.45, roughness: 0.22, transparent: true, opacity: 0.72,
    clearcoat: 0.8, clearcoatRoughness: 0.16, envMapIntensity: 1.1,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const canopy = new THREE.Mesh(canopyGeo, canopyMat);
  canopy.scale.set(1.28, 0.86, 0.72);
  canopy.position.set(0.10, 0.020, 0);
  canopy.rotation.z = -0.06;
  canopy.renderOrder = 4;
  group.add(canopy);

  // 背脊
  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.010, 0.020), carbon);
  spine.position.set(-0.03, 0.062, 0);
  spine.castShadow = true;
  group.add(spine);

  // 进气口
  for (const s of [1, -1]) {
    const intake = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.010, 0.028, 12), new THREE.MeshStandardMaterial({
      color: 0x2a3441, metalness: 0.8, roughness: 0.35,
    }));
    intake.rotation.z = Math.PI / 2;
    intake.position.set(0.02, 0.028, s * 0.055);
    group.add(intake);
  }

  // ---------- 机翼根部轴承座 ----------
  for (const s of [1, -1]) {
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.019, 0.022, 16), alloy);
    hub.rotation.x = Math.PI / 2;
    hub.position.set(-0.01, 0.035, s * 0.062);
    hub.castShadow = true;
    group.add(hub);
    const flange = new THREE.Mesh(new THREE.TorusGeometry(0.021, 0.003, 6, 18), carbon);
    flange.position.copy(hub.position);
    group.add(flange);
  }

  // ---------- 尾撑 + V 尾 ----------
  const tail = new THREE.Group();
  const tipY = 0.045, tipZ = 0.165, tipX = -0.545;
  for (const s of [1, -1]) {
    const a = new THREE.Vector3(-0.28, 0.012, s * 0.03);
    const b = new THREE.Vector3(tipX, tipY, s * tipZ);
    tail.add(cylinderBetween(a, b, 0.0052, carbon));
    // 尾面
    const span = 0.20, chordR = 0.088, chordT = 0.030;
    const g = panelGeometry(chordR, chordT, span, 12, 4, 0.012);
    const m = new THREE.MeshPhysicalMaterial({
      color: 0x86d8ff, metalness: 0.0, roughness: 0.22, transparent: true, opacity: 0.42,
      side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 1.4,
      clearcoat: 1, sheen: 1, sheenColor: new THREE.Color(0x9fe6ff),
    });
    const surf = new THREE.Mesh(g, m);
    // 面法向朝向上下外侧
    const dir = new THREE.Vector3(0, 0, s).applyAxisAngle(new THREE.Vector3(1, 0, 0), -s * THREE.MathUtils.degToRad(38));
    surf.position.set(tipX, tipY, s * tipZ);
    surf.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize());
    surf.renderOrder = 2;
    tail.add(surf);
    // 前缘杆
    const lePts = [];
    for (let i = 0; i <= 8; i++) lePts.push(new THREE.Vector3(0, 0, (i / 8) * span).applyQuaternion(surf.quaternion).add(surf.position));
    for (let i = 0; i < 8; i++) tail.add(cylinderBetween(lePts[i], lePts[i + 1], 0.0028, carbon, 6));
  }
  // 尾鳍 + 尾灯
  const finG = panelGeometry(0.075, 0.03, 0.11, 8, 3, 0.01);
  const fin = new THREE.Mesh(finG, new THREE.MeshStandardMaterial({
    color: 0x1f2731, metalness: 0.5, roughness: 0.35, side: THREE.DoubleSide,
  }));
  fin.position.set(-0.33, 0.06, 0);
  fin.rotation.z = Math.PI / 2;
  fin.rotation.y = Math.PI / 2;
  tail.add(fin);
  const tailLight = new THREE.Mesh(new THREE.SphereGeometry(0.009, 10, 8), matGlow(PALETTE.red, 3.5));
  tailLight.position.set(-0.55, 0.05, 0);
  tail.add(tailLight);
  group.add(tail);

  // ---------- 起落架 ----------
  for (const s of [1, -1]) {
    const top = new THREE.Vector3(-0.05, -0.03, s * 0.03);
    const knee = new THREE.Vector3(-0.02, -0.10, s * 0.055);
    const foot = new THREE.Vector3(-0.10, -0.135, s * 0.055);
    group.add(cylinderBetween(top, knee, 0.0035, carbon, 6));
    group.add(cylinderBetween(knee, foot, 0.0035, carbon, 6));
    const pad = new THREE.Mesh(new THREE.SphereGeometry(0.009, 8, 6), new THREE.MeshStandardMaterial({ color: 0x0f1318, roughness: 0.9 }));
    pad.position.copy(foot);
    group.add(pad);
  }

  // ---------- 机载电子（电池 / ESC / 飞控） ----------
  const avionics = new THREE.Group();
  const batt = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.032, 0.062), new THREE.MeshStandardMaterial({
    color: 0x101820, metalness: 0.35, roughness: 0.55,
  }));
  batt.position.set(-0.15, -0.022, 0);
  batt.castShadow = true;
  avionics.add(batt);
  for (let i = 0; i < 3; i++) {
    const cell = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.024, 0.056), new THREE.MeshStandardMaterial({
      color: 0x2b3a46, metalness: 0.6, roughness: 0.4,
    }));
    cell.position.set(-0.19 + i * 0.038, -0.022, 0);
    avionics.add(cell);
  }
  const battLed = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.004, 0.05), matGlow(PALETTE.green, 2.6));
  battLed.position.set(-0.207, -0.004, 0);
  avionics.add(battLed);

  // ESC 板
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.004, 0.042), new THREE.MeshStandardMaterial({
    color: 0x0d2a22, metalness: 0.3, roughness: 0.6,
  }));
  pcb.position.set(-0.075, 0.062, 0);
  avionics.add(pcb);
  const caps = [
    [PALETTE.cyan, 0.016], [PALETTE.violet, 0.022], [PALETTE.amber, 0.013],
  ];
  caps.forEach(([col, h], i) => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0055, h, 10),
      new THREE.MeshStandardMaterial({ color: 0x1b2430, metalness: 0.7, roughness: 0.4 }));
    c.position.set(-0.075 + (i - 1) * 0.017, 0.064 + h / 2, 0.012);
    avionics.add(c);
  });
  // 三相线
  const phaseWires = [PALETTE.cyan, PALETTE.violet, PALETTE.amber];
  phaseWires.forEach((col, i) => {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.075, 0.062, -0.008 + i * 0.008),
      new THREE.Vector3(-0.05, 0.075, -0.012 + i * 0.010),
      new THREE.Vector3(-0.02, 0.058, -0.02 + i * 0.012),
      new THREE.Vector3(-0.005, 0.03, -0.03 + i * 0.008),
    ]);
    const wire = new THREE.Mesh(new THREE.TubeGeometry(curve, 16, 0.0026, 5, false),
      new THREE.MeshStandardMaterial({ color: 0x11181f, emissive: col, emissiveIntensity: 0.55, roughness: 0.6 }));
    avionics.add(wire);
  });
  group.add(avionics);

  // 状态灯带
  const strip = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.0018, 0.0035), matGlow(PALETTE.cyan, 1.6));
  strip.position.set(-0.02, 0.03, 0.054);
  group.add(strip);
  const strip2 = strip.clone();
  strip2.position.z = -0.054;
  group.add(strip2);

  group.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });

  function setCutaway(v) {
    skinMat.opacity = v ? 0.03 : 0.20;
    avionics.visible = true;
    frame.visible = true;
  }

  return { group, skin, skinMat, frame, avionics, tail, eye, setCutaway };
}
