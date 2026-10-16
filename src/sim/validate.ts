// Static + dry-run validation of a component definition. Used on every
// AI-imported part before it reaches the library: errors are fed back to
// Claude for a repair round, warnings are shown to the user.

import { ComponentDef } from "../shared/component";
import { parseSpice, substituteProps } from "./analog/spice";
import { parseProgram, programNames } from "./behavior/dsl";
import { Simulator } from "./engine";
import { checkEmulator } from "./mcu/avr/emulator";
import { createModel } from "./models";
import { BUILTINS } from "./models/builtins";

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export function validateComponent(input: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = ComponentDef.safeParse(input);
  if (!parsed.success) {
    return { errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`), warnings };
  }
  const def = parsed.data;
  const ids = new Set<string>();
  for (const p of def.pins) {
    if (!/^[A-Za-z_]\w*$/.test(p.id)) errors.push(`pin id '${p.id}' must be an identifier (letters, digits, _)`);
    if (ids.has(p.id)) errors.push(`duplicate pin id '${p.id}'`);
    ids.add(p.id);
  }
  const numbers = new Set<string>();
  for (const p of def.pins) {
    if (numbers.has(p.number)) warnings.push(`pin number ${p.number} appears more than once`);
    numbers.add(p.number);
  }
  const props: Record<string, string> = {};
  for (const p of def.properties) props[p.key] = p.default;
  const m = def.model;

  if ((m.kind === "spice" || m.kind === "mixed") && m.spice) {
    try {
      parseSpice(substituteProps(m.spice, props), () => 1);
    } catch (e) {
      errors.push(`spice: ${(e as Error).message}`);
    }
  }
  if ((m.kind === "logic" || m.kind === "mixed") && m.logic) {
    try {
      const prog = parseProgram(m.logic);
      const { reads, writes } = programNames(prog);
      const states = new Set(prog.states.map((s) => s.name));
      for (const n of [...reads, ...writes]) {
        if (!states.has(n) && !ids.has(n)) errors.push(`logic: '${n}' is neither a pin id nor a declared state`);
      }
      for (const w of writes) {
        const p = def.pins.find((x) => x.id === w);
        if (p && (p.type === "input" || p.type === "power" || p.type === "ground")) {
          errors.push(`logic: assigns to pin '${w}', which is declared as ${p.type}`);
        }
      }
    } catch (e) {
      errors.push(`logic: ${(e as Error).message}`);
    }
  }
  if (m.kind === "spice" && !m.spice) errors.push("model.kind is spice but model.spice is empty");
  if (m.kind === "logic" && !m.logic) errors.push("model.kind is logic but model.logic is empty");
  if (m.kind === "builtin" && !(m.builtin && m.builtin in BUILTINS)) {
    errors.push(`unknown builtin '${m.builtin}'; available: ${Object.keys(BUILTINS).join(", ")}`);
  }
  if (m.kind === "emulator") errors.push(...checkEmulator(def));
  if (m.kind === "mcu") {
    const mcu = m.mcu;
    if (!mcu) errors.push("model.kind is mcu but model.mcu is missing");
    else if (mcu.core === "avr8") {
      const v = mcu.variant;
      if (!v) errors.push("avr8 core requires model.mcu.variant");
      else {
        const portNames = new Set(v.ports.map((p) => p.name));
        for (const p of def.pins) {
          if (p.port && !portNames.has(p.port[1])) errors.push(`pin ${p.id} maps to ${p.port}, but variant has no port ${p.port[1]}`);
        }
        const used = new Map<number, string>();
        const claim = (addr: number | undefined, what: string) => {
          if (addr === undefined) return;
          const prev = used.get(addr);
          if (prev && prev !== what) errors.push(`register address 0x${addr.toString(16)} used for both ${prev} and ${what}`);
          used.set(addr, what);
        };
        v.ports.forEach((p) => { claim(p.pin, `PIN${p.name}`); claim(p.ddr, `DDR${p.name}`); claim(p.port, `PORT${p.name}`); });
        v.timers.forEach((t) => Object.entries(t.regs).forEach(([k, a]) => {
          if (k !== "TIMSK" && k !== "TIFR") claim(a, `${t.name}.${k}`);
        }));
        if (v.sramStart < 0x60) errors.push("sramStart below 0x60 overlaps the register file / I/O space");
        if (!def.pins.some((p) => p.port)) errors.push("no pin has a 'port' mapping; GPIO cannot be connected");
      }
    } else {
      warnings.push(`${mcu.coreName} core cannot execute firmware yet; the part will be wiring-only`);
    }
  }
  if (m.kind === "none") warnings.push("part has no simulation model");

  // Dry run: instantiate the part alone; setup errors surface in the log.
  if (!errors.length) {
    try {
      const sim = new Simulator({ instances: [{ ref: "U1", def, props: {} }], nets: [] }, createModel);
      for (const l of sim.logs) {
        if (l.level === "error") errors.push(`simulation setup: ${l.message}`);
        else if (l.level === "warn" && !/program file|core is not simulated|no simulation model/i.test(l.message)) {
          warnings.push(l.message);
        }
      }
    } catch (e) {
      errors.push(`simulation setup: ${(e as Error).message}`);
    }
  }
  return { errors, warnings };
}
