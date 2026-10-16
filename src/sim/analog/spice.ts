// Parser for the SPICE-style primitive netlists that component models carry.
//
//   R1 A B 10k
//   C1 A 0 100n
//   L1 A B 1m
//   D1 A K DMOD          .model DMOD D(IS=2.5n N=1.75 RS=0.5 BV=5.1)
//   Q1 C B E QMOD        .model QMOD NPN(IS=1e-14 BF=200)
//   M1 D G S NMOD        .model NMOD NMOS(VTO=2 KP=0.1)
//   V1 A 0 DC 5 | PULSE(0 5 0 1n 1n 1m 2m) | SIN(0 1 1k)
//   I1 A B 1m
//   E1 OUT 0 INP INN 1e5
//   G1 OUT 0 INP INN 1m
//   S1 A B CP CN SWMOD       .model SWMOD SW(VT=2.5 VH=0.2 RON=1 ROFF=1e9)
//   X1 INP INN OUT VCC VEE OPAMP(GAIN=1e5 HEADROOM=1.5)
//
// Node names are resolved through a callback so the caller can map pin ids to
// circuit nodes and allocate private internal nodes. `{KEY}` is replaced by the
// instance's property value before parsing.

import {
  AnalogElement, } from "./mna";
import {
  Bjt, Capacitor, CurrentSource, Diode, DEFAULT_DIODE, Inductor, Mosfet, OpAmp, Resistor, Vccs, Vcvs,
  VoltageSource, VSwitch, Waveform,
} from "./elements";
import { parseValue } from "../units";

export interface SpiceParseResult {
  elements: { name: string; el: AnalogElement }[];
}

interface ModelCard {
  type: string;
  params: Record<string, number>;
}

export function substituteProps(text: string, props: Record<string, string>): string {
  return text.replace(/\{([A-Za-z_][\w]*)\}/g, (_m, k: string) => {
    const v = props[k] ?? props[k.toUpperCase()] ?? props[k.toLowerCase()];
    if (v === undefined) throw new Error(`netlist references unknown property {${k}}`);
    return v;
  });
}

function parseParams(s: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of s.matchAll(/([A-Za-z_]\w*)\s*=\s*([^\s,()]+)/g)) {
    out[m[1].toLowerCase()] = parseValue(m[2]);
  }
  return out;
}

function parseWaveform(tokens: string[]): Waveform {
  const joined = tokens.join(" ");
  const fn = /^(pulse|sin)\s*\(([^)]*)\)/i.exec(joined);
  if (fn) {
    const a = fn[2].trim().split(/[\s,]+/).filter(Boolean).map(parseValue);
    if (fn[1].toLowerCase() === "pulse") {
      const [v1 = 0, v2 = 0, td = 0, tr = 1e-9, tf = 1e-9, pw = 1e-3, per = 2e-3] = a;
      return { kind: "pulse", v1, v2, td, tr: tr || 1e-9, tf: tf || 1e-9, pw, per };
    }
    const [vo = 0, va = 0, freq = 1e3, td = 0] = a;
    return { kind: "sin", vo, va, freq, td };
  }
  const t = tokens.filter((x) => x.toLowerCase() !== "dc");
  return { kind: "dc", v: t.length ? parseValue(t[0]) : 0 };
}

export function parseSpice(
  text: string,
  node: (name: string) => number,
): SpiceParseResult {
  const models = new Map<string, ModelCard>();
  const lines: string[] = [];
  // Join continuation lines ("+ ...") and strip comments.
  for (const raw of text.split(/\r?\n|;/)) {
    const line = raw.replace(/(^\s*\*.*$)|(\$.*$)/, "").trim();
    if (!line) continue;
    if (line.startsWith("+") && lines.length) lines[lines.length - 1] += " " + line.slice(1);
    else lines.push(line);
  }
  for (const line of lines) {
    const m = /^\.model\s+(\S+)\s+([A-Za-z]+)\s*\(?(.*?)\)?\s*$/i.exec(line);
    if (m) models.set(m[1].toLowerCase(), { type: m[2].toUpperCase(), params: parseParams(m[3]) });
  }
  const elements: { name: string; el: AnalogElement }[] = [];
  const add = (name: string, el: AnalogElement) => elements.push({ name, el });
  const card = (name: string, want: string[]): ModelCard => {
    const c = models.get(name.toLowerCase());
    if (!c) throw new Error(`unknown .model ${name}`);
    if (!want.includes(c.type)) throw new Error(`.model ${name} is ${c.type}, expected ${want.join("/")}`);
    return c;
  };
  for (const line of lines) {
    if (line.startsWith(".")) continue;
    // Keep parenthesised groups together.
    const tokens = line.match(/[^\s(]+\([^)]*\)|\S+/g) ?? [];
    const name = tokens[0] ?? "";
    const kind = name[0].toUpperCase();
    const tok = (i: number): string => {
      const t = tokens[i];
      if (t === undefined) throw new Error(`${name}: missing field ${i}`);
      return t;
    };
    const n = (i: number) => node(tok(i));
    try {
      switch (kind) {
        case "R":
          add(name, new Resistor(n(1), n(2), parseValue(tok(3))));
          break;
        case "C": {
          const ic = /ic\s*=\s*(\S+)/i.exec(line);
          add(name, new Capacitor(n(1), n(2), parseValue(tok(3)), ic ? parseValue(ic[1]) : 0));
          break;
        }
        case "L":
          add(name, new Inductor(n(1), n(2), parseValue(tok(3))));
          break;
        case "V":
          add(name, new VoltageSource(n(1), n(2), parseWaveform(tokens.slice(3))));
          break;
        case "I":
          add(name, new CurrentSource(n(1), n(2), parseWaveform(tokens.slice(3))));
          break;
        case "D": {
          const p = tokens[3] ? card(tokens[3], ["D"]).params : {};
          let a = n(1);
          const k = n(2);
          if (p.rs && p.rs > 0) {
            const mid = node(`${name}#rs`);
            add(`${name}.RS`, new Resistor(a, mid, p.rs));
            a = mid;
          }
          add(name, new Diode(a, k, { is: p.is ?? DEFAULT_DIODE.is, n: p.n ?? 1, bv: p.bv ?? 0, ibv: p.ibv ?? DEFAULT_DIODE.ibv }));
          break;
        }
        case "Q": {
          const c = card(tok(4), ["NPN", "PNP"]);
          add(name, new Bjt(n(1), n(2), n(3), {
            is: c.params.is ?? 1e-14, bf: c.params.bf ?? 100, br: c.params.br ?? 1, pnp: c.type === "PNP",
          }));
          break;
        }
        case "M": {
          // Accept both 3-terminal (D G S model) and SPICE 4-terminal (D G S B model).
          const modelTok = models.has((tokens[4] ?? "").toLowerCase()) ? tokens[4] : tokens[5];
          const c = card(modelTok ?? "", ["NMOS", "PMOS"]);
          const pmos = c.type === "PMOS";
          add(name, new Mosfet(n(1), n(2), n(3), {
            vto: c.params.vto ?? (pmos ? -2 : 2), kp: c.params.kp ?? 2e-5, lambda: c.params.lambda ?? 0,
            w: c.params.w ?? 1, l: c.params.l ?? 1, pmos,
          }));
          break;
        }
        case "E":
          add(name, new Vcvs(n(1), n(2), n(3), n(4), parseValue(tok(5))));
          break;
        case "G":
          add(name, new Vccs(n(1), n(2), n(3), n(4), parseValue(tok(5))));
          break;
        case "S": {
          const c = card(tok(5), ["SW"]);
          add(name, new VSwitch(n(1), n(2), n(3), n(4),
            c.params.vt ?? 2.5, c.params.vh ?? 0.1, c.params.ron ?? 1, c.params.roff ?? 1e9));
          break;
        }
        case "X": {
          const sub = tokens[6] ?? "";
          if (!/^opamp/i.test(sub)) throw new Error(`only the OPAMP behavioural block is supported for X elements`);
          const p = parseParams(sub.replace(/^opamp/i, ""));
          add(name, new OpAmp(n(1), n(2), n(3), n(4), n(5), p.gain ?? 1e5, p.headroom ?? 1.5));
          break;
        }
        default:
          throw new Error(`unsupported element type '${kind}'`);
      }
    } catch (e) {
      throw new Error(`${line}: ${(e as Error).message}`);
    }
  }
  return { elements };
}
