// ---------------------------------------------------------------------------
// 紧凑 CMA-ES（(μ/μ_w, λ)-ES），用于策略参数的黑箱优化
// ---------------------------------------------------------------------------
export function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
export function gauss(rnd) {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class CMAES {
  constructor(x0, sigma, lambda, seed) {
    this.n = x0.length;
    this.rnd = makeRng(seed);
    this.mean = x0.slice();
    this.sigma = sigma;
    this.lambda = lambda;
    this.mu = Math.floor(lambda / 2);
    const w = [];
    for (let i = 0; i < this.mu; i++) w.push(Math.log(this.mu + 0.5) - Math.log(i + 1));
    const ws = w.reduce((a, b) => a + b, 0);
    this.weights = w.map((x) => x / ws);
    this.mueff = 1 / this.weights.reduce((a, b) => a + b * b, 0);
    this.cc = (4 + this.mueff / this.n) / (this.n + 4 + 2 * this.mueff / this.n);
    this.cs = (this.mueff + 2) / (this.n + this.mueff + 5);
    this.c1 = 2 / ((this.n + 1.3) ** 2 + this.mueff);
    this.cmu = Math.min(1 - this.c1, 2 * (this.mueff - 2 + 1 / this.mueff) / ((this.n + 2) ** 2 + this.mueff));
    this.damps = 1 + 2 * Math.max(0, Math.sqrt((this.mueff - 1) / (this.n + 1)) - 1) + this.cs;
    this.pc = new Array(this.n).fill(0);
    this.ps = new Array(this.n).fill(0);
    this.B = Array.from({ length: this.n }, (_, i) => Array.from({ length: this.n }, (_, j) => (i === j ? 1 : 0)));
    this.D = new Array(this.n).fill(1);
    this.C = Array.from({ length: this.n }, (_, i) => Array.from({ length: this.n }, (_, j) => (i === j ? 1 : 0)));
    this.chiN = Math.sqrt(this.n) * (1 - 1 / (4 * this.n) + 1 / (21 * this.n * this.n));
    this.gen = 0;
  }
  ask() {
    const z = [];
    for (let k = 0; k < this.lambda; k++) {
      const zk = new Array(this.n);
      for (let i = 0; i < this.n; i++) zk[i] = gauss(this.rnd);
      const y = new Array(this.n).fill(0);
      for (let i = 0; i < this.n; i++) for (let j = 0; j < this.n; j++) y[i] += this.B[i][j] * this.D[j] * zk[j];
      z.push({ z: zk, x: y.map((v, i) => this.mean[i] + this.sigma * v), y });
    }
    return z;
  }
  tell(pop) {
    pop.sort((a, b) => a.f - b.f);
    const n = this.n;
    const yw = new Array(n).fill(0);
    for (let k = 0; k < this.mu; k++) for (let i = 0; i < n; i++) yw[i] += this.weights[k] * pop[k].y[i];
    for (let i = 0; i < n; i++) this.mean[i] += this.sigma * yw[i];
    const invSqrtC = [];
    for (let i = 0; i < n; i++) invSqrtC.push(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) invSqrtC[i] += this.B[i][j] * (yw[j] / this.D[j]);
    for (let i = 0; i < n; i++) this.ps[i] = (1 - this.cs) * this.ps[i] + Math.sqrt(this.cs * (2 - this.cs) * this.mueff) * invSqrtC[i];
    const psNorm = Math.sqrt(this.ps.reduce((a, b) => a + b * b, 0));
    this.hsig = psNorm / Math.sqrt(1 - (1 - this.cs) ** (2 * (this.gen + 1))) / this.chiN < 1.4 + 2 / (n + 1) ? 1 : 0;
    for (let i = 0; i < n; i++) this.pc[i] = (1 - this.cc) * this.pc[i] + this.hsig * Math.sqrt(this.cc * (2 - this.cc) * this.mueff) * yw[i];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        let rankOne = 0, rankMu = 0;
        for (let k = 0; k < this.mu; k++) rankMu += this.weights[k] * pop[k].y[i] * pop[k].y[j];
        this.C[i][j] = (1 - this.c1 - this.cmu) * this.C[i][j] + this.c1 * this.pc[i] * this.pc[j] + this.cmu * rankMu;
      }
    }
    this.sigma *= Math.exp((this.cs / this.damps) * (psNorm / this.chiN - 1));
    // 特征分解（Jacobi，n 小，足够）
    const { B, D } = eigSym(this.C);
    this.B = B; this.D = D;
    this.gen++;
    return pop[0];
  }
}

function eigSym(A) {
  const n = A.length;
  const a = A.map((r) => r.slice());
  let V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 24; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if (off < 1e-18) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-14) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const D = [], B = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    D.push(Math.sqrt(Math.max(1e-12, a[i][i])));
    for (let k = 0; k < n; k++) B[k][i] = V[k][i];
  }
  return { B, D };
}
