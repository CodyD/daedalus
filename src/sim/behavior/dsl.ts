// Behavioural logic language for digital and mixed-signal parts.
//
// This is the format Claude writes when importing a logic chip from its
// datasheet, and the format the built-in 74xx/4000/555 parts use. It is
// interpreted (never eval'd), so model text from an AI or a user cannot run
// arbitrary code.
//
//   state shift = 0                 // persistent variable (integer or real)
//   init { ... }                    // runs once at t=0
//   on rising(SHCP) { ... }         // edge handlers: rising | falling | change
//   always { ... }                  // runs after any input change (combinational)
//
// Statements:  X = expr;   bus(Q0..Q7) = expr;   if (c) stmt else stmt;   { ... }
// Expressions: C operators (?: || && | ^ & == != < <= > >= << >> + - * / % ! ~),
//              pin names read 0/1, Z (high impedance), bit(v, n), bus(A0..A7)
//              or bus(A, B, C) (LSB first), v(PIN) analog volts, min, max, abs.
// Assigning Z (or an expression yielding Z) to an output releases it.

export type Expr =
  | { t: "num"; v: number }
  | { t: "z" }
  | { t: "id"; name: string }
  | { t: "un"; op: string; a: Expr }
  | { t: "bin"; op: string; a: Expr; b: Expr }
  | { t: "cond"; c: Expr; a: Expr; b: Expr }
  | { t: "call"; fn: string; args: Expr[]; pins?: string[] };

export type Stmt =
  | { t: "assign"; target: string; e: Expr }
  | { t: "busAssign"; pins: string[]; e: Expr }
  | { t: "if"; c: Expr; a: Stmt; b?: Stmt }
  | { t: "block"; body: Stmt[] };

export interface Handler {
  kind: "rising" | "falling" | "change";
  pin: string;
  body: Stmt;
}

export interface Program {
  states: { name: string; init: Expr }[];
  init?: Stmt;
  handlers: Handler[];
  always?: Stmt;
  usesAnalog: boolean;
}

type Tok = { k: "num" | "id" | "op" | "eof"; v: string; pos: number };

const OPS = ["..", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "?", ":", "(", ")", "{", "}", ",", ";", "=", "<", ">",
  "+", "-", "*", "/", "%", "&", "|", "^", "!", "~"];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (src.startsWith("//", i) || c === "#") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (src.startsWith("/*", i)) { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; continue; }
    const num = /^(0x[0-9a-fA-F_]+|0b[01_]+|\d+(\.\d+)?(e[-+]?\d+)?)([a-zA-Zµ]*)/.exec(src.slice(i));
    if (num && /\d/.test(c)) {
      out.push({ k: "num", v: num[0], pos: i });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][\w]*/.exec(src.slice(i));
    if (id) { out.push({ k: "id", v: id[0], pos: i }); i += id[0].length; continue; }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new SyntaxError(`unexpected character '${c}' at ${lineCol(src, i)}`);
    out.push({ k: "op", v: op, pos: i });
    i += op.length;
  }
  out.push({ k: "eof", v: "", pos: src.length });
  return out;
}

function lineCol(src: string, pos: number): string {
  const before = src.slice(0, pos).split("\n");
  return `line ${before.length}, col ${before[before.length - 1].length + 1}`;
}

const SCALE: Record<string, number> = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, m: 1e-3, k: 1e3, meg: 1e6 };

function parseNumber(s: string): number {
  if (/^0x/i.test(s)) return parseInt(s.slice(2).replace(/_/g, ""), 16);
  if (/^0b/i.test(s)) return parseInt(s.slice(2).replace(/_/g, ""), 2);
  const m = /^([\d.]+(?:e[-+]?\d+)?)([a-zA-Zµ]*)$/.exec(s)!;
  const unit = m[2].toLowerCase();
  const scale = unit.startsWith("meg") ? 1e6 : SCALE[unit[0] ?? ""] ?? 1;
  return parseFloat(m[1]) * scale;
}

/** Expand "Q0..Q7" into Q0, Q1, ... Q7 (also descending ranges). */
export function expandRange(a: string, b: string): string[] {
  const ma = /^(.*?)(\d+)$/.exec(a);
  const mb = /^(.*?)(\d+)$/.exec(b);
  if (!ma || !mb || ma[1] !== mb[1]) throw new SyntaxError(`bad range ${a}..${b}`);
  const lo = +ma[2], hi = +mb[2];
  const out: string[] = [];
  if (lo <= hi) for (let k = lo; k <= hi; k++) out.push(ma[1] + k);
  else for (let k = lo; k >= hi; k--) out.push(ma[1] + k);
  return out;
}

export function parseProgram(src: string): Program {
  const toks = lex(src);
  let p = 0;
  let usesAnalog = false;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const at = (v: string) => peek().k !== "num" && peek().v === v;
  const expect = (v: string) => {
    const t = next();
    if (t.v !== v) throw new SyntaxError(`expected '${v}' but found '${t.v || "end"}' at ${lineCol(src, t.pos)}`);
    return t;
  };
  const ident = () => {
    const t = next();
    if (t.k !== "id") throw new SyntaxError(`expected a name at ${lineCol(src, t.pos)}`);
    return t.v;
  };

  const pinList = (): string[] => {
    const pins: string[] = [];
    do {
      const a = ident();
      if (at("..")) { next(); pins.push(...expandRange(a, ident())); }
      else pins.push(a);
    } while (at(",") && next());
    return pins;
  };

  // Precedence climbing over binary operators.
  const PREC: Record<string, number> = {
    "||": 1, "&&": 2, "|": 3, "^": 4, "&": 5, "==": 6, "!=": 6, "<": 7, "<=": 7, ">": 7, ">=": 7,
    "<<": 8, ">>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "%": 10,
  };

  const primary = (): Expr => {
    const t = next();
    if (t.k === "num") return { t: "num", v: parseNumber(t.v) };
    if (t.k === "op" && t.v === "(") { const e = expr(); expect(")"); return e; }
    if (t.k === "op" && ["!", "~", "-"].includes(t.v)) return { t: "un", op: t.v, a: primary() };
    if (t.k === "id") {
      if (t.v === "Z") return { t: "z" };
      if (at("(")) {
        next();
        if (t.v === "bus") {
          const pins = pinList();
          expect(")");
          return { t: "call", fn: "bus", args: [], pins };
        }
        const args: Expr[] = [];
        if (!at(")")) {
          do args.push(expr()); while (at(",") && next());
        }
        expect(")");
        if (t.v === "v") usesAnalog = true;
        if (!["bit", "v", "min", "max", "abs"].includes(t.v)) {
          throw new SyntaxError(`unknown function '${t.v}' at ${lineCol(src, t.pos)}`);
        }
        return { t: "call", fn: t.v, args };
      }
      return { t: "id", name: t.v };
    }
    throw new SyntaxError(`unexpected '${t.v || "end"}' at ${lineCol(src, t.pos)}`);
  };

  const binary = (minPrec: number): Expr => {
    let left = primary();
    for (;;) {
      const t = peek();
      const prec = t.k === "op" ? PREC[t.v] : undefined;
      if (prec === undefined || prec < minPrec) return left;
      next();
      left = { t: "bin", op: t.v, a: left, b: binary(prec + 1) };
    }
  };

  const expr = (): Expr => {
    const c = binary(1);
    if (at("?")) {
      next();
      const a = expr();
      expect(":");
      return { t: "cond", c, a, b: expr() };
    }
    return c;
  };

  const statement = (): Stmt => {
    if (at("{")) {
      next();
      const body: Stmt[] = [];
      while (!at("}")) {
        if (peek().k === "eof") throw new SyntaxError("missing '}'");
        body.push(statement());
      }
      next();
      return { t: "block", body };
    }
    if (at("if")) {
      next();
      expect("(");
      const c = expr();
      expect(")");
      const a = statement();
      let b: Stmt | undefined;
      if (at("else")) { next(); b = statement(); }
      return { t: "if", c, a, b };
    }
    if (at("bus")) {
      next();
      expect("(");
      const pins = pinList();
      expect(")");
      expect("=");
      const e = expr();
      if (at(";")) next();
      return { t: "busAssign", pins, e };
    }
    const target = ident();
    expect("=");
    const e = expr();
    if (at(";")) next();
    return { t: "assign", target, e };
  };

  const prog: Program = { states: [], handlers: [], usesAnalog: false };
  while (peek().k !== "eof") {
    const t = peek();
    if (at(";")) { next(); continue; }
    if (at("state")) {
      next();
      const name = ident();
      let init: Expr = { t: "num", v: 0 };
      if (at("=")) { next(); init = expr(); }
      prog.states.push({ name, init });
      if (at(";")) next();
    } else if (at("init")) {
      next();
      prog.init = statement();
    } else if (at("always")) {
      next();
      const body = statement();
      prog.always = prog.always ? { t: "block", body: [prog.always, body] } : body;
    } else if (at("on")) {
      next();
      const kind = ident();
      if (kind !== "rising" && kind !== "falling" && kind !== "change") {
        throw new SyntaxError(`expected rising/falling/change at ${lineCol(src, t.pos)}`);
      }
      expect("(");
      const pin = ident();
      expect(")");
      prog.handlers.push({ kind, pin, body: statement() });
    } else {
      throw new SyntaxError(`expected state/init/on/always at ${lineCol(src, t.pos)}`);
    }
  }
  prog.usesAnalog = usesAnalog;
  return prog;
}

/** Collect every identifier the program reads or writes, for validation. */
export function programNames(prog: Program): { reads: Set<string>; writes: Set<string> } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const ex = (e: Expr): void => {
    switch (e.t) {
      case "id": reads.add(e.name); break;
      case "un": ex(e.a); break;
      case "bin": ex(e.a); ex(e.b); break;
      case "cond": ex(e.c); ex(e.a); ex(e.b); break;
      case "call":
        e.pins?.forEach((p) => reads.add(p));
        e.args.forEach((a) => {
          if (e.fn === "v" && a.t === "id") reads.add(a.name);
          else ex(a);
        });
        break;
    }
  };
  const st = (s: Stmt): void => {
    switch (s.t) {
      case "assign": writes.add(s.target); ex(s.e); break;
      case "busAssign": s.pins.forEach((p) => writes.add(p)); ex(s.e); break;
      case "if": ex(s.c); st(s.a); if (s.b) st(s.b); break;
      case "block": s.body.forEach(st); break;
    }
  };
  prog.states.forEach((s) => ex(s.init));
  if (prog.init) st(prog.init);
  prog.handlers.forEach((h) => { reads.add(h.pin); st(h.body); });
  if (prog.always) st(prog.always);
  return { reads, writes };
}
