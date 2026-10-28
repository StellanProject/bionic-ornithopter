// ---------------------------------------------------------------------------
// 无刷直流电机 (BLDC) + ESC 六步换向 + 减速箱 + 电池 的准静态电-机-热模型
// 注意：不使用步进电机模型；动力源为三相无刷电机，电枢时间常数远小于机械
// 时间常数，故采用准静态电流解 (I = (D·Vbus - Ke·ω)/R)。
// ---------------------------------------------------------------------------
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export const SECTORS = ['A+B-', 'A+C-', 'B+C-', 'B+A-', 'C+A-', 'C+B-'];

export class Drivetrain {
  constructor(cfg) {
    this.cfg = cfg;
    const m = cfg.motor;
    this.kvRad = (m.kv * 2 * Math.PI) / 60; // rad/s per V
    this.kt = 1 / this.kvRad;               // N·m per A
    this.G = cfg.mech.gear;
    this.eff = cfg.mech.eff;
    // 翼面绕扑动轴的转动惯量（均质梯形翼的近似）
    const span = cfg.span, mw = cfg.wingMass;
    this.jWing = (2 * mw * span * span) / 3; // 两侧
    this.jLink = cfg.mech.jLink;
    this.cTh = (m.tauTherm * 1) / m.rth;
    this.reset();
  }

  reset() {
    this.omegaCrank = 0;
    this.current = 0;
    this.soc = 1;
    this.temp = 25.0;
    this.ahUsed = 0;
    this.voltage = this.cfg.battery.cells * this.cfg.battery.cellV;
    this.elecAngle = 0;
    this.throttle = 0;
    this.pElec = 0;
    this.pMech = 0;
    this.torque = 0;
    this.loadTorque = 0;
    this.flapFreq = 0;
    this.sector = 0;
    this.stall = false;
  }

  /** 参数（KV / 减速比 / 电池）改变后重新标定 */
  refresh() {
    const m = this.cfg.motor;
    this.kvRad = (m.kv * 2 * Math.PI) / 60;
    this.kt = 1 / this.kvRad;
    this.G = this.cfg.mech.gear;
    this.eff = this.cfg.mech.eff;
  }

  get rpm() { return (this.omegaCrank * this.G * 60) / (2 * Math.PI); }
  get flapHz() { return this.omegaCrank / (2 * Math.PI); }

  /** 电池开路电压（随 SOC 下降） */
  packVoltageOpen(soc) {
    const b = this.cfg.battery;
    return b.cells * (3.30 + 0.40 * soc);
  }

  /**
   * 推进一个电-机-热步
   * @param dt 步长
   * @param throttle 0..1 (对应 ESC 油门 / PWM 占空比)
   * @param loadTorqueCrank 折算到曲柄轴的气动负载力矩 N·m
   * @param dFlap 当前 dφ/dθ_crank
   */
  step(dt, throttle, loadTorqueCrank, dFlap) {
    const cfg = this.cfg, m = cfg.motor, b = cfg.battery;
    this.throttle = clamp(throttle, 0, 1);
    const G = this.G;

    // --- 电池 ---
    const vOpen = this.packVoltageOpen(this.soc);
    const vBus = Math.max(0.5, vOpen - this.current * b.res);
    this.voltage = vBus;

    // --- 电气：准静态电流（含反电动势与限流） ---
    const wm = this.omegaCrank * G;
    const emf = wm / this.kvRad;
    const vDrive = this.throttle * vBus;
    let i = (vDrive - emf) / m.res;
    const iLim = Math.min(m.imax, b.maxA);
    i = clamp(i, -iLim * 0.35, iLim);
    this.stall = i >= iLim * 0.98;
    this.current = i;

    // --- 机电：转矩 ---
    const tMotor = this.kt * i;
    this.torque = tMotor;
    const jTotal = this.jLink + this.jWing * dFlap * dFlap + m.jRotor * G * G;
    const tDrive = tMotor * G * this.eff;
    // 机构摩擦（粘性 + 库仑）折算到曲柄轴
    const bCrank = 0.004, fCrank = 0.020;
    const visc = bCrank * this.omegaCrank + (this.omegaCrank > 0.2 ? fCrank : 0);
    const tRes = loadTorqueCrank + visc;
    this.loadTorque = loadTorqueCrank;
    let w = this.omegaCrank + ((tDrive - tRes) / Math.max(jTotal, 1e-6)) * dt;
    if (w < 0) w = 0;
    // 物理上限：空载转速（防止数值失控）
    const wMax = ((this.cfg.battery.cells * this.cfg.battery.cellV * this.cfg.motor.kv * 2 * Math.PI) / 60 / G) * 1.02;
    if (w > wMax) w = wMax;
    this.omegaCrank = w;

    // --- 功率 / 效率 ---
    this.pElec = vBus * i;
    this.pMech = tMotor * wm;

    // --- 电量与热 ---
    this.ahUsed += (i * dt) / 3600;
    this.soc = clamp(1 - this.ahUsed / (b.capMah / 1000), 0, 1);
    const pLoss = 1.5 * i * i * (m.res * 0.5);
    this.temp += ((pLoss - (this.temp - 25) / m.rth) / this.cTh) * dt;

    // --- 六步换向扇区（电气角 7x 机械角） ---
    this.elecAngle += (m.poles / 2) * wm * dt;
    this.sector = Math.floor(((this.elecAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI / 3)) % 6;

    return this;
  }

  get efficiency() {
    return this.pElec > 1e-6 ? clamp(this.pMech / this.pElec, -0.2, 1) : 0;
  }
  get flightSeconds() {
    const ah = (this.cfg.battery.capMah / 1000) * this.soc;
    const i = Math.max(this.current, 0.05);
    return (ah / i) * 3600;
  }
}
