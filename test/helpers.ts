import type { ComponentDef, Netlist } from "../src/shared/component";
import { BUILTIN_LIBRARY } from "../src/shared/library";
import { Simulator, SimOptions } from "../src/sim/engine";
import { createModel } from "../src/sim/models";

export function lib(id: string): ComponentDef {
  const d = BUILTIN_LIBRARY.find((x) => x.id === id);
  if (!d) throw new Error(`no part ${id}`);
  return d;
}

/** Tiny netlist builder: net("N1", "R1.A", "C1.B"). Net "GND" is ground. */
export class Circuit {
  private nl: Netlist = { instances: [], nets: [] };
  add(ref: string, def: ComponentDef | string, props: Record<string, string> = {}, files?: Record<string, string>): this {
    this.nl.instances.push({ ref, def: typeof def === "string" ? lib(def) : def, props, files });
    return this;
  }
  net(name: string, ...pins: string[]): this {
    let n = this.nl.nets.find((x) => x.name === name);
    if (!n) {
      n = { name, ground: name === "GND", pins: [] };
      this.nl.nets.push(n);
    }
    for (const p of pins) {
      const [ref, pin] = p.split(".");
      n.pins.push({ ref, pin });
    }
    return this;
  }
  sim(opts?: SimOptions): Simulator {
    return new Simulator(this.nl, createModel, opts);
  }
}

export function volts(sim: Simulator, net: string): number {
  const s = sim.netStates()[net];
  if (!s || s.v === undefined) throw new Error(`net ${net} is not analog`);
  return s.v;
}
