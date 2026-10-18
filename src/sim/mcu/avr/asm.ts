// Two-pass AVR assembler (avrasm-style syntax) so firmware can be written and
// built inside the app.
//
//   .equ NAME = expr      .def tmp = r16      .org wordaddr
//   .db 1, 2, "text"      .dw 0x1234, label
//   label:  ldi tmp, low(1000) ; comment
//
// Operand expressions support + - * / % << >> & | ^ ~ ( ), $hex/0x/0b/'c'
// literals, labels (word addresses) and low()/high()/lo8()/hi8()/byte2().

export interface AsmResult {
  bytes: Uint8Array;
  labels: Record<string, number>;
  /** Word address -> source line, for the debugger. */
  lineMap: Map<number, number>;
}

export class AsmError extends Error {
  constructor(public line: number, msg: string) {
    super(`line ${line}: ${msg}`);
  }
}

const TWO_REG: Record<string, number> = {
  add: 0x0c00, adc: 0x1c00, sub: 0x1800, sbc: 0x0800, and: 0x2000, or: 0x2800, eor: 0x2400,
  mov: 0x2c00, cp: 0x1400, cpc: 0x0400, cpse: 0x1000, mul: 0x9c00,
};
const ONE_REG_ALIAS: Record<string, string> = { lsl: "add", rol: "adc", tst: "and", clr: "eor" };
const REG_IMM: Record<string, number> = {
  cpi: 0x3000, sbci: 0x4000, subi: 0x5000, ori: 0x6000, sbr: 0x6000, andi: 0x7000, ldi: 0xe000,
};
const ONE_REG: Record<string, number> = {
  com: 0x9400, neg: 0x9401, swap: 0x9402, inc: 0x9403, asr: 0x9405, lsr: 0x9406, ror: 0x9407, dec: 0x940a,
  push: 0x920f, pop: 0x900f,
};
const NO_ARG: Record<string, number> = {
  nop: 0x0000, ret: 0x9508, reti: 0x9518, sleep: 0x9588, break: 0x9598, wdr: 0x95a8, ijmp: 0x9409,
  icall: 0x9509, eijmp: 0x9419, eicall: 0x9519, spm: 0x95e8,
  sec: 0x9408, clc: 0x9488, sez: 0x9418, clz: 0x9498, sen: 0x9428, cln: 0x94a8, sev: 0x9438, clv: 0x94b8,
  ses: 0x9448, cls: 0x94c8, seh: 0x9458, clh: 0x94d8, set: 0x9468, clt: 0x94e8, sei: 0x9478, cli: 0x94f8,
};
const BRANCH: Record<string, [boolean, number]> = {
  breq: [true, 1], brne: [false, 1], brcs: [true, 0], brlo: [true, 0], brcc: [false, 0], brsh: [false, 0],
  brmi: [true, 2], brpl: [false, 2], brvs: [true, 3], brvc: [false, 3], brlt: [true, 4], brge: [false, 4],
  brhs: [true, 5], brhc: [false, 5], brts: [true, 6], brtc: [false, 6], brie: [true, 7], brid: [false, 7],
};
const IO_BIT: Record<string, number> = { cbi: 0x9800, sbic: 0x9900, sbi: 0x9a00, sbis: 0x9b00 };
const REG_BIT: Record<string, number> = { bld: 0xf800, bst: 0xfa00, sbrc: 0xfc00, sbrs: 0xfe00 };
const REG_ALIAS: Record<string, number> = { xl: 26, xh: 27, yl: 28, yh: 29, zl: 30, zh: 31 };

function twoWord(mn: string): boolean {
  return mn === "jmp" || mn === "call" || mn === "lds" || mn === "sts";
}

interface Line {
  no: number;
  label?: string;
  mn?: string;
  args: string[];
  raw: string;
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "", quote = false;
  for (const ch of s) {
    if (ch === '"') quote = !quote;
    if (!quote && ch === "(") depth++;
    if (!quote && ch === ")") depth--;
    if (!quote && depth === 0 && ch === ",") { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseLines(src: string): Line[] {
  return src.split(/\r?\n/).map((raw, i) => {
    let s = raw;
    // strip comments outside of quotes
    let q = false;
    for (let k = 0; k < s.length; k++) {
      if (s[k] === '"' || (s[k] === "'" && s[k + 2] === "'")) {
        if (s[k] === "'") { k += 2; continue; }
        q = !q;
      }
      if (!q && (s[k] === ";" || (s[k] === "/" && s[k + 1] === "/"))) { s = s.slice(0, k); break; }
    }
    s = s.trim();
    const line: Line = { no: i + 1, args: [], raw };
    const lm = /^([A-Za-z_.][\w.]*):\s*(.*)$/.exec(s);
    if (lm) { line.label = lm[1]; s = lm[2]; }
    if (!s) return line;
    const mm = /^(\.?[A-Za-z_][\w]*)\s*(.*)$/.exec(s);
    if (!mm) throw new AsmError(i + 1, `cannot parse '${s}'`);
    line.mn = mm[1].toLowerCase();
    line.args = splitArgs(mm[2]);
    return line;
  });
}

export function assemble(src: string, predefined: Record<string, number> = {}): AsmResult {
  const lines = parseLines(src);
  const symbols: Record<string, number> = {};
  for (const [k, v] of Object.entries(predefined)) symbols[k.toLowerCase()] = v;
  const defs: Record<string, number> = {};
  const labels: Record<string, number> = {};

  const evalExpr = (expr: string, lineNo: number, allowUndef: boolean): number => {
    const toks = expr.match(/\$[0-9a-fA-F]+|0x[0-9a-fA-F]+|0b[01]+|\d+|'.'|<<|>>|[A-Za-z_][\w.]*|[-+*/%&|^~()]/g) ?? [];
    let p = 0;
    const prim = (): number => {
      const t = toks[p++];
      if (t === undefined) throw new AsmError(lineNo, `bad expression '${expr}'`);
      if (t === "(") { const v = bin(0); p++; return v; }
      if (t === "-") return -prim();
      if (t === "~") return ~prim();
      if (t === "+") return prim();
      if (t.startsWith("$")) return parseInt(t.slice(1), 16);
      if (/^0x/i.test(t)) return parseInt(t, 16);
      if (/^0b/i.test(t)) return parseInt(t.slice(2), 2);
      if (/^\d/.test(t)) return parseInt(t, 10);
      if (t.startsWith("'")) return t.charCodeAt(1);
      const fn = t.toLowerCase();
      if (toks[p] === "(" && ["low", "high", "lo8", "hi8", "byte2", "byte3", "pm"].includes(fn)) {
        p++;
        const v = bin(0);
        p++;
        if (fn === "low" || fn === "lo8") return v & 0xff;
        if (fn === "high" || fn === "hi8" || fn === "byte2") return (v >> 8) & 0xff;
        if (fn === "byte3") return (v >> 16) & 0xff;
        return v;
      }
      if (fn in symbols) return symbols[fn];
      if (allowUndef) return 0;
      throw new AsmError(lineNo, `undefined symbol '${t}'`);
    };
    const PREC: Record<string, number> = { "|": 1, "^": 2, "&": 3, "<<": 4, ">>": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };
    const bin = (min: number): number => {
      let left = prim();
      for (;;) {
        const op = toks[p];
        const pr = op !== undefined ? PREC[op] : undefined;
        if (pr === undefined || pr < min) return left;
        p++;
        const right = bin(pr + 1);
        switch (op) {
          case "|": left |= right; break;
          case "^": left ^= right; break;
          case "&": left &= right; break;
          case "<<": left <<= right; break;
          case ">>": left >>= right; break;
          case "+": left += right; break;
          case "-": left -= right; break;
          case "*": left *= right; break;
          case "/": left = Math.trunc(left / right); break;
          case "%": left %= right; break;
        }
      }
    };
    const v = bin(0);
    if (p !== toks.length) throw new AsmError(lineNo, `bad expression '${expr}'`);
    return v;
  };

  const reg = (s: string, lineNo: number): number => {
    const k = s.trim().toLowerCase();
    if (k in defs) return defs[k];
    if (k in REG_ALIAS) return REG_ALIAS[k];
    const m = /^r(\d+)$/.exec(k);
    if (!m || +m[1] > 31) throw new AsmError(lineNo, `expected register, got '${s}'`);
    return +m[1];
  };

  const dataBytes = (l: Line, pass2: boolean): number[] => {
    const out: number[] = [];
    for (const a of l.args) {
      const sm = /^"(.*)"$/.exec(a);
      if (sm) {
        for (const ch of sm[1].replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\0/g, "\0")) out.push(ch.charCodeAt(0));
      } else out.push(evalExpr(a, l.no, !pass2) & 0xff);
    }
    return out;
  };

  const sizeOf = (l: Line): number => {
    if (!l.mn) return 0;
    if (l.mn === ".db") return Math.ceil(dataBytes(l, false).length / 2);
    if (l.mn === ".dw") return l.args.length;
    if (l.mn.startsWith(".")) return 0;
    return twoWord(l.mn) ? 2 : 1;
  };

  // Pass 1: addresses.
  let pc = 0;
  for (const l of lines) {
    if (l.label) {
      labels[l.label.toLowerCase()] = pc;
      symbols[l.label.toLowerCase()] = pc;
    }
    if (!l.mn) continue;
    if (l.mn === ".equ" || l.mn === ".set") {
      const m = /^([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(l.args.join(","));
      if (!m) throw new AsmError(l.no, ".equ expects NAME = value");
      symbols[m[1].toLowerCase()] = evalExpr(m[2], l.no, true);
      continue;
    }
    if (l.mn === ".def") {
      const m = /^([A-Za-z_]\w*)\s*=\s*(\w+)$/.exec(l.args.join(","));
      if (!m) throw new AsmError(l.no, ".def expects name = register");
      defs[m[1].toLowerCase()] = reg(m[2], l.no);
      continue;
    }
    if (l.mn === ".org") {
      pc = evalExpr(l.args[0], l.no, false);
      continue;
    }
    pc += sizeOf(l);
  }
  // Re-evaluate .equ with labels known.
  for (const l of lines) {
    if (l.mn === ".equ" || l.mn === ".set") {
      const m = /^([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(l.args.join(","))!;
      symbols[m[1].toLowerCase()] = evalExpr(m[2], l.no, false);
    }
  }

  // Pass 2: encode.
  const words = new Map<number, number>();
  const lineMap = new Map<number, number>();
  let maxAddr = 0;
  pc = 0;
  const emit = (w: number) => {
    words.set(pc, w & 0xffff);
    pc++;
    maxAddr = Math.max(maxAddr, pc);
  };
  for (const l of lines) {
    if (!l.mn) continue;
    const mn = l.mn;
    const a = l.args;
    const ev = (s: string) => evalExpr(s, l.no, false);
    const need = (n: number) => {
      if (a.length !== n) throw new AsmError(l.no, `${mn} expects ${n} operand(s)`);
    };
    if (mn === ".org") { pc = ev(a[0]); continue; }
    if (mn.startsWith(".")) {
      if (mn === ".db") {
        const b = dataBytes(l, true);
        if (b.length & 1) b.push(0);
        for (let i = 0; i < b.length; i += 2) emit(b[i] | (b[i + 1] << 8));
      } else if (mn === ".dw") for (const x of a) emit(ev(x));
      else if (![".equ", ".set", ".def", ".include", ".device", ".cseg", ".list", ".nolist", ".exit"].includes(mn)) {
        throw new AsmError(l.no, `unknown directive ${mn}`);
      }
      continue;
    }
    lineMap.set(pc, l.no);
    const here = pc;
    const rel = (target: number, bits: number) => {
      const k = target - (here + 1);
      const lim = 1 << (bits - 1);
      if (k < -lim || k >= lim) throw new AsmError(l.no, `branch target out of range (${k} words)`);
      return k & ((1 << bits) - 1);
    };
    try {
      if (mn in NO_ARG) { need(0); emit(NO_ARG[mn]); continue; }
      const alias = ONE_REG_ALIAS[mn];
      if (alias) { need(1); const d = reg(a[0], l.no); emit(TWO_REG[alias] | ((d & 0x10) << 5) | (d & 0xf) | (d << 4)); continue; }
      if (mn in TWO_REG) {
        need(2);
        const d = reg(a[0], l.no), r = reg(a[1], l.no);
        emit(TWO_REG[mn] | ((r & 0x10) << 5) | (r & 0xf) | (d << 4));
        continue;
      }
      if (mn in REG_IMM || mn === "cbr" || mn === "ser") {
        const d = reg(a[0], l.no);
        if (d < 16) throw new AsmError(l.no, `${mn} needs r16..r31`);
        let base: number, k: number;
        if (mn === "ser") { need(1); base = 0xe000; k = 0xff; }
        else if (mn === "cbr") { need(2); base = 0x7000; k = ~ev(a[1]) & 0xff; }
        else { need(2); base = REG_IMM[mn]; k = ev(a[1]) & 0xff; }
        emit(base | ((k & 0xf0) << 4) | ((d - 16) << 4) | (k & 0xf));
        continue;
      }
      if (mn in ONE_REG) { need(1); emit(ONE_REG[mn] | (reg(a[0], l.no) << 4)); continue; }
      if (mn === "adiw" || mn === "sbiw") {
        need(2);
        const d = reg(a[0].split(":").pop()!, l.no);
        const k = ev(a[1]);
        if (![24, 26, 28, 30].includes(d) || k < 0 || k > 63) throw new AsmError(l.no, `bad ${mn} operands`);
        emit((mn === "adiw" ? 0x9600 : 0x9700) | ((k & 0x30) << 2) | (((d - 24) >> 1) << 4) | (k & 0xf));
        continue;
      }
      if (mn === "movw") {
        need(2);
        const d = reg(a[0].split(":").pop()!, l.no), r = reg(a[1].split(":").pop()!, l.no);
        emit(0x0100 | ((d >> 1) << 4) | (r >> 1));
        continue;
      }
      if (mn === "muls") { need(2); emit(0x0200 | ((reg(a[0], l.no) - 16) << 4) | (reg(a[1], l.no) - 16)); continue; }
      if (["mulsu", "fmul", "fmuls", "fmulsu"].includes(mn)) {
        need(2);
        const base = { mulsu: 0x0300, fmul: 0x0308, fmuls: 0x0380, fmulsu: 0x0388 }[mn]!;
        emit(base | ((reg(a[0], l.no) - 16) << 4) | (reg(a[1], l.no) - 16));
        continue;
      }
      if (mn === "in") {
        need(2);
        const d = reg(a[0], l.no), io = ev(a[1]);
        if (io > 63) throw new AsmError(l.no, `I/O address 0x${io.toString(16)} out of range for IN (use LDS)`);
        emit(0xb000 | ((io & 0x30) << 5) | (d << 4) | (io & 0xf));
        continue;
      }
      if (mn === "out") {
        need(2);
        const io = ev(a[0]), r = reg(a[1], l.no);
        if (io > 63) throw new AsmError(l.no, `I/O address 0x${io.toString(16)} out of range for OUT (use STS)`);
        emit(0xb800 | ((io & 0x30) << 5) | (r << 4) | (io & 0xf));
        continue;
      }
      if (mn in IO_BIT) {
        need(2);
        const io = ev(a[0]), b = ev(a[1]);
        if (io > 31) throw new AsmError(l.no, `${mn} only reaches I/O 0..31`);
        emit(IO_BIT[mn] | (io << 3) | (b & 7));
        continue;
      }
      if (mn in REG_BIT) { need(2); emit(REG_BIT[mn] | (reg(a[0], l.no) << 4) | (ev(a[1]) & 7)); continue; }
      if (mn === "rjmp" || mn === "rcall") {
        need(1);
        emit((mn === "rjmp" ? 0xc000 : 0xd000) | rel(ev(a[0]), 12));
        continue;
      }
      if (mn === "jmp" || mn === "call") {
        need(1);
        const k = ev(a[0]);
        emit((mn === "jmp" ? 0x940c : 0x940e) | (((k >> 17) & 0x1f) << 4) | ((k >> 16) & 1));
        emit(k & 0xffff);
        continue;
      }
      if (mn in BRANCH) {
        need(1);
        const [set, s] = BRANCH[mn];
        emit((set ? 0xf000 : 0xf400) | (rel(ev(a[0]), 7) << 3) | s);
        continue;
      }
      if (mn === "brbs" || mn === "brbc") {
        need(2);
        emit((mn === "brbs" ? 0xf000 : 0xf400) | (rel(ev(a[1]), 7) << 3) | (ev(a[0]) & 7));
        continue;
      }
      if (mn === "lpm" || mn === "elpm") {
        if (a.length === 0) { emit(mn === "lpm" ? 0x95c8 : 0x95d8); continue; }
        need(2);
        const d = reg(a[0], l.no);
        const ptr = a[1].replace(/\s/g, "").toLowerCase();
        const base = mn === "lpm" ? 0x9004 : 0x9006;
        if (ptr === "z") emit(base | (d << 4));
        else if (ptr === "z+") emit(base | 1 | (d << 4));
        else throw new AsmError(l.no, `${mn} pointer must be Z or Z+`);
        continue;
      }
      if (mn === "ld" || mn === "ldd" || mn === "st" || mn === "std") {
        need(2);
        const load = mn[0] === "l";
        const r = reg(load ? a[0] : a[1], l.no);
        const ptr = (load ? a[1] : a[0]).replace(/\s/g, "").toLowerCase();
        const st = load ? 0 : 0x0200;
        const simple: Record<string, number> = {
          x: 0x900c, "x+": 0x900d, "-x": 0x900e, y: 0x8008, "y+": 0x9009, "-y": 0x900a,
          z: 0x8000, "z+": 0x9001, "-z": 0x9002,
        };
        if (ptr in simple) { emit(simple[ptr] | st | (r << 4)); continue; }
        const dm = /^([yz])\+(.+)$/.exec(ptr);
        if (!dm) throw new AsmError(l.no, `bad pointer operand '${ptr}'`);
        const q = ev(dm[2]);
        if (q < 0 || q > 63) throw new AsmError(l.no, "displacement must be 0..63");
        emit((dm[1] === "y" ? 0x8008 : 0x8000) | st | (r << 4) | ((q & 0x20) << 8) | ((q & 0x18) << 7) | (q & 7));
        continue;
      }
      if (mn === "lds") { need(2); emit(0x9000 | (reg(a[0], l.no) << 4)); emit(ev(a[1])); continue; }
      if (mn === "sts") { need(2); emit(0x9200 | (reg(a[1], l.no) << 4)); emit(ev(a[0])); continue; }
      throw new AsmError(l.no, `unknown instruction '${mn}'`);
    } catch (e) {
      if (e instanceof AsmError) throw e;
      throw new AsmError(l.no, (e as Error).message);
    }
  }
  const bytes = new Uint8Array(maxAddr * 2).fill(0xff);
  for (const [addr, w] of words) {
    bytes[addr * 2] = w & 0xff;
    bytes[addr * 2 + 1] = w >> 8;
  }
  return { bytes, labels, lineMap };
}
