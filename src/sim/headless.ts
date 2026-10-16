// Headless simulation run with a compact, model-readable report. Used by the
// design assistant to check that a circuit does what was asked.

import type { ComponentDef, Netlist } from "../shared/component";
import { Simulator } from "./engine";
import { Level } from "./logic";
import { createModel } from "./models";

export interface SimAction {
  at: number;
  ref: string;
  action: Record<string, unknown>;
}

export interface HeadlessOptions {
  seconds: number;
  actions?: SimAction[];
  watch?: string[];
  /** Wall-clock budget in ms; the run stops early (and says so) past it. */
  wallMs?: number;
}

const SEG_DIGITS: Record<number, string> = {
  0x3f: "0", 0x06: "1", 0x5b: "2", 0x4f: "3", 0x66: "4", 0x6d: "5", 0x7d: "6", 0x07: "7", 0x7f: "8", 0x6f: "9",
  0x77: "A", 0x7c: "b", 0x39: "C", 0x5e: "d", 0x79: "E", 0x71: "F", 0x00: " ",
};

const r3 = (v: number) => Math.round(v * 1000) / 1000;

function summarize(def: ComponentDef, ind: any): unknown {
  if (ind === undefined || ind === null) return undefined;
  const b = def.model.builtin;
  switch (b) {
    case "led": return { lit: ind.brightness > 0.3, brightness: r3(ind.brightness), current_mA: r3(ind.current * 1000), overloaded: ind.overloaded || undefined };
    case "hd44780": return { display_on: ind.on, lines: (ind.lines as number[][]).map((row) => row.map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : "?")).join("")) };
    case "vterm": return { received: String(ind.text).slice(-1500), framing_errors: ind.framingErrors || undefined };
    case "logicprobe": case "logicstate": return { level: ["0", "1", "Z", "X"][ind.level] ?? ind.level };
    case "voltmeter": case "ammeter": return { value: r3(ind.value), unit: ind.unit };
    case "sevenseg": return { segments: ind.segments, shows: SEG_DIGITS[ind.segments & 0x7f] ?? "?", dp: !!(ind.segments & 0x80) };
    case "button": case "switch": return { closed: ind.closed };
    case "pot": return { position: r3(ind.position) };
    case "scope": {
      const s = ind.samples as number[][];
      if (!s.length) return { note: "no samples" };
      const out: Record<string, unknown> = {};
      ["A", "B", "C", "D"].forEach((ch, i) => {
        const vals = s.map((r) => r[i + 1]).filter((v) => !Number.isNaN(v));
        if (!vals.length) return;
        const min = Math.min(...vals), max = Math.max(...vals);
        const mid = (min + max) / 2;
        let rises = 0;
        for (let k = 1; k < vals.length; k++) if (vals[k - 1] < mid && vals[k] >= mid) rises++;
        const span = s[s.length - 1][0] - s[0][0];
        out[ch] = { min: r3(min), max: r3(max), approx_freq_hz: max - min > 0.05 && span > 0 ? Math.round(rises / span) : 0 };
      });
      return out;
    }
  }
  if (def.model.kind === "mcu") return { program_loaded: ind.loaded, cycles: ind.cycles, sleeping: ind.sleeping };
  if (def.model.kind === "emulator") return { controls: ind.controls, dac_volts: ind.dacs, backing_mcu_cycles: ind.cycles };
  return undefined; // behavioural internals are noise for the report
}

export function runHeadless(netlist: Netlist, opts: HeadlessOptions) {
  const seconds = Math.min(Math.max(opts.seconds, 1e-4), 5);
  const wallMs = opts.wallMs ?? 8000;
  const sim = new Simulator(netlist, createModel);
  const actions = [...(opts.actions ?? [])].sort((a, b) => a.at - b.at);
  const watch = new Map<string, { min: number; max: number; edges: number; last?: number | Level }>();
  for (const n of opts.watch ?? []) watch.set(n, { min: Infinity, max: -Infinity, edges: 0 });
  const unknownActions = actions.filter((a) => !netlist.instances.some((i) => i.ref === a.ref)).map((a) => a.ref);
  const start = Date.now();
  const step = 1e-4;
  let truncated = false;
  let ai = 0;
  for (let t = 0; t < seconds - 1e-12 && !sim.failed;) {
    while (ai < actions.length && actions[ai].at <= t + 1e-12) {
      sim.actuate(actions[ai].ref, actions[ai].action);
      ai++;
    }
    t = Math.min(seconds, t + step);
    sim.runUntil(t);
    if (watch.size) {
      const states = sim.netStates();
      for (const [name, w] of watch) {
        const s = states[name];
        if (!s) continue;
        const val = s.v ?? (s.level === Level.H ? 1 : s.level === Level.L ? 0 : NaN);
        if (Number.isNaN(val)) continue;
        w.min = Math.min(w.min, val);
        w.max = Math.max(w.max, val);
        const digital = s.v === undefined ? val : val > (w.min + w.max) / 2 ? 1 : 0;
        if (w.last !== undefined && digital !== w.last) w.edges++;
        w.last = digital;
      }
    }
    if (Date.now() - start > wallMs) {
      truncated = true;
      break;
    }
  }
  const indicators: Record<string, unknown> = {};
  const ind = sim.indicateAll();
  for (const inst of netlist.instances) {
    const s = summarize(inst.def, ind[inst.ref]);
    if (s !== undefined) indicators[inst.ref] = s;
  }
  const states = sim.netStates();
  const nets: Record<string, string> = {};
  for (const [name, s] of Object.entries(states)) {
    if (/^N\d+$/.test(name) && !watch.has(name)) continue; // anonymous nets are noise
    nets[name] = s.v !== undefined ? `${r3(s.v)} V` : ["LOW", "HIGH", "FLOATING", "CONFLICT"][s.level ?? 2];
  }
  return {
    simulated_seconds: r3(sim.time),
    stopped_early: truncated ? `wall-clock budget reached at ${r3(sim.time)} s` : undefined,
    failed: sim.failed ?? undefined,
    indicators,
    nets,
    watched: Object.fromEntries([...watch].map(([n, w]) => [n, w.min === Infinity ? "not found" : { min: r3(w.min), max: r3(w.max), transitions: w.edges }])),
    warnings: sim.logs.filter((l) => l.level !== "info").slice(0, 30).map((l) => `${r3(l.time)}s ${l.source}: ${l.message}`),
    unknown_action_refs: unknownActions.length ? unknownActions : undefined,
  };
}
