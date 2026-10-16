// Runs a behavioural logic program as a simulation model.

import { DPin, ModelContext, SimModel } from "../engine";
import { Drive, Level } from "../logic";
import { Expr, Program, Stmt, parseProgram, programNames } from "./dsl";

const Z = NaN;

export class BehaviorModel implements SimModel {
  private prog: Program;
  private ctx!: ModelContext;
  private state = new Map<string, number>();
  private pins = new Map<string, DPin>();
  private nodes = new Map<string, number>();
  private pending = new Map<string, number>();
  private openDrain = new Set<string>();
  /** Unconnected active-low (~NAME) inputs read as inactive (1). */
  private idleHigh = new Set<string>();
  private tpd = 10e-9;
  private now = 0;

  constructor(source: string) {
    this.prog = parseProgram(source);
  }

  setup(ctx: ModelContext): void {
    this.ctx = ctx;
    const def = ctx.def;
    this.tpd = def.electrical?.propagationDelay ?? (ctx.num("TPD", 0) || 10e-9);
    const { reads, writes } = programNames(this.prog);
    const stateNames = new Set(this.prog.states.map((s) => s.name));
    const analogReads = new Set<string>();
    collectAnalog(this.prog, analogReads);
    for (const name of [...reads, ...writes]) {
      if (stateNames.has(name) || this.pins.has(name)) continue;
      if (!ctx.hasPin(name)) {
        throw new Error(`logic model uses '${name}', which is neither a pin nor a declared state`);
      }
      if (analogReads.has(name) && !writes.has(name) && !this.isDigitalRead(name)) continue;
      const pin = ctx.pin(name, { onChange: (t, l) => this.onInput(name, t, l) });
      this.pins.set(name, pin);
      const pd = def.pins.find((p) => p.id === name);
      if (pd?.type === "opendrain") this.openDrain.add(name);
      if (pd?.name.startsWith("~") && !ctx.isConnected(name)) this.idleHigh.add(name);
    }
    for (const name of analogReads) this.nodes.set(name, ctx.node(name));
    // States exist from the start: the DC operating point may already deliver
    // input events before start() runs.
    for (const s of this.prog.states) this.state.set(s.name, 0);
    for (const w of writes) {
      if (!stateNames.has(w) && !this.pins.has(w)) throw new Error(`cannot assign to '${w}'`);
    }
  }

  private isDigitalRead(name: string): boolean {
    // A pin used only inside v(...) is analog-only.
    let digital = false;
    const ex = (e: Expr, inV: boolean): void => {
      switch (e.t) {
        case "id": if (e.name === name && !inV) digital = true; break;
        case "un": ex(e.a, inV); break;
        case "bin": ex(e.a, inV); ex(e.b, inV); break;
        case "cond": ex(e.c, inV); ex(e.a, inV); ex(e.b, inV); break;
        case "call":
          if (e.pins?.includes(name)) digital = true;
          e.args.forEach((a) => ex(a, inV || e.fn === "v"));
      }
    };
    const st = (s: Stmt): void => {
      switch (s.t) {
        case "assign": case "busAssign": ex(s.e, false); break;
        case "if": ex(s.c, false); st(s.a); if (s.b) st(s.b); break;
        case "block": s.body.forEach(st);
      }
    };
    if (this.prog.init) st(this.prog.init);
    if (this.prog.always) st(this.prog.always);
    this.prog.handlers.forEach((h) => { if (h.pin === name) digital = true; st(h.body); });
    return digital;
  }

  start(): void {
    this.now = 0;
    for (const s of this.prog.states) this.state.set(s.name, this.eval(s.init));
    if (this.prog.init) this.exec(this.prog.init);
    if (this.prog.always) this.exec(this.prog.always);
    this.flush();
  }

  private onInput(pin: string, t: number, l: Level): void {
    this.now = t;
    for (const h of this.prog.handlers) {
      if (h.pin !== pin) continue;
      if (h.kind === "change" || (h.kind === "rising" && l === Level.H) || (h.kind === "falling" && l === Level.L)) {
        this.exec(h.body);
      }
    }
    if (this.prog.always) this.exec(this.prog.always);
    this.flush();
  }

  afterAnalogStep(t: number): void {
    if (!this.prog.usesAnalog || !this.prog.always) return;
    this.now = t;
    this.exec(this.prog.always);
    this.flush();
  }

  private flush(): void {
    for (const [name, v] of this.pending) {
      const pin = this.pins.get(name)!;
      let d: Drive;
      if (Number.isNaN(v)) d = Drive.Z;
      else if (v) d = this.openDrain.has(name) ? Drive.Z : Drive.SH;
      else d = Drive.SL;
      pin.set(this.now + this.tpd, d);
    }
    this.pending.clear();
  }

  private exec(s: Stmt): void {
    switch (s.t) {
      case "block":
        for (const b of s.body) this.exec(b);
        return;
      case "if": {
        const c = this.eval(s.c);
        if (c && !Number.isNaN(c)) this.exec(s.a);
        else if (s.b) this.exec(s.b);
        return;
      }
      case "assign": {
        const v = this.eval(s.e);
        if (this.state.has(s.target)) this.state.set(s.target, v);
        else this.pending.set(s.target, v);
        return;
      }
      case "busAssign": {
        const v = this.eval(s.e);
        s.pins.forEach((p, i) => this.pending.set(p, Number.isNaN(v) ? Z : (v >> i) & 1));
        return;
      }
    }
  }

  private readPin(name: string): number {
    const pin = this.pins.get(name);
    if (!pin) return 0;
    if (this.idleHigh.has(name)) return 1;
    return pin.read() === Level.H ? 1 : 0;
  }

  private eval(e: Expr): number {
    switch (e.t) {
      case "num": return e.v;
      case "z": return Z;
      case "id": {
        const s = this.state.get(e.name);
        if (s !== undefined) return s;
        return this.readPin(e.name);
      }
      case "un": {
        const a = this.eval(e.a);
        if (e.op === "!") return a ? 0 : 1;
        if (e.op === "~") return ~a;
        return -a;
      }
      case "cond": {
        const c = this.eval(e.c);
        return c && !Number.isNaN(c) ? this.eval(e.a) : this.eval(e.b);
      }
      case "call": {
        switch (e.fn) {
          case "bus": return e.pins!.reduce((acc, p, i) => acc | (this.readPin(p) << i), 0);
          case "bit": return (this.eval(e.args[0]) >> this.eval(e.args[1])) & 1;
          case "v": {
            const a = e.args[0];
            if (a.t !== "id") return 0;
            const node = this.nodes.get(a.name);
            if (node !== undefined) return this.ctx.v(node);
            return this.pins.get(a.name)?.voltage() ?? 0;
          }
          case "min": return Math.min(...e.args.map((x) => this.eval(x)));
          case "max": return Math.max(...e.args.map((x) => this.eval(x)));
          case "abs": return Math.abs(this.eval(e.args[0]));
        }
        return 0;
      }
      case "bin": {
        const a = this.eval(e.a);
        const b = this.eval(e.b);
        switch (e.op) {
          case "||": return a || b ? 1 : 0;
          case "&&": return a && b ? 1 : 0;
          case "|": return a | b;
          case "^": return a ^ b;
          case "&": return a & b;
          case "==": return a === b ? 1 : 0;
          case "!=": return a !== b ? 1 : 0;
          case "<": return a < b ? 1 : 0;
          case "<=": return a <= b ? 1 : 0;
          case ">": return a > b ? 1 : 0;
          case ">=": return a >= b ? 1 : 0;
          case "<<": return a << b;
          case ">>": return a >>> b;
          case "+": return a + b;
          case "-": return a - b;
          case "*": return a * b;
          case "/":
            if (b === 0) return 0;
            // Integer division for integer operands (counters), real otherwise (v() maths).
            return Number.isInteger(a) && Number.isInteger(b) ? Math.trunc(a / b) : a / b;
          case "%": return b === 0 ? 0 : a % b;
        }
      }
    }
    return 0;
  }

  indicate(): unknown {
    return { state: Object.fromEntries(this.state) };
  }
}

function collectAnalog(prog: Program, out: Set<string>): void {
  const ex = (e: Expr): void => {
    switch (e.t) {
      case "un": ex(e.a); break;
      case "bin": ex(e.a); ex(e.b); break;
      case "cond": ex(e.c); ex(e.a); ex(e.b); break;
      case "call":
        if (e.fn === "v" && e.args[0]?.t === "id") out.add(e.args[0].name);
        else e.args.forEach(ex);
    }
  };
  const st = (s: Stmt): void => {
    switch (s.t) {
      case "assign": case "busAssign": ex(s.e); break;
      case "if": ex(s.c); st(s.a); if (s.b) st(s.b); break;
      case "block": s.body.forEach(st);
    }
  };
  if (prog.init) st(prog.init);
  if (prog.always) st(prog.always);
  prog.handlers.forEach((h) => st(h.body));
}
