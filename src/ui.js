// ---------------------------------------------------------------------------
// 交互层：控制面板 / HUD / 示波器 / 极曲线 / 帮助
// ---------------------------------------------------------------------------
import { polar } from './aero.js';
import { SECTORS } from './drivetrain.js';

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

const HELP_HTML = `
<h3>它在做什么</h3>
<p>ORNI-X 是一个完整的扑翼飞行器实时仿真：<b>无刷电机</b>驱动同步带与<b>曲柄摇杆四连杆</b>，把连续旋转变成上下扑动；
两片柔性翼膜每一刻都以<b>叶素理论</b>逐段计算升力与阻力，得到的力与力矩注入 <b>cannon-es 六自由度刚体</b>，
再反过来决定机体的姿态与轨迹。没有任何"动画脚本"——你在画面上看到的每一个角度、每一次抖动，都是解方程解出来的。</p>
<h3>动力链：为什么不是步进电机</h3>
<p>扑翼需要上万转的连续高转速与几十瓦的功率密度，步进电机开环、低速、扭矩随转速骤降，无法驱动扑动机构。
这里用的是<b>三相无刷直流电机（BLDC）+ 电调（ESC）六步换向</b>：转子永磁、定子三相绕组，靠反电动势与霍尔/无感换向依次导通
<code>A+B- → A+C- → B+C- → B+A- → C+A- → C+B-</code> 六个扇区，形成连续转矩。</p>
<p>模型采用准静态电流解 <code>I = (D·Vbus − ω/Kv) / R</code>，电磁转矩 <code>T = I / Kv_rad</code>；
电池内阻造成母线电压跌落，铜损造成温升。<b>电机的负载不是常数</b>——它来自气动力对扑动轴的力矩，
经四连杆雅可比 <code>dφ/dθ</code> 折算到曲柄，所以你会看到：风越大、翼展越大、桨距越"兜风"，电流就越大、转速就越掉。</p>
<h3>扑动机构与"被动扭转"</h3>
<p>曲柄半径 a、连杆 b、摇杆 c、机架 d 构成曲柄摇杆机构（满足 Grashof 条件），摇杆摆角 ψ 由闭式解给出，
翼根转角 <code>φ = k·(ψ − ψ₀)</code>。关键在于俯仰（桨距）角：它由<b>归一化扑动角速度</b>驱动——
下扑最快时桨面接近水平（约 0°）"兜风"产生升力，上扑时翻成约 90° 的"刀锋"切气减小阻力，
两次翻转之间的相位可以用"俯仰相位"滑杆调节，这正是扑翼产生推力/升力配比的核心。</p>
<h3>气动模型</h3>
<p>沿展向把翼面切成 9 段。每段的相对风速 = 机体速度 + 角速度×力臂 + 扑动/扭转速度 − 风速，
投影到弦向/法向平面内得到迎角 α，用 <b>线性段 + Viterna 失速后延伸</b>的极曲线取 CL、CD，
再用法向/切向分解 <code>F = qS(Fn·n + Fd·d)</code> 积分到整个翼面（该分解在 α=±90° 处没有奇点）。</p>
<ul>
<li>把四个力分别显示：<b>LIFT</b> 机体系 +y、<b>THRUST</b> 机体系 +x、<b>DRAG</b> 反向、<b>W</b> 重力。</li>
<li>冲程平面倾角让下扑路径向后掠，于是反作用力朝前——这就是扑翼的推力来源。</li>
<li>风速会改变每段翼的来流，因此风既是扰动，也会改变升力与功耗。</li>
</ul>
<h3>怎么玩</h3>
<ul>
<li><b>悬停辅助</b>：飞控闭环维持目标高度与姿态；<b>自由飞行</b>：切断辅助，纯物理，会翻滚；<b>系留测试</b>：把机体锁在测试台上，直接读升力/推力。</li>
<li>拖动 <b>油门</b> 看升重比 L/W 越过 1；调 <b>目标高度</b> 看飞控如何加/减转速。</li>
<li>拉高 <b>风速</b>，观察电流上升与姿态扰动；打开 <b>力矢量</b> 与 <b>翼尖轨迹</b>（那是一条 8 字轨迹，说明扑动+扭转的耦合）。</li>
<li>调 <b>桨距相位</b>：相位偏一点，推力就会出现；调 <b>冲程倾角</b> 可以前后配平。</li>
<li>快捷键：<code>W/S</code> 油门、<code>A/D</code> 滚转、<code>↑/↓</code> 俯仰、<code>Q/E</code> 偏航、<code>空格</code> 暂停、<code>R</code> 重置。</li>
</ul>
<h3>看什么</h3>
<p>右侧示波器是三相电流与 ESC 占空比；极曲线上的光点是当前翼段的工作点——它会随着扑动在失速区与线性区之间来回跳，
这就是扑翼气动的本质：<b>它靠周期性地越过失速来换取升力</b>。</p>
`;

const CONTROL_GROUPS = [
  {
    title: '动力 · 无刷电机',
    items: [
      { key: 'throttle', label: '油门 / 占空比', min: 0, max: 100, step: 1, unit: '%', get: (s) => s.throttle * 100, set: (s, v) => (s.throttle = v / 100) },
      { key: 'altTarget', label: '目标高度', min: 0.5, max: 4.0, step: 0.05, unit: 'm', hoverOnly: true, get: (s) => s.altTarget, set: (s, v) => (s.altTarget = v) },
      { key: 'kv', label: '电机 KV', min: 600, max: 2200, step: 20, unit: 'rpm/V', path: 'motor.kv' },
      { key: 'cells', label: '电池节数', min: 2, max: 4, step: 1, unit: 'S', path: 'battery.cells' },
      { key: 'gear', label: '减速比', min: 14, max: 40, step: 1, unit: ':1', path: 'mech.gear' },
    ],
  },
  {
    title: '飞控 · 自适应',
    items: [
      { type: 'seg', key: 'controller', options: [['classic', '经典 PD'], ['adaptive', '自适应'], ['trained', '训练后']] },
    ],
  },
  {
    title: '扑动机构 · 四连杆',
    items: [
      { type: 'seg', key: 'wingType', options: [['fixed', '固定膜翼'], ['folding', '折叠翼']] },
      { key: 'phaseDeg', label: '左右相位差', min: 0, max: 180, step: 5, unit: '°', fmt: (v) => v.toFixed(0) + '°' },
      { key: 'foldGain', label: '上扑折叠量', min: 0, max: 0.9, step: 0.01, unit: '', foldOnly: true, fmt: (v) => (v * 100).toFixed(0) + '%' },
      { key: 'foldCurl', label: '折叠翼尖上卷', min: 0, max: 1.2, step: 0.02, unit: '', foldOnly: true, fmt: (v) => v.toFixed(2) },
      { key: 'strokeTilt', label: '冲程平面倾角', min: -0.35, max: 0.35, step: 0.01, unit: '°', deg: true },
      { key: 'feather0', label: '中位桨距', min: 0.25, max: 1.33, step: 0.01, unit: '°', deg: true },
      { key: 'featherAmp', label: '桨距摆幅', min: 0.1, max: 1.1, step: 0.01, unit: '°', deg: true },
      { key: 'featherHold', label: '翻转锐度', min: 0, max: 0.9, step: 0.02, unit: '', fmt: (v) => v.toFixed(2) },
      { key: 'featherLag', label: '俯仰相位', min: -1.4, max: 1.4, step: 0.02, unit: '', fmt: (v) => v.toFixed(2) },
      { key: 'flex', label: '展向柔性', min: 0, max: 0.55, step: 0.01, unit: '', fmt: (v) => v.toFixed(2) },
    ],
  },
  {
    title: '环境 · 风',
    items: [
      { key: 'windSpeed', label: '风速', min: 0, max: 12, step: 0.1, unit: 'm/s', path: 'wind.speed' },
      { key: 'windDir', label: '风向', min: 0, max: 360, step: 1, unit: '°', path: 'wind.dir' },
      { key: 'gust', label: '阵风强度', min: 0, max: 0.7, step: 0.01, unit: '', path: 'wind.gust', fmt: (v) => v.toFixed(2) },
      { key: 'rho', label: '空气密度', min: 0.8, max: 1.3, step: 0.005, unit: 'kg/m³', path: 'aero.rho', fmt: (v) => v.toFixed(3) },
    ],
  },
  {
    title: '仿真 · 时间',
    items: [
      { key: 'timeScale', label: '时间倍率', min: 0, max: 2, step: 0.05, unit: '×', get: (s) => s.timeScale, set: (s, v) => (s.timeScale = v), fmt: (v) => v.toFixed(2) },
    ],
  },
];

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => o[k], obj);
}
function setPath(obj, path, val) {
  const ks = path.split('.');
  const last = ks.pop();
  ks.reduce((o, k) => o[k], obj)[last] = val;
}

export class UI {
  constructor({ params, sim, vfx, actions }) {
    this.params = params;
    this.sim = sim;
    this.vfx = vfx;
    this.actions = actions;
    this.state = {
      throttle: 0.8, altTarget: 1.7, timeScale: 1, mode: 'hover',
      showVectors: false, cutaway: false, paused: false, view: 'orbit',
    };
    this.rows = [];
    this.scopeBuf = { A: [], B: [], C: [], pwm: [] };
    this.scopeMax = 200;
    this._buildLeft();
    this._wireButtons();
    this._wireKeys();
    this.helpOpen = false;
    $('help-body').innerHTML = HELP_HTML;
    // 文档单一来源：优先加载 docs/help-html.md（若存在则替换内嵌文案）
    fetch('./docs/help-html.md').then((r) => (r.ok ? r.text() : null)).then((t) => {
      if (t && t.length > 400) $('help-body').innerHTML = t;
    }).catch(() => {});
    this.polarCtx = $('polar').getContext('2d');
    this.scopeCtx = $('scope').getContext('2d');
    this.syncThrottleMode();
  }

  _buildLeft() {
    const root = $('left-scroll');
    const defs = [];
    for (const g of CONTROL_GROUPS) {
      const sec = document.createElement('section');
      sec.className = 'card';
      const head = document.createElement('div');
      head.className = 'card-head';
      head.innerHTML = '<h2>' + g.title + '</h2>';
      sec.appendChild(head);
      for (const it of g.items) {
        if (it.type === 'seg') {
          const wrap = document.createElement('div');
          wrap.className = 'ctrl';
          const lab = document.createElement('div');
          lab.className = 'ctrl-top';
          lab.innerHTML = '<label>翼型</label>';
          const seg = document.createElement('div');
          seg.className = 'seg';
          const btns = it.options.map(([val, text]) => {
            const b = document.createElement('button');
            b.textContent = text;
            b.onclick = () => {
              setPath(this.params, it.key, val);
              btns.forEach((x, i) => x.classList.toggle('on', it.options[i][0] === val));
              this.actions.onParamChange(it.key);
              this.refreshFoldVisibility();
            };
            seg.appendChild(b);
            return b;
          });
          const cur = getPath(this.params, it.key);
          btns.forEach((b, i) => b.classList.toggle('on', it.options[i][0] === cur));
          wrap.append(lab, seg);
          sec.appendChild(wrap);
          this.foldToggles = (this.foldToggles || []).concat(btns);
          continue;
        }
        const wrap = document.createElement('div');
        wrap.className = 'ctrl';
        if (it.hoverOnly) wrap.dataset.hoverOnly = '1';
        if (it.foldOnly) wrap.dataset.foldOnly = '1';
        const top = document.createElement('div');
        top.className = 'ctrl-top';
        const lab = document.createElement('label');
        lab.textContent = it.label;
        const val = document.createElement('span');
        val.className = 'v';
        top.append(lab, val);
        const input = document.createElement('input');
        input.type = 'range';
        input.min = it.min; input.max = it.max; input.step = it.step;
        wrap.append(top, input);
        sec.appendChild(wrap);
        defs.push({ it, input, val, wrap });
      }
      root.appendChild(sec);
      this.rows.push(sec);
    }
    // 底部操作
    const foot = document.createElement('section');
    foot.className = 'card';
    foot.innerHTML = '<div class="card-head"><h2>操作</h2></div>';
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = '恢复默认参数';
    btn.style.width = '100%';
    btn.onclick = () => this.actions.resetParams();
    foot.appendChild(btn);
    root.appendChild(foot);

    this.defs = defs;
    for (const d of defs) {
      const { it, input, val } = d;
      const path = it.path || it.key;
      const read = () => (it.get ? it.get(this.state) : getPath(this.params, path));
      const write = (v) => (it.set ? it.set(this.state, v) : setPath(this.params, path, v));
      input.value = read();
      const fmt = (v) => {
        if (it.fmt) return it.fmt(v);
        if (it.deg) return ((v * 180) / Math.PI).toFixed(it.step < 0.02 ? 1 : 0) + '°';
        return (Number.isInteger(it.step) ? v.toFixed(0) : v.toFixed(2)) + (it.unit ? ' ' + it.unit : '');
      };
      val.textContent = fmt(Number(input.value));
      input.addEventListener('input', () => {
        const v = Number(input.value);
        write(v);
        val.textContent = fmt(v);
        input.style.setProperty('--p', ((v - it.min) / (it.max - it.min)) * 100 + '%');
        this.actions.onParamChange(it.key);
      });
      input.dispatchEvent(new Event('input'));
    }
  }

  refreshFoldVisibility() {
    const folding = this.params.wingType === 'folding';
    for (const d of this.defs || []) {
      if (d.it.foldOnly) d.wrap.style.display = folding ? '' : 'none';
    }
  }

  syncThrottleMode() {
    this.refreshFoldVisibility();
    const hover = this.state.mode === 'hover';
    for (const d of this.defs) {
      if (d.it.hoverOnly) d.wrap.style.display = hover ? '' : 'none';
      if (d.it.key === 'throttle') d.wrap.style.display = hover ? 'none' : '';
    }
    const chip = $('chip-mode');
    chip.textContent = hover ? '定高悬停' : this.state.mode === 'free' ? '纯物理' : '系留台架';
    chip.className = 'tag' + (hover ? '' : ' amber');
  }

  _wireButtons() {
    document.querySelectorAll('[data-mode]').forEach((b) => {
      b.onclick = () => this.setMode(b.dataset.mode);
    });
    document.querySelectorAll('[data-view]').forEach((b) => {
      b.onclick = () => this.setView(b.dataset.view);
    });
    $('btn-pause').onclick = () => this.togglePause();
    $('btn-reset').onclick = () => this.actions.reset();
    $('btn-launch').onclick = () => this.actions.launch();
    $('btn-wind').onclick = () => this.cycleWind();
    $('btn-vectors').onclick = () => {
      this.state.showVectors = !this.state.showVectors;
      this.vfx.setVectors(this.state.showVectors);
      $('btn-vectors').classList.toggle('on', this.state.showVectors);
    };
    $('btn-cutaway').onclick = () => {
      this.state.cutaway = !this.state.cutaway;
      this.actions.setCutaway(this.state.cutaway);
      $('btn-cutaway').classList.toggle('on', this.state.cutaway);
    };
    $('btn-help').onclick = () => this.toggleHelp(true);
    $('btn-help-close').onclick = () => this.toggleHelp(false);
    $('help').onclick = (e) => { if (e.target.id === 'help') this.toggleHelp(false); };
  }

  _wireKeys() {
    const keys = new Set();
    this.keys = keys;
    addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
      keys.add(k);
      if (k === ' ') this.togglePause();
      if (k === 'r') this.actions.reset();
      if (k === 'h') this.toggleHelp(!this.helpOpen);
      if (k === 'v') $('btn-vectors').click();
      if (k === 'c') $('btn-cutaway').click();
      if (k === '1') this.setMode('hover');
      if (k === '2') this.setMode('free');
      if (k === '3') this.setMode('tether');
    });
    addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
    addEventListener('blur', () => keys.clear());
  }

  setMode(m) {
    this.state.mode = m;
    this.sim.setMode(m);
    document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    this.syncThrottleMode();
  }
  setView(v) {
    this.state.view = v;
    document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    this.actions.setView(v);
  }
  togglePause() {
    this.state.paused = !this.state.paused;
    $('btn-pause').textContent = this.state.paused ? '▶' : '❚❚';
    $('btn-pause').classList.toggle('on', this.state.paused);
  }
  toggleHelp(v) {
    this.helpOpen = v;
    $('help').classList.toggle('hidden', !v);
  }
  cycleWind() {
    const seq = [0, 3, 6, 9, 0];
    const cur = this.params.wind.speed;
    let next = seq.find((s) => s > cur + 0.01) ?? 0;
    this.params.wind.speed = next;
    const d = this.defs.find((d) => d.it.key === 'windSpeed');
    if (d) { d.input.value = next; d.input.dispatchEvent(new Event('input')); }
    const b = $('btn-wind');
    b.textContent = next > 0 ? '风场 ' + next.toFixed(0) : '风场 0';
    b.classList.toggle('on', next > 0);
  }

  /** 由 main 每帧调用（限频） */
  updateHud(tele, fps) {
    const s = this.sim;
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    $('chip-fps').textContent = fps.toFixed(0);
    set('t-lw', tele.lw.toFixed(2));
    set('t-alt', tele.alt.toFixed(2));
    set('t-vy', tele.vy >= 0 ? '+' + tele.vy.toFixed(2) : tele.vy.toFixed(2));
    set('t-ias', tele.ias.toFixed(2));
    set('t-lift', tele.lift.toFixed(2) + ' N');
    set('t-thrust', tele.thrust.toFixed(2) + ' N');
    set('t-drag', tele.drag.toFixed(2) + ' N');
    set('t-rpm', tele.rpm.toFixed(0));
    set('t-amp', tele.pwr > 0.01 ? s.dt.current.toFixed(1) : '0.0');
    set('t-volt', tele.volt.toFixed(2));
    set('t-pwr', tele.pwr.toFixed(0));
    set('t-eff', (tele.eff * 100).toFixed(0));
    set('t-temp', (tele.temp - 25).toFixed(0));
    set('t-flap', tele.flapHz.toFixed(2));
    set('t-torque', Math.abs(tele.torque).toFixed(2));
    set('t-soc', (tele.soc * 100).toFixed(0) + '%');
    $('soc-fill').style.width = (tele.soc * 100).toFixed(1) + '%';
    set('t-endurance', (tele.endurance / 60).toFixed(1) + ' min');
    set('t-tip', tele.tipSpeed.toFixed(1));
    set('t-flapdeg', tele.flapDeg.toFixed(0));
    set('t-pitchdeg', tele.pitchDeg.toFixed(0));
    set('t-aeropw', tele.aeroPower.toFixed(0));
    set('t-fold', (((this.sim.ctl && this.sim.ctl.fold) || 0) * 100).toFixed(0));
    const est = s.ctlEst;
    set('t-hoveru', est ? (est.hoverU * 100).toFixed(0) + '%' : '--');
    set('t-pitch', ((tele.pitch * 180) / Math.PI).toFixed(0));
    set('t-roll', ((tele.roll * 180) / Math.PI).toFixed(0));
    $('chip-alpha').textContent = 'α ' + tele.alpha.toFixed(0) + '°';
    $('chip-pwm').textContent = 'PWM ' + (tele.throttle * 100).toFixed(0) + '%';
    $('chip-sector').textContent = SECTORS[tele.sector] || 'A+B-';

    const w = this.params.mass * 9.81;
    $('bar-lift').style.width = clamp((tele.lift / (w * 2)) * 100, 0, 100) + '%';
    $('bar-thrust').style.width = clamp((tele.thrust / (w * 2)) * 100, 0, 100) + '%';
    $('bar-drag').style.width = clamp((tele.drag / (w * 2)) * 100, 0, 100) + '%';
    $('bar-wline').style.left = '50%';

    // 示波器采样
    const sec = SECTORS[tele.sector] || 'A+B-';
    const I = s.dt.current;
    const hi = sec[0], lo = sec[2];
    const cur = { A: 0, B: 0, C: 0 };
    cur[hi] = I; cur[lo] = -I;
    const b = this.scopeBuf;
    for (const k of ['A', 'B', 'C']) {
      b[k].push(cur[k]);
      if (b[k].length > this.scopeMax) b[k].shift();
    }
    b.pwm.push(tele.throttle);
    if (b.pwm.length > this.scopeMax) b.pwm.shift();
  }

  drawScope() {
    const ctx = this.scopeCtx;
    const W = 540, H = 230;
    ctx.clearRect(0, 0, W, H);
    const b = this.scopeBuf;
    const n = b.A.length;
    if (!n) return;
    const midY = 118, ampY = 84;
    // 网格
    ctx.strokeStyle = 'rgba(110,190,255,0.10)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = 20 + (i * (H - 80)) / 4;
      ctx.beginPath(); ctx.moveTo(24, y); ctx.lineTo(W - 8, y); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(24, midY); ctx.lineTo(W - 8, midY); ctx.stroke();
    const gain = Math.max(6, Math.max(...b.A.map(Math.abs), ...b.B.map(Math.abs), ...b.C.map(Math.abs)));
    const X = (i) => 24 + (i / (this.scopeMax - 1)) * (W - 32);
    const Y = (v) => midY - (v / gain) * ampY;
    const cols = { A: '#3fe0ff', B: '#a98bff', C: '#ffb04a' };
    for (const k of ['A', 'B', 'C']) {
      ctx.beginPath();
      ctx.strokeStyle = cols[k];
      ctx.lineWidth = 1.6;
      ctx.shadowColor = cols[k] + '88';
      ctx.shadowBlur = 6;
      b[k].forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    // PWM
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(92,242,166,0.85)';
    ctx.lineWidth = 1.4;
    const pY = (v) => H - 18 - v * 44;
    b.pwm.forEach((v, i) => (i ? ctx.lineTo(X(i), pY(v)) : ctx.moveTo(X(i), pY(v))));
    ctx.stroke();
    ctx.fillStyle = 'rgba(140,165,190,0.6)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText('±' + gain.toFixed(1) + ' A', 26, 16);
    ctx.fillText('PWM', W - 42, H - 4);
  }

  drawPolar(alphaDeg) {
    const ctx = this.polarCtx;
    const W = 540, H = 300;
    ctx.clearRect(0, 0, W, H);
    const pad = { l: 34, r: 14, t: 18, b: 26 };
    const x0 = pad.l, x1 = W - pad.r, y0 = pad.t, y1 = H - pad.b;
    const ax = (a) => x0 + ((a + 180) / 360) * (x1 - x0);
    const ayCL = (c) => (y0 + y1) / 2 - (c / 1.6) * ((y1 - y0) / 2) * 0.92;
    const ayCD = (c) => y1 - (c / 2.0) * (y1 - y0) * 0.92;
    // 网格
    ctx.strokeStyle = 'rgba(110,190,255,0.10)';
    ctx.lineWidth = 1;
    for (let a = -180; a <= 180; a += 45) {
      ctx.beginPath(); ctx.moveTo(ax(a), y0); ctx.lineTo(ax(a), y1); ctx.stroke();
      ctx.fillStyle = 'rgba(140,165,190,0.55)';
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillText(a + '°', ax(a) - 10, y1 + 14);
    }
    ctx.beginPath(); ctx.moveTo(x0, (y0 + y1) / 2); ctx.lineTo(x1, (y0 + y1) / 2); ctx.stroke();
    // CD 面积
    const A = this.params.aero;
    ctx.beginPath();
    ctx.moveTo(ax(-180), ayCD(0));
    for (let a = -180; a <= 180; a += 4) {
      const p = polar((a * Math.PI) / 180, A);
      ctx.lineTo(ax(a), ayCD(p.cd));
    }
    ctx.lineTo(ax(180), ayCD(0));
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,107,122,0.13)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,107,122,0.65)';
    ctx.stroke();
    // CL 曲线
    ctx.beginPath();
    for (let a = -180; a <= 180; a += 2) {
      const p = polar((a * Math.PI) / 180, A);
      const y = ayCL(p.cl);
      a === -180 ? ctx.moveTo(ax(a), y) : ctx.lineTo(ax(a), y);
    }
    ctx.strokeStyle = 'rgba(63,224,255,0.95)';
    ctx.lineWidth = 1.7;
    ctx.shadowColor = 'rgba(63,224,255,0.6)';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
    // 工作点
    const ad = ((alphaDeg + 180) % 360) - 180;
    const p = polar((ad * Math.PI) / 180, A);
    ctx.beginPath();
    ctx.arc(ax(ad), ayCL(p.cl), 4.2, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#3fe0ff';
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(ax(ad), ayCD(p.cd), 3, 0, Math.PI * 2);
    ctx.fillStyle = '#ff6b7a';
    ctx.fill();
    ctx.fillStyle = 'rgba(63,224,255,0.85)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText('CL', 4, y0 + 8);
    ctx.fillStyle = 'rgba(255,107,122,0.85)';
    ctx.fillText('CD', 4, y1 - 4);
  }

  /** 键盘连续输入 */
  readInput() {
    const k = this.keys || new Set();
    const s = this.state;
    let pitch = 0, roll = 0, yaw = 0, throttle = s.throttle;
    if (k.has('arrowup') || k.has('w')) pitch += 1;
    if (k.has('arrowdown') || k.has('s')) pitch -= 1;
    if (k.has('a')) roll -= 1;
    if (k.has('d')) roll += 1;
    if (k.has('q')) yaw -= 1;
    if (k.has('e')) yaw += 1;
    if (s.mode !== 'hover') {
      if (k.has('w')) throttle = Math.min(1, throttle + 0.6 / 60);
      if (k.has('s')) throttle = Math.max(0.15, throttle - 0.6 / 60);
      s.throttle = clamp(throttle, 0, 1);
      const d = this.defs.find((x) => x.it.key === 'throttle');
      if (d && Math.abs(Number(d.input.value) - s.throttle * 100) > 0.6) {
        d.input.value = s.throttle * 100;
        d.input.dispatchEvent(new Event('input'));
      }
    } else {
      if (k.has('w')) s.altTarget = Math.min(4, s.altTarget + 0.4 / 60);
      if (k.has('s')) s.altTarget = Math.max(0.5, s.altTarget - 0.4 / 60);
    }
    this.sim.altTarget = s.altTarget;
    return { throttle: s.throttle, pitch, roll, yaw, assist: s.mode === 'hover' };
  }
}
