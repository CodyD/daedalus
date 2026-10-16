// SPICE primitive elements and their MNA companion models.

import { AnalogElement, Mna, StampCtx, nodeV } from "./mna";

const VT = 0.025852; // thermal voltage at 300K

export class Resistor implements AnalogElement {
  constructor(public a: number, public b: number, public r: number) {}
  stamp(m: Mna): void {
    m.conductance(this.a, this.b, 1 / Math.max(this.r, 1e-6));
  }
}

/** Backward-Euler capacitor: open in DC, G = C/dt with history current. */
export class Capacitor implements AnalogElement {
  private vPrev = 0;
  constructor(public a: number, public b: number, public c: number, ic = 0) {
    this.vPrev = ic;
  }
  stamp(m: Mna, ctx: StampCtx): void {
    if (ctx.mode === "dc") return;
    const g = this.c / ctx.dt;
    m.conductance(this.a, this.b, g);
    m.current(this.a, this.b, -g * this.vPrev);
  }
  accept(x: Float64Array): void {
    this.vPrev = nodeV(x, this.a) - nodeV(x, this.b);
  }
}

/** Backward-Euler inductor with its current as an MNA branch; short in DC. */
export class Inductor implements AnalogElement {
  branchCount = 1;
  branch = 0;
  private iPrev = 0;
  constructor(public a: number, public b: number, public l: number) {}
  stamp(m: Mna, ctx: StampCtx): void {
    const k = m.branchRow(this.branch);
    m.add(this.a - 1, k, 1);
    m.add(this.b - 1, k, -1);
    m.add(k, this.a - 1, 1);
    m.add(k, this.b - 1, -1);
    if (ctx.mode === "tran") {
      const z = this.l / ctx.dt;
      m.add(k, k, -z);
      m.rhs(k, -z * this.iPrev);
    }
  }
  accept(x: Float64Array, _c: StampCtx, m: Mna): void {
    this.iPrev = x[m.branchRow(this.branch)];
  }
}

export type Waveform =
  | { kind: "dc"; v: number }
  | { kind: "pulse"; v1: number; v2: number; td: number; tr: number; tf: number; pw: number; per: number }
  | { kind: "sin"; vo: number; va: number; freq: number; td: number };

export function waveformAt(w: Waveform, t: number): number {
  switch (w.kind) {
    case "dc":
      return w.v;
    case "sin":
      return t < w.td ? w.vo : w.vo + w.va * Math.sin(2 * Math.PI * w.freq * (t - w.td));
    case "pulse": {
      if (t < w.td) return w.v1;
      const tp = w.per > 0 ? (t - w.td) % w.per : t - w.td;
      if (tp < w.tr) return w.v1 + ((w.v2 - w.v1) * tp) / w.tr;
      if (tp < w.tr + w.pw) return w.v2;
      if (tp < w.tr + w.pw + w.tf) return w.v2 + ((w.v1 - w.v2) * (tp - w.tr - w.pw)) / w.tf;
      return w.v1;
    }
  }
}

export class VoltageSource implements AnalogElement {
  branchCount = 1;
  branch = 0;
  timeVarying: boolean;
  constructor(public a: number, public b: number, public wave: Waveform) {
    this.timeVarying = wave.kind !== "dc";
  }
  setDc(v: number): void {
    this.wave = { kind: "dc", v };
  }
  stamp(m: Mna, ctx: StampCtx): void {
    m.voltage(this.a, this.b, this.branch, waveformAt(this.wave, ctx.t));
  }
  maxStep(): number {
    const w = this.wave;
    if (w.kind === "sin") return 1 / (w.freq * 50);
    if (w.kind === "pulse") return Math.max(Math.min(w.tr, w.tf, w.pw / 4, w.per / 50), 1e-9);
    return Infinity;
  }
}

export class CurrentSource implements AnalogElement {
  timeVarying: boolean;
  constructor(public a: number, public b: number, public wave: Waveform) {
    this.timeVarying = wave.kind !== "dc";
  }
  stamp(m: Mna, ctx: StampCtx): void {
    m.current(this.a, this.b, waveformAt(this.wave, ctx.t));
  }
}

/** SPICE pnjlim: keeps exp() from blowing up between Newton iterations. */
function pnjlim(vnew: number, vold: number, vt: number, vcrit: number): [number, boolean] {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt;
      vnew = arg > 0 ? vold + vt * Math.log(arg) : vcrit;
    } else {
      vnew = vt * Math.log(vnew / vt);
    }
    return [vnew, true];
  }
  return [vnew, false];
}

/** Series resistance (RS) is added by the netlist parser as a separate resistor. */
export interface DiodeParams {
  is: number;
  n: number;
  bv: number; // reverse breakdown voltage, 0 = none
  ibv: number; // current at breakdown voltage
}

export const DEFAULT_DIODE: DiodeParams = { is: 1e-14, n: 1, bv: 0, ibv: 1e-3 };

export class Diode implements AnalogElement {
  nonlinear = true;
  private vd = 0;
  current = 0;
  constructor(public a: number, public k: number, public p: DiodeParams) {}
  stamp(m: Mna, ctx: StampCtx): void {
    const { is, n, bv, ibv } = this.p;
    const nvt = n * VT;
    const vcrit = nvt * Math.log(nvt / (Math.SQRT2 * is));
    let vd = nodeV(ctx.x, this.a) - nodeV(ctx.x, this.k);
    let limited: boolean;
    [vd, limited] = pnjlim(vd, this.vd, nvt, vcrit);
    if (bv > 0 && vd < -bv + 10 * nvt) {
      // reflect limiting into breakdown region
      const [vr, l2] = pnjlim(-(vd + bv), -(this.vd + bv), nvt, vcrit);
      vd = -(vr + bv);
      limited ||= l2;
    }
    if (limited) m.limited = true;
    this.vd = vd;
    const e = Math.exp(Math.min(vd / nvt, 80));
    let id = is * (e - 1);
    let gd = (is * e) / nvt;
    if (bv > 0) {
      // Breakdown branch: IBV flows at exactly -BV, rising exponentially beyond.
      const eb = Math.exp(Math.min(-(vd + bv) / nvt, 80));
      id -= ibv * eb;
      gd += (ibv * eb) / nvt;
    }
    gd += 1e-12;
    this.current = id;
    m.conductance(this.a, this.k, gd);
    m.current(this.a, this.k, id - gd * vd);
  }
}

export interface BjtParams {
  is: number;
  bf: number;
  br: number;
  pnp: boolean;
}

/** Transport-form Ebers-Moll BJT. */
export class Bjt implements AnalogElement {
  nonlinear = true;
  private vbe = 0;
  private vbc = 0;
  ic = 0;
  constructor(public c: number, public b: number, public e: number, public p: BjtParams) {}
  stamp(m: Mna, ctx: StampCtx): void {
    const s = this.p.pnp ? -1 : 1;
    const { is, bf, br } = this.p;
    const vcrit = VT * Math.log(VT / (Math.SQRT2 * is));
    let vbe = s * (nodeV(ctx.x, this.b) - nodeV(ctx.x, this.e));
    let vbc = s * (nodeV(ctx.x, this.b) - nodeV(ctx.x, this.c));
    let l1: boolean, l2: boolean;
    [vbe, l1] = pnjlim(vbe, this.vbe, VT, vcrit);
    [vbc, l2] = pnjlim(vbc, this.vbc, VT, vcrit);
    if (l1 || l2) m.limited = true;
    this.vbe = vbe;
    this.vbc = vbc;
    const ebe = Math.exp(Math.min(vbe / VT, 80));
    const ebc = Math.exp(Math.min(vbc / VT, 80));
    const icc = is * (ebe - ebc); // transport current
    const ibe = (is / bf) * (ebe - 1);
    const ibc = (is / br) * (ebc - 1);
    const gbe = (is / bf) * ebe / VT + 1e-12;
    const gbc = (is / br) * ebc / VT + 1e-12;
    const gmf = (is * ebe) / VT;
    const gmr = (is * ebc) / VT;
    // Terminal currents (into device), in NPN-normalised orientation.
    const ic = icc - ibc;
    const ib = ibe + ibc;
    this.ic = s * ic;
    // Linearise: i = i0 + dI/dvbe*(vbe-vbe0) + dI/dvbc*(vbc-vbc0)
    const dic_dvbe = gmf;
    const dic_dvbc = -gmr - gbc;
    const dib_dvbe = gbe;
    const dib_dvbc = gbc;
    const { c, b, e } = this;
    // Stamp terminal current i_x = I0 + g1*dvbe + g2*dvbc (normalised polarity).
    const stampTerm = (node: number, i0: number, g1: number, g2: number) => {
      // Actual current into the device from node x (s*s = 1):
      //   I = s*(i0 - g1*vbe0 - g2*vbc0) + g1*(Vb-Ve) + g2*(Vb-Vc)
      const r = node - 1;
      m.add(r, b - 1, g1 + g2);
      m.add(r, e - 1, -g1);
      m.add(r, c - 1, -g2);
      m.rhs(r, -s * (i0 - g1 * vbe - g2 * vbc));
    };
    stampTerm(c, ic, dic_dvbe, dic_dvbc);
    stampTerm(b, ib, dib_dvbe, dib_dvbc);
    stampTerm(e, -(ic + ib), -(dic_dvbe + dib_dvbe), -(dic_dvbc + dib_dvbc));
  }
}

export interface MosParams {
  vto: number;
  kp: number;
  lambda: number;
  w: number;
  l: number;
  pmos: boolean;
}

/** Shichman-Hodges (SPICE level 1) MOSFET, body tied to source. */
export class Mosfet implements AnalogElement {
  nonlinear = true;
  ids = 0;
  constructor(public d: number, public g: number, public s: number, public p: MosParams) {}
  stamp(m: Mna, ctx: StampCtx): void {
    const sign = this.p.pmos ? -1 : 1;
    let d = this.d;
    let s = this.s;
    let vds = sign * (nodeV(ctx.x, d) - nodeV(ctx.x, s));
    if (vds < 0) {
      [d, s] = [s, d];
      vds = -vds;
    }
    const vgs = sign * (nodeV(ctx.x, this.g) - nodeV(ctx.x, s));
    const vth = sign * this.p.vto; // PMOS thresholds are negative in SPICE
    const beta = this.p.kp * (this.p.w / this.p.l);
    const vov = vgs - vth;
    let id = 0, gm = 0, gds = 0;
    if (vov <= 0) {
      id = 0; gm = 0; gds = 0;
    } else if (vds < vov) {
      id = beta * (vov * vds - (vds * vds) / 2) * (1 + this.p.lambda * vds);
      gm = beta * vds * (1 + this.p.lambda * vds);
      gds = beta * (vov - vds) * (1 + this.p.lambda * vds) + beta * (vov * vds - (vds * vds) / 2) * this.p.lambda;
    } else {
      id = (beta / 2) * vov * vov * (1 + this.p.lambda * vds);
      gm = beta * vov * (1 + this.p.lambda * vds);
      gds = (beta / 2) * vov * vov * this.p.lambda;
    }
    gds += 1e-12;
    this.ids = sign * id;
    // Current id flows d -> s (in normalised polarity).
    const ieq = id - gm * vgs - gds * vds;
    m.conductance(d, s, gds);
    // gm * vgs: VCCS from d to s controlled by (g - s)
    const rd = d - 1, rs = s - 1, rg = this.g - 1;
    m.add(rd, rg, gm);
    m.add(rd, rs, -gm);
    m.add(rs, rg, -gm);
    m.add(rs, rs, gm);
    m.current(d, s, sign * ieq);
  }
}

/** E element: V(op) - V(on) = gain * (V(cp) - V(cn)). */
export class Vcvs implements AnalogElement {
  branchCount = 1;
  branch = 0;
  constructor(public op: number, public on: number, public cp: number, public cn: number, public gain: number) {}
  stamp(m: Mna): void {
    const k = m.branchRow(this.branch);
    m.add(this.op - 1, k, 1);
    m.add(this.on - 1, k, -1);
    m.add(k, this.op - 1, 1);
    m.add(k, this.on - 1, -1);
    m.add(k, this.cp - 1, -this.gain);
    m.add(k, this.cn - 1, this.gain);
  }
}

/** G element: current gm * (V(cp) - V(cn)) flows from op through element to on. */
export class Vccs implements AnalogElement {
  constructor(public op: number, public on: number, public cp: number, public cn: number, public gm: number) {}
  stamp(m: Mna): void {
    m.add(this.op - 1, this.cp - 1, this.gm);
    m.add(this.op - 1, this.cn - 1, -this.gm);
    m.add(this.on - 1, this.cp - 1, -this.gm);
    m.add(this.on - 1, this.cn - 1, this.gm);
  }
}

/** Voltage-controlled switch with smooth (log-interpolated) transition. */
export class VSwitch implements AnalogElement {
  nonlinear = true;
  constructor(
    public a: number, public b: number, public cp: number, public cn: number,
    public vt: number, public vh: number, public ron: number, public roff: number,
  ) {}
  stamp(m: Mna, ctx: StampCtx): void {
    const vc = nodeV(ctx.x, this.cp) - nodeV(ctx.x, this.cn);
    const k = 1 / (1 + Math.exp(-(vc - this.vt) / Math.max(this.vh, 1e-3)));
    const lr = Math.log(this.roff) + (Math.log(this.ron) - Math.log(this.roff)) * k;
    m.conductance(this.a, this.b, Math.exp(-lr));
  }
}

/**
 * Behavioural op-amp: high-gain differential stage with soft rail clamping.
 * Output is a voltage source behind rout, saturating at the supply pins minus
 * headroom. Input pins draw no current; supply current is not modelled.
 */
export class OpAmp implements AnalogElement {
  nonlinear = true;
  branchCount = 1;
  branch = 0;
  constructor(
    public inp: number, public inn: number, public out: number, public vp: number, public vn: number,
    public gain: number, public headroom: number,
  ) {}
  stamp(m: Mna, ctx: StampCtx): void {
    const x = ctx.x;
    const vdiff = nodeV(x, this.inp) - nodeV(x, this.inn);
    const hi = nodeV(x, this.vp) - this.headroom;
    const lo = nodeV(x, this.vn) + this.headroom;
    const mid = (hi + lo) / 2;
    const half = Math.max((hi - lo) / 2, 1e-3);
    const u = (this.gain * vdiff) / half;
    const th = Math.tanh(u);
    const f = mid + half * th;
    const dfd = this.gain * (1 - th * th); // d f / d vdiff
    // Row: V(out) - f(vdiff) = 0, linearised around the current guess. The
    // rails are treated as constants within an iteration (they are normally
    // tied to fixed supplies, so this costs nothing in convergence).
    const k = m.branchRow(this.branch);
    m.add(this.out - 1, k, 1);
    m.add(k, this.out - 1, 1);
    m.add(k, this.inp - 1, -dfd);
    m.add(k, this.inn - 1, dfd);
    m.rhs(k, f - dfd * vdiff);
  }
}

/** Norton source used to drive an analog node from a digital output pin. */
export class DigitalDriver implements AnalogElement {
  g = 0;
  v = 0;
  constructor(public node: number) {}
  set(v: number, r: number): void {
    this.v = v;
    this.g = r > 0 ? 1 / r : 0;
  }
  stamp(m: Mna): void {
    if (this.g === 0) return;
    m.conductance(this.node, 0, this.g);
    m.current(0, this.node, this.g * this.v);
  }
}
