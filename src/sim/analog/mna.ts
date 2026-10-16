// Modified Nodal Analysis with Newton-Raphson, the same formulation SPICE uses.
//
// Unknowns: node voltages for nodes 1..N-1 (node 0 is ground) followed by one
// branch current per voltage-defined element (V sources, inductors, VCVS...).
// Each element "stamps" its linearised companion model into A·x = b; nonlinear
// elements are re-stamped every Newton iteration around the latest guess.

export type IntegrationMode = "dc" | "tran";

export interface StampCtx {
  mode: IntegrationMode;
  t: number;
  dt: number;
  x: Float64Array;
}

export interface AnalogElement {
  /** Re-stamped every Newton iteration when true. */
  nonlinear?: boolean;
  /** Number of extra MNA rows (branch currents) the element needs. */
  branchCount?: number;
  /** First branch row, assigned by the solver. */
  branch?: number;
  stamp(m: Mna, c: StampCtx): void;
  /** Called once a time point converged: update history (capacitor charge...). */
  accept?(x: Float64Array, c: StampCtx, m: Mna): void;
  /** Upper bound on the timestep this element tolerates right now. */
  maxStep?(t: number): number;
  /** Time-varying source: the solver must not skip quiet steps. */
  timeVarying?: boolean;
}

export class Mna {
  readonly size: number;
  readonly A: Float64Array;
  readonly b: Float64Array;
  /** Set by elements whose Newton step was limited; forces another iteration. */
  limited = false;

  constructor(readonly nodeCount: number, readonly branchCount: number) {
    this.size = nodeCount - 1 + branchCount;
    this.A = new Float64Array(this.size * this.size);
    this.b = new Float64Array(this.size);
  }

  clear(): void {
    this.A.fill(0);
    this.b.fill(0);
    this.limited = false;
  }

  /** Matrix row of a node (ground has none). */
  row(node: number): number {
    return node - 1;
  }

  branchRow(branch: number): number {
    return this.nodeCount - 1 + branch;
  }

  add(r: number, c: number, v: number): void {
    if (r < 0 || c < 0) return;
    this.A[r * this.size + c] += v;
  }

  rhs(r: number, v: number): void {
    if (r < 0) return;
    this.b[r] += v;
  }

  /** Conductance g between nodes a and b. */
  conductance(a: number, b: number, g: number): void {
    const ra = a - 1;
    const rb = b - 1;
    this.add(ra, ra, g);
    this.add(rb, rb, g);
    this.add(ra, rb, -g);
    this.add(rb, ra, -g);
  }

  /** Independent current i flowing from node a, through the element, into node b. */
  current(a: number, b: number, i: number): void {
    this.rhs(a - 1, -i);
    this.rhs(b - 1, i);
  }

  /** Voltage-defined branch: V(a) - V(b) = v, with branch current as unknown. */
  voltage(a: number, b: number, branch: number, v: number): void {
    const k = this.branchRow(branch);
    this.add(a - 1, k, 1);
    this.add(b - 1, k, -1);
    this.add(k, a - 1, 1);
    this.add(k, b - 1, -1);
    this.rhs(k, v);
  }
}

export function nodeV(x: Float64Array, node: number): number {
  return node === 0 ? 0 : x[node - 1];
}

/** In-place LU solve with partial pivoting. Returns false if singular. */
export function luSolve(A: Float64Array, b: Float64Array, n: number, out: Float64Array): boolean {
  const perm = new Int32Array(n);
  for (let i = 0; i < n; i++) perm[i] = i;
  for (let k = 0; k < n; k++) {
    let p = k;
    let max = Math.abs(A[k * n + k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(A[i * n + k]);
      if (v > max) { max = v; p = i; }
    }
    if (max < 1e-300) return false;
    if (p !== k) {
      for (let j = 0; j < n; j++) {
        const t = A[k * n + j];
        A[k * n + j] = A[p * n + j];
        A[p * n + j] = t;
      }
      const tb = b[k]; b[k] = b[p]; b[p] = tb;
      const tp = perm[k]; perm[k] = perm[p]; perm[p] = tp;
    }
    const pivot = A[k * n + k];
    for (let i = k + 1; i < n; i++) {
      const f = A[i * n + k] / pivot;
      if (f === 0) continue;
      A[i * n + k] = f;
      for (let j = k + 1; j < n; j++) A[i * n + j] -= f * A[k * n + j];
      b[i] -= f * b[k];
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= A[i * n + j] * out[j];
    out[i] = s / A[i * n + i];
  }
  return true;
}

export interface SolveResult {
  ok: boolean;
  iterations: number;
  error?: string;
}

const GMIN = 1e-12;
const VNTOL = 1e-6;
const RELTOL = 1e-3;
const ABSTOL = 1e-9;
const MAX_ITER = 150;

export class AnalogSolver {
  readonly elements: AnalogElement[] = [];
  nodeCount = 1;
  branchCount = 0;
  x = new Float64Array(0);
  private mna!: Mna;
  private scratchA = new Float64Array(0);
  private scratchB = new Float64Array(0);
  private next = new Float64Array(0);
  private anyNonlinear = false;

  add(el: AnalogElement): AnalogElement {
    this.elements.push(el);
    return el;
  }

  finalize(nodeCount: number): void {
    this.nodeCount = nodeCount;
    let br = 0;
    for (const el of this.elements) {
      if (el.branchCount) {
        el.branch = br;
        br += el.branchCount;
      }
      if (el.nonlinear) this.anyNonlinear = true;
    }
    this.branchCount = br;
    this.mna = new Mna(nodeCount, br);
    const n = this.mna.size;
    this.x = new Float64Array(n);
    this.next = new Float64Array(n);
    this.scratchA = new Float64Array(n * n);
    this.scratchB = new Float64Array(n);
  }

  get size(): number {
    return this.mna ? this.mna.size : 0;
  }

  get isEmpty(): boolean {
    return this.size === 0;
  }

  /** Solve one time point (or the DC operating point when mode = "dc"). */
  solve(t: number, dt: number, mode: IntegrationMode): SolveResult {
    const m = this.mna;
    const n = m.size;
    if (n === 0) return { ok: true, iterations: 0 };
    const guess = Float64Array.from(this.x);
    const ctx: StampCtx = { mode, t, dt, x: guess };
    const maxIter = this.anyNonlinear ? MAX_ITER : 1;
    for (let iter = 1; iter <= maxIter; iter++) {
      m.clear();
      for (const el of this.elements) el.stamp(m, ctx);
      for (let i = 0; i < m.nodeCount - 1; i++) m.A[i * n + i] += GMIN;
      this.scratchA.set(m.A);
      this.scratchB.set(m.b);
      if (!luSolve(this.scratchA, this.scratchB, n, this.next)) {
        return { ok: false, iterations: iter, error: "singular matrix (floating node or voltage-source loop)" };
      }
      let converged = !m.limited;
      for (let i = 0; i < n; i++) {
        const nv = this.next[i];
        if (!isFinite(nv)) return { ok: false, iterations: iter, error: "solution diverged" };
        const tol = i < m.nodeCount - 1 ? VNTOL : ABSTOL;
        if (Math.abs(nv - guess[i]) > RELTOL * Math.max(Math.abs(nv), Math.abs(guess[i])) + tol) converged = false;
        guess[i] = nv;
      }
      if (converged || !this.anyNonlinear) {
        this.x.set(guess);
        for (const el of this.elements) el.accept?.(this.x, ctx, m);
        return { ok: true, iterations: iter };
      }
    }
    return { ok: false, iterations: maxIter, error: "Newton iteration did not converge" };
  }

  /** Smallest timestep any element currently requests. */
  maxStep(t: number): number {
    let s = Infinity;
    for (const el of this.elements) if (el.maxStep) s = Math.min(s, el.maxStep(t));
    return s;
  }

  hasTimeVarying(): boolean {
    return this.elements.some((e) => e.timeVarying);
  }
}
