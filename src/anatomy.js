// ---------------------------------------------------------------------------
// 解剖演示（Anatomy）：爆炸视图 + 部件标签 + 分步原理讲解
// 纯 DOM 标签（3D 投影到屏幕），不依赖额外渲染器
// ---------------------------------------------------------------------------
import * as THREE from 'three';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// 部件表：key / 显示名 / 爆炸方向 / 距离 / 锚点（机体系）/ 说明
export const PARTS = [
  { key: 'membraneR', name: '翼膜 R', dir: V(0, 0.25, 1), dist: 0.55, anchor: V(0, 0.03, 0.34), desc: '柔性膜翼：叶素气动的受力面' },
  { key: 'membraneL', name: '翼膜 L', dir: V(0, 0.25, -1), dist: 0.55, anchor: V(0, 0.03, -0.34), desc: '柔性膜翼：叶素气动的受力面' },
  { key: 'sparR', name: '前缘梁 R', dir: V(0, 0.5, 0.86), dist: 0.5, anchor: V(0, 0.05, 0.3), desc: '碳纤维前缘梁：承受展向弯矩' },
  { key: 'sparL', name: '前缘梁 L', dir: V(0, 0.5, -0.86), dist: 0.5, anchor: V(0, 0.05, -0.3), desc: '碳纤维前缘梁：承受展向弯矩' },
  { key: 'ribs', name: '翼肋 ×6', dir: V(0, 0.8, 0.55), dist: 0.45, anchor: V(0, 0.04, 0.26), desc: '保持弦向形状、传递膜面气动压差' },
  { key: 'claw', name: '翼尖爪', dir: V(0, 0.95, 0.5), dist: 0.5, anchor: V(0, 0.02, 0.52), desc: '翼尖配重与防颤' },
  { key: 'frame', name: '机身骨架', dir: V(0, 0.1, 0), dist: 0.1, anchor: V(0, 0.0, 0), desc: '碳纤维桁架：4 根纵梁 + 6 道环框' },
  { key: 'skin', name: '蒙皮', dir: V(0, 1, 0), dist: 0.45, anchor: V(0, 0.05, 0), desc: '半透明蒙皮（0.20 不透明度）' },
  { key: 'canopy', name: '座舱罩', dir: V(0.2, 1, 0), dist: 0.6, anchor: V(0.1, 0.07, 0), desc: '低阻整流罩' },
  { key: 'nose', name: '头部 / 传感器', dir: V(1, 0.3, 0), dist: 0.42, anchor: V(0.3, 0, 0), desc: '机载视觉/姿态传感器' },
  { key: 'tail', name: 'V 尾 + 尾撑', dir: V(-1, 0.25, 0), dist: 0.5, anchor: V(-0.45, 0.06, 0), desc: '俯仰/偏航气动配平与阻尼' },
  { key: 'avionics', name: '电池 / ESC', dir: V(0, -1, 0), dist: 0.4, anchor: V(-0.15, -0.02, 0), desc: '3S 900 mAh + 三相 ESC（六步换向）' },
  { key: 'motor', name: '无刷电机', dir: V(0, -1, -0.4), dist: 0.6, anchor: V(-0.062, -0.02, -0.035), desc: '外转子 BLDC 900 KV，14 极 9 槽' },
  { key: 'belt', name: '同步带 26:1', dir: V(0, -0.95, 0.25), dist: 0.55, anchor: V(-0.044, -0.017, -0.01), desc: '一级减速：把电机高转速换成大力矩' },
  { key: 'linkage', name: '曲柄摇杆', dir: V(0, -0.8, 0.6), dist: 0.5, anchor: V(-0.012, -0.017, 0.03), desc: '双曲柄销 + 连杆 + 摇臂 → 上下扑动' },
];

const STEPS = [
  {
    title: '整体：一架会自己振翅的机器',
    parts: ['frame', 'skin', 'membraneR', 'membraneL', 'tail'],
    explode: 0,
    cam: { pos: V(1.0, 0.55, 1.05), target: V(0, 0.02, 0) },
    text: '0.40 kg、1.1 m 翼展。全部姿态与力都由实时方程解出：无刷电机 → 26:1 减速 → 曲柄摇杆 → 双翼扑动 → 叶素气动 → 六自由度刚体。',
  },
  {
    title: '翼膜：力从这里产生',
    parts: ['membraneR', 'membraneL'],
    explode: 0.55,
    cam: { pos: V(0.3, 0.75, 1.2), target: V(0, 0.05, 0) },
    text: '每片膜翼沿展向切成 9 段，每段用准定常叶素理论算升力/阻力（线性段 + Viterna 失速后延伸）。膜面会随气动载荷鼓起，压力来自同一套解算。',
  },
  {
    title: '梁与肋：把气动载荷收进机身',
    parts: ['sparR', 'sparL', 'ribs', 'claw'],
    explode: 0.85,
    cam: { pos: V(0.20, 1.05, 1.45), target: V(0, 0.08, 0) },
    text: '前缘碳梁承受展向弯矩，6 根翼肋维持弦向形状，翼尖爪配重抑制颤振。翼面在展向有柔性（根部 0.7×、翼尖 1.3× 扑动幅度）。',
  },
  {
    title: '折叠翼：上扑时收起来',
    parts: ['membraneR', 'claw', 'membraneL'],
    explode: 0.7,
    cam: { pos: V(0.55, 0.45, 1.0), target: V(0, 0.04, 0) },
    text: '上扑阶段翼展沿展向收缩（最多 55%）+ 翼尖上卷，减小迎风面积。实测上扑段阻力功率由约 5 W 降到 1 W 量级，最小瞬时升力由 −0.36 N 变为 +1.29 N。',
  },
  {
    title: '扑动机构：把旋转变成振翅',
    parts: ['linkage', 'crankDisc'],
    explode: 1.0,
    cam: { pos: V(0.30, -0.14, 0.60), target: V(-0.01, -0.02, 0.02) },
    text: '曲柄半径 24 mm、连杆 55 mm、摇杆 32 mm、机架 52 mm，满足 Grashof 条件，摇杆半摆幅 52.6°（全摆幅 105°）。左右各一个曲柄销，相差 180° —— 对置扑动让升力脉冲错峰，脉动从 117% 降到 45%。',
  },
  {
    title: '动力：无刷电机 + 同步带',
    parts: ['motor', 'belt', 'avionics'],
    explode: 1.0,
    cam: { pos: V(0.40, -0.30, 0.48), target: V(-0.04, -0.03, 0.0) },
    text: '外转子 BLDC（14 极 9 槽，900 KV）由 ESC 六步换向驱动；同步带做 26:1 减速。电机负载不是常数——气动广义力按各自相位折算回曲柄，所以风大、桨距兜风时电流升高、转速下降。',
  },
  {
    title: '气动：为什么它能悬停',
    parts: ['membraneR', 'tail'],
    explode: 0.35,
    cam: { pos: V(0.85, 0.35, 0.95), target: V(0, 0.03, 0) },
    text: '下扑时翼面近似垂直来流兜风（阻力型），上扑时刀锋切气——这是"垂直扑动"的本质。对置扑动 + 折叠让整周期升力更平，配合自适应飞控把俯仰 RMS 从 4.74° 压到 1.8°。',
  },
  {
    title: '控制：会感知自己的飞控',
    parts: ['avionics', 'canopy', 'nose'],
    explode: 0.5,
    cam: { pos: V(0.55, 0.42, 0.75), target: V(0, 0.05, 0) },
    text: '控制器在线辨识"油门→垂直加速度"效率，学出悬停油门（HUD 里的 悬停油门估计 ≈86%）；再用扑动相位分 32 bin 的前馈抵消周期性俯仰扰动，并在扑动频率处做陷波。策略参数在 192.168.3.5 上用 CMA-ES 训练。',
  },
];

export class Anatomy {
  constructor({ craft, airframe, wings, mech, view, camera, controls, onStep }) {
    this.craft = craft;
    this.view = view;
    this.camera = camera;
    this.controls = controls;
    this.onStep = onStep;
    this.active = false;
    this.t = 0;          // 当前爆炸系数
    this.target = 0;     // 目标爆炸系数
    this.step = 0;
    this.items = [];     // {key, obj, base, dir, dist, anchor, label}
    this.labels = [];
    this.camTween = null;
    this._v = new THREE.Vector3();
    this._collect(airframe, wings, mech);
    this._buildDom();
  }

  _collect(airframe, wings, mech) {
    const add = (key, obj) => {
      if (!obj) return;
      this.items.push({ key, obj, base: obj.position.clone() });
    };
    const byName = (root, n) => root.getObjectByName(n);
    add('frame', byName(airframe.group, 'frame'));
    add('skin', byName(airframe.group, 'skin'));
    add('canopy', byName(airframe.group, 'canopy'));
    add('nose', byName(airframe.group, 'nose'));
    add('tail', byName(airframe.group, 'tail'));
    add('avionics', byName(airframe.group, 'avionics'));
    for (const w of wings) {
      const s = w.sign > 0 ? 'R' : 'L';
      add('membrane' + s, byName(w.group, 'membrane' + s));
      add('spar' + s, byName(w.group, 'spar' + s));
      add('claw' + s, byName(w.group, 'claw' + s));
      // 翼肋是一个数组，整体平移
      if (w.ribs && w.ribs.length) {
        for (const r of w.ribs) add('ribs', r);
      }
    }
    add('motor', byName(mech.group, 'motor'));
    add('belt', byName(mech.group, 'belt'));
    add('crankDisc', byName(mech.group, 'crankDisc'));
    // 连杆/摇臂：曲柄组里的所有子件整体处理（用 mech.links 的两条连杆）
    for (const L of mech.links || []) {
      add('linkage', L.coupler);
      add('linkage', L.rocker);
      add('linkage', L.crankArm);
    }
  }

  _buildDom() {
    const root = document.createElement('div');
    root.id = 'anatomy-labels';
    document.body.appendChild(root);
    this.labelRoot = root;
    const panel = document.createElement('div');
    panel.id = 'anatomy-panel';
    panel.className = 'hidden';
    panel.innerHTML = [
      '<div class="an-head"><span class="an-badge">解剖</span><h3 id="an-title">—</h3></div>',
      '<p id="an-text"></p>',
      '<div class="an-parts" id="an-parts"></div>',
      '<div class="an-bar">',
      '  <button class="btn" id="an-prev">← 上一步</button>',
      '  <span class="an-step" id="an-step">1/8</span>',
      '  <button class="btn" id="an-next">下一步 →</button>',
      '</div>',
      '<div class="an-explode"><label>爆炸视图</label><input type="range" id="an-explode" min="0" max="100" value="0"><span id="an-explode-v">0%</span></div>',
    ].join('');
    document.body.appendChild(panel);
    this.panel = panel;
    panel.querySelector('#an-prev').onclick = () => this.goto(this.step - 1);
    panel.querySelector('#an-next').onclick = () => this.goto(this.step + 1);
    const ex = panel.querySelector('#an-explode');
    ex.oninput = () => {
      this.manual = true;
      this.target = +ex.value / 100;
      panel.querySelector('#an-explode-v').textContent = ex.value + '%';
    };
  }

  enter() {
    this.active = true;
    this.manual = false;
    document.body.classList.add('anatomy');
    this.panel.classList.remove('hidden');
    this.labelRoot.style.display = 'block';
    this.controls.enabled = false;
    this.goto(0, true);
  }
  exit() {
    this.active = false;
    document.body.classList.remove('anatomy');
    this.panel.classList.add('hidden');
    this.labelRoot.style.display = 'none';
    this.controls.enabled = true;
    for (const it of this.items) it.obj.position.copy(it.base);
    this.t = 0; this.target = 0;
    this._renderLabels([]);
  }

  goto(i, instant) {
    const n = STEPS.length;
    this.step = ((i % n) + n) % n;
    const st = STEPS[this.step];
    if (!this.manual) this.target = st.explode;
    const ex = this.panel.querySelector('#an-explode');
    ex.value = Math.round(this.target * 100);
    this.panel.querySelector('#an-explode-v').textContent = ex.value + '%';
    this.panel.querySelector('#an-title').textContent = st.title;
    this.panel.querySelector('#an-text').textContent = st.text;
    this.panel.querySelector('#an-step').textContent = (this.step + 1) + '/' + n;
    const pl = this.panel.querySelector('#an-parts');
    pl.innerHTML = st.parts.map((k) => {
      const p = PARTS.find((x) => x.key === k);
      return p ? '<span class="an-chip">' + p.name + '</span>' : '';
    }).join('');
    // 相机
    const q = this.craft.quaternion;
    const pos = st.cam.pos.clone().applyQuaternion(q).add(this.craft.position);
    const tgt = st.cam.target.clone().applyQuaternion(q).add(this.craft.position);
    if (instant) {
      this.camera.position.copy(pos);
      this.controls.target.copy(tgt);
      this.controls.update();
    } else {
      this.camTween = { p0: this.camera.position.clone(), p1: pos, t0: this.camera.position.clone(),
        t1: tgt, start: performance.now(), dur: 900 };
    }
    this.stepParts = st.parts;
    if (this.onStep) this.onStep(this.step, st);
  }

  update(dt) {
    if (!this.active) return;
    this.t += (this.target - this.t) * Math.min(1, dt * 5);
    const act = this.stepParts || [];
    for (const it of this.items) {
      const p = PARTS.find((x) => x.key === it.key);
      if (!p) continue;
      const k = act.includes(it.key) ? 1 : 0.35;
      it.obj.position.copy(it.base).addScaledVector(p.dir, this.t * p.dist * k);
    }
    // 相机缓动
    if (this.camTween) {
      const t = Math.min(1, (performance.now() - this.camTween.start) / this.camTween.dur);
      const e = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(this.camTween.p0, this.camTween.p1, e);
      this.controls.target.lerpVectors(this.camTween.t0, this.camTween.t1, e);
      this.controls.update();
      if (t >= 1) this.camTween = null;
    }
    this._renderLabels(act);
  }

  _renderLabels(activeKeys) {
    const q = this.craft.quaternion;
    const cam = this.camera;
    const w = innerWidth, h = innerHeight;
    const wanted = [];
    const seen = new Set();
    for (const it of this.items) {
      if (!activeKeys.includes(it.key)) continue;
      if (seen.has(it.key)) continue;   // 每个部件只出一条标签
      seen.add(it.key);
      const p = PARTS.find((x) => x.key === it.key);
      if (!p) continue;
      const wp = p.anchor.clone().applyQuaternion(q).add(this.craft.position);
      const v = wp.clone().project(cam);
      if (v.z > 1) continue;
      wanted.push({ p, x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h });
    }
    // 复用 DOM
    while (this.labels.length < wanted.length) {
      const el = document.createElement('div');
      el.className = 'an-label';
      this.labelRoot.appendChild(el);
      this.labels.push(el);
    }
    for (let i = 0; i < this.labels.length; i++) {
      const el = this.labels[i];
      const it = wanted[i];
      if (!it) { el.style.display = 'none'; continue; }
      el.style.display = 'block';
      el.style.transform = 'translate(-50%,-50%) translate(' + it.x.toFixed(1) + 'px,' + it.y.toFixed(1) + 'px)';
      el.innerHTML = '<b>' + it.p.name + '</b><span>' + it.p.desc + '</span>';
    }
  }
}

export { STEPS, PARTS as ANATOMY_PARTS };
