// ---------------------------------------------------------------------------
// 启动与主循环
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { createViewport, PALETTE } from './scene.js';
import { buildAirframe } from './airframe.js';
import { WingMesh } from './wingMesh.js';
import { Mechanism } from './mechanism.js';
import { Vfx } from './vfx.js';
import { Sim, SUBSTEP } from './sim.js';
import { UI } from './ui.js';
import { params } from './config.js';

const DEFAULTS = JSON.parse(JSON.stringify(params));

const canvas = document.getElementById('scene');
const view = createViewport(canvas);
const { scene, camera, controls, renderer, composer, sun } = view;

// ---------- 仿真 ----------
const sim = new Sim(params);

// ---------- 机体 ----------
const craft = new THREE.Group();
craft.name = 'craft';
scene.add(craft);
const airframe = buildAirframe();
craft.add(airframe.group);

const wings = [new WingMesh(params, sim.kin, 1), new WingMesh(params, sim.kin, -1)];
for (const w of wings) craft.add(w.group);

const mech = new Mechanism(params);
craft.add(mech.group);

const vfx = new Vfx(scene, params);

// 机身内部一盏暖光，制造"机械核心"的感觉
const coreLight = new THREE.PointLight(0xffb04a, 0.55, 0.9, 2);
coreLight.position.set(-0.03, 0.02, 0);
craft.add(coreLight);

// ---------- UI ----------
const ui = new UI({
  params, sim, vfx,
  actions: {
    resetParams() {
      // 参数全部回到默认值：重载页面最稳妥（连杆几何与机构网格在启动时构建）
      Object.assign(params, JSON.parse(JSON.stringify(DEFAULTS)));
      location.reload();
    },
    onParamChange(key) {
      sim.dt.refresh();
      if (key === 'cells' || key === 'kv') {
        sim.dt.voltage = params.battery.cells * params.battery.cellV;
      }
    },
    reset() {
      Object.assign(params, JSON.parse(JSON.stringify(DEFAULTS)));
      sim.reset(1.7);
      sim.setMode(ui.state.mode);
      ui.state.altTarget = 1.7;
      ui.state.throttle = 0.8;
      const d = ui.defs.find((x) => x.it.key === 'throttle');
      if (d) { d.input.value = 80; d.input.dispatchEvent(new Event('input')); }
      const da = ui.defs.find((x) => x.it.key === 'altTarget');
      if (da) { da.input.value = 1.7; da.input.dispatchEvent(new Event('input')); }
      airframe.setCutaway(false);
      specInit = false;
    },
    launch() {
      ui.setMode('hover');
      sim.reset(0.35);
      sim.altTarget = 2.0;
      ui.state.altTarget = 2.0;
      const da = ui.defs.find((x) => x.it.key === 'altTarget');
      if (da) { da.input.value = 2.0; da.input.dispatchEvent(new Event('input')); }
    },
    setCutaway(v) { airframe.setCutaway(v); },
    setView(v) { presetView(v); },
  },
});

// ---------- 相机 ----------
let preset = 'orbit';
let tween = null;
const camAnchor = new THREE.Vector3(0, 1.7, 0);
const tmpTarget = new THREE.Vector3();
const mechPoint = new THREE.Vector3(-0.03, 0.02, 0);

function presetView(v) {
  preset = v;
  if (v === 'orbit') {
    tween = { p0: camera.position.clone(), p1: new THREE.Vector3(1.22, 1.86, 1.40), t0: performance.now(), dur: 700, target: true };
    return;
  }
  if (v === 'follow') {
    tween = { p0: camera.position.clone(), p1: craft.position.clone().add(new THREE.Vector3(1.0, 0.55, 1.55)), t0: performance.now(), dur: 700 };
    return;
  }
  if (v === 'mech') {
    craft.updateMatrixWorld();
    tmpTarget.copy(mechPoint).applyMatrix4(craft.matrixWorld);
    tween = {
      p0: camera.position.clone(),
      p1: tmpTarget.clone().add(new THREE.Vector3(0.52, 0.30, 0.58)),
      t0: performance.now(), dur: 900, targetPos: tmpTarget.clone(),
    };
    return;
  }
  if (v === 'aero') {
    craft.updateMatrixWorld();
    tmpTarget.copy(craft.position);
    tween = {
      p0: camera.position.clone(),
      p1: tmpTarget.clone().add(new THREE.Vector3(0.55, 0.10, 1.85)),
      t0: performance.now(), dur: 900, targetPos: tmpTarget.clone().add(new THREE.Vector3(0, 0.04, 0)),
    };
  }
}

function updateCamera(dt, now) {
  // 跟踪锚点
  let desired = craft.position;
  if (preset === 'mech') {
    craft.updateMatrixWorld();
    desired = tmpTarget.copy(mechPoint).applyMatrix4(craft.matrixWorld).clone();
  } else {
    desired = craft.position;
  }
  const k = 1 - Math.exp(-dt * 4.5);
  const prev = camAnchor.clone();
  camAnchor.lerp(desired, k);
  if (preset !== 'orbit') {
    const d = camAnchor.clone().sub(prev);
    controls.target.add(d);
    camera.position.add(d);
  } else {
    // 固定机位：仅当距离过远时轻微跟随
    const off = camAnchor.clone().sub(prev);
    controls.target.lerp(camAnchor, 0.02);
    camera.position.add(off.multiplyScalar(0.15));
  }

  if (tween) {
    const t = Math.min(1, (now - tween.t0) / tween.dur);
    const e = 1 - Math.pow(1 - t, 3);
    if (tween.p1) camera.position.lerpVectors(tween.p0, tween.p1, e);
    if (tween.targetPos) controls.target.lerp(tween.targetPos, e);
    if (t === 1) tween = null;
  }
  controls.update();
}

// ---------- 主循环 ----------
let last = performance.now();
let acc = 0;
let fps = 60;
let hudTimer = 0, scopeTimer = 0, polarTimer = 0;
let specInit = false;
const clock = new THREE.Clock();

function frame(now) {
  requestAnimationFrame(frame);
  window.__frameCall = (window.__frameCall || 0) + 1;
  try {
    frameBody(now);
  } catch (e) {
    window.__frameErr = String((e && e.stack) || e);
    window.__frameErrCount = (window.__frameErrCount || 0) + 1;
  }
}

let firstFrame = true;
function frameBody(now) {
  // 录像模式：由外部逐帧驱动，主循环只保留 rAF 心跳
  if (window.__STUDIO) { last = now; return; }
  // rAF 时间戳可能早于模块初始化完成时刻，首帧需对齐
  if (firstFrame) { last = now; firstFrame = false; }
  const dtReal = Math.max(0, Math.min(0.06, (now - last) / 1000));
  last = now;
  fps += ((1 / Math.max(dtReal, 1e-4)) - fps) * 0.08;

  const input = ui.readInput();
  const ts = ui.state.paused ? 0 : ui.state.timeScale;
  window.__dbg = { dtReal, ts, acc, hudTimer, paused: ui.state.paused, tsRaw: ui.state.timeScale };
  const simDt = dtReal * ts;
  acc += simDt;
  let steps = 0;
  while (acc >= SUBSTEP && steps < 16) {
    sim.step(SUBSTEP, input);
    acc -= SUBSTEP;
    steps++;
  }
  if (steps === 16) acc = 0;

  applyVisuals(dtReal, now, simDt, false);
}

/**
 * 把仿真状态应用到三维场景并渲染。
 * 录像工具以固定步长手动调用（studio 模式），让输出帧率与仿真解耦。
 */
function applyVisuals(dtReal, now, simDt, studio) {
  const b = sim.body;
  craft.position.set(b.position.x, b.position.y, b.position.z);
  craft.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);

  const ctl = sim.ctl || { flap: 0, psi: 0 };
  const phaseRad = ((params.phaseDeg || 0) * Math.PI) / 180;
  for (const w of wings) w.update(sim.crank + (w.sign < 0 ? phaseRad : 0), 1, sim.wingLoad);
  mech.update(sim.crank, sim.crank + phaseRad, sim.ctlR || ctl, sim.ctlL || ctl,
    sim.dt.omegaCrank * sim.dt.G, simDt);

  sun.position.set(craft.position.x + 3.2, craft.position.y + 5.0, craft.position.z + 2.6);
  sun.target.position.copy(craft.position);
  sun.target.updateMatrixWorld();

  vfx.update(simDt, now / 1000, craft, sim, sim.tele);
  if (!studio) updateCamera(dtReal, now);

  hudTimer += dtReal;
  if (hudTimer > 0.08) { hudTimer = 0; ui.updateHud(sim.tele, fps); }
  scopeTimer += dtReal;
  if (scopeTimer > 0.033) { scopeTimer = 0; ui.drawScope(); }
  polarTimer += dtReal;
  if (polarTimer > 0.12) { polarTimer = 0; ui.drawPolar(sim.tele.alpha); }

  if (view.lite) renderer.render(scene, camera);
  else composer.render();
  if (!specInit) {
    specInit = true;
    document.getElementById('loading').classList.add('done');
    document.getElementById('btn-wind').textContent = '风场 0';
  }
}

// 预热：带定高辅助跑 3 秒，入场时已在稳定悬停
sim.setMode('hover');
for (let i = 0; i < 720; i++) sim.step(SUBSTEP, { throttle: 0.72, pitch: 0, roll: 0, yaw: 0, assist: true });
sim.setMode('hover');
craft.position.set(sim.body.position.x, sim.body.position.y, sim.body.position.z);
camAnchor.copy(craft.position);
controls.target.copy(craft.position);

requestAnimationFrame(frame);
window.__ORNI = {
  sim, view, ui, craft, mech, wings,
  // 录像/离线渲染：固定步长推进 + 手动渲染 + 取帧
  studio: {
    step(dSim) {
      ui.state.paused = true;
      const n = Math.max(1, Math.round(dSim / SUBSTEP));
      const input = ui.readInput();
      for (let i = 0; i < n; i++) sim.step(SUBSTEP, input);
      applyVisuals(dSim, performance.now(), dSim, true);
    },
    setCam(pos, target) {
      camera.position.set(pos[0], pos[1], pos[2]);
      controls.target.set(target[0], target[1], target[2]);
      controls.update();
    },
    grab(q) {
      return document.getElementById('scene').toDataURL('image/jpeg', q || 0.88).split(',')[1];
    },
  },
};
