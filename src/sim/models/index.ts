// Model factory: maps a component's `model` description to a simulation model,
// the way Proteus resolves PRIMITIVE / MODFILE / MODDLL on a library part.

import type { NetlistInstance } from "../../shared/component";
import { parseSpice, substituteProps } from "../analog/spice";
import { BehaviorModel } from "../behavior/model";
import type { ModelContext, SimModel } from "../engine";
import { EmulatorModel } from "../mcu/avr/emulator";
import { AvrMcuModel } from "../mcu/avr/model";
import { BUILTINS } from "./builtins";

class SpiceModel implements SimModel {
  constructor(private text: string) {}
  setup(ctx: ModelContext): void {
    const props: Record<string, string> = {};
    for (const p of ctx.def.properties) props[p.key] = ctx.prop(p.key);
    const text = substituteProps(this.text, props);
    const { elements } = parseSpice(text, (name) => {
      if (ctx.hasPin(name)) return ctx.node(name);
      if (name === "0" || name.toUpperCase() === "GND") return 0;
      return ctx.internalNode(name);
    });
    for (const { el } of elements) ctx.addElement(el);
  }
}

class CompositeModel implements SimModel {
  constructor(private parts: SimModel[]) {}
  setup(ctx: ModelContext): void {
    this.parts.forEach((p) => p.setup(ctx));
  }
  start(): void {
    this.parts.forEach((p) => p.start?.());
  }
  afterAnalogStep(t: number): void {
    this.parts.forEach((p) => p.afterAnalogStep?.(t));
  }
  indicate(): unknown {
    for (const p of this.parts) {
      const v = p.indicate?.();
      if (v !== undefined) return v;
    }
    return undefined;
  }
}

class NullModel implements SimModel {
  constructor(private why: string) {}
  setup(ctx: ModelContext): void {
    if (this.why) ctx.warn(this.why);
  }
}

export function createModel(inst: NetlistInstance): SimModel {
  const m = inst.def.model;
  switch (m.kind) {
    case "spice":
      if (!m.spice) throw new Error("spice model has no netlist");
      return new SpiceModel(m.spice);
    case "logic":
      if (!m.logic) throw new Error("logic model has no program");
      return new BehaviorModel(m.logic);
    case "mixed":
      return new CompositeModel([
        ...(m.spice ? [new SpiceModel(m.spice)] : []),
        ...(m.logic ? [new BehaviorModel(m.logic)] : []),
      ]);
    case "builtin": {
      const f = m.builtin ? BUILTINS[m.builtin] : undefined;
      if (!f) throw new Error(`unknown built-in model '${m.builtin}'`);
      return f();
    }
    case "mcu": {
      const mcu = m.mcu;
      if (!mcu) throw new Error("mcu model missing description");
      if (mcu.core === "avr8" && mcu.variant) return new AvrMcuModel(mcu.variant, mcu.defaultClockHz);
      return new NullModel(`${mcu.coreName} core is not simulated yet; part is placed for wiring only`);
    }
    case "emulator":
      if (!m.emulator) throw new Error("emulator model missing description");
      return new EmulatorModel(m.emulator);
    case "none":
      return new NullModel(`no simulation model for ${inst.def.name}`);
  }
}
