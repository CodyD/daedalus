// Emulated parts: a sensor or module simulated by a hidden "backing" AVR
// running emulator firmware (see EmulatorDef in shared/component.ts).
//
// The backing MCU is an ATmega328P core. Pins whose `port` is a port bit
// (PD1...) are its GPIO, so USART, timers and pin-change interrupts work as on
// a normal MCU. Two extras live in reserved SRAM, which the firmware must not
// use for anything else:
//
//   0x0100 + 4*i  CTRL_<KEY>    control i as a signed 32-bit little-endian
//                              integer, round(value * scale), written by the
//                              simulator when the user moves the control
//   0x0140 + 2*i  DAC0..DAC3    16-bit little-endian millivolts the firmware
//                              writes; drives the pin mapped to DACi
//   0x0148        CTRL_CHANGED  incremented by the simulator on every control
//                              change, so firmware can poll for updates
//   0x0150..      EMU_RAM       first address free for firmware variables

import type { ComponentDef, EmulatorDef } from "../../../shared/component";
import { Resistor, VoltageSource } from "../../analog/elements";
import type { ModelContext, SimModel } from "../../engine";
import { assemble } from "./asm";
import { AvrMcuModel } from "./model";
import { ATMEGA328P, M328P_SYMBOLS } from "./variants";

export const EMU_CTRL_BASE = 0x0100;
export const EMU_DAC_BASE = 0x0140;
export const EMU_CTRL_CHANGED = 0x0148;
export const EMU_RAM = 0x0150;
export const EMU_MAX_CONTROLS = 16;
export const EMU_DACS = 4;
/** Output resistance of a virtual DAC pin (ohms). */
const DAC_ROUT = 50;

/** Assembler symbols for an emulator's firmware: ATmega328P registers plus the reserved RAM map. */
export function emulatorSymbols(em: Pick<EmulatorDef, "controls">): Record<string, number> {
  const syms: Record<string, number> = { ...M328P_SYMBOLS, CTRL_CHANGED: EMU_CTRL_CHANGED, EMU_RAM };
  em.controls.forEach((c, i) => { syms[`CTRL_${c.key}`] = EMU_CTRL_BASE + 4 * i; });
  for (let i = 0; i < EMU_DACS; i++) syms[`DAC${i}`] = EMU_DAC_BASE + 2 * i;
  return syms;
}

export const assembleEmulator = (em: EmulatorDef) => assemble(em.source, emulatorSymbols(em));

/** Instance property holding a control's current value. */
export const controlProp = (key: string) => `ctl.${key}`;

const parseControl = (s: string | undefined): number | null => {
  const v = s?.trim() ? Number(s) : NaN;
  return Number.isFinite(v) ? v : null;
};

export function controlValue(def: ComponentDef, props: Record<string, string>, key: string): number {
  const c = def.model.emulator?.controls.find((x) => x.key === key);
  const v = parseControl(props[controlProp(key)]);
  return v ?? c?.default ?? 0;
}

/** Problems with an emulated part's definition (empty when it is usable). */
export function checkEmulator(def: ComponentDef): string[] {
  const em = def.model.emulator;
  if (!em) return ["model.kind is emulator but model.emulator is missing"];
  const errors: string[] = [];
  if (em.controls.length > EMU_MAX_CONTROLS) errors.push(`at most ${EMU_MAX_CONTROLS} controls`);
  const keys = new Set<string>();
  for (const c of em.controls) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(c.key)) errors.push(`control key '${c.key}' must be upper-case letters, digits and _`);
    if (keys.has(c.key)) errors.push(`duplicate control key '${c.key}'`);
    keys.add(c.key);
    if (!(c.min < c.max)) errors.push(`control ${c.key}: min must be below max`);
    if (c.default < c.min || c.default > c.max) errors.push(`control ${c.key}: default ${c.default} is outside ${c.min}..${c.max}`);
    const scale = c.scale ?? 1;
    if (Math.max(Math.abs(c.min), Math.abs(c.max)) * scale > 0x7fffffff) errors.push(`control ${c.key}: max * scale overflows 32 bits`);
  }
  const ports = new Set(ATMEGA328P.ports.map((p) => p.name));
  const used = new Map<string, string>();
  for (const p of def.pins) {
    if (!p.port) continue;
    const gpio = /^P([A-Z])([0-7])$/.exec(p.port);
    const dac = /^DAC([0-3])$/.exec(p.port);
    if (!(gpio && ports.has(gpio[1]) && !(gpio[1] === "C" && gpio[2] === "7")) && !dac) {
      errors.push(`pin ${p.id} maps to '${p.port}': use a backing-MCU port bit (PB0-PB7, PC0-PC6, PD0-PD7) or DAC0-DAC3`);
    }
    const prev = used.get(p.port);
    if (prev) errors.push(`pins ${prev} and ${p.id} both map to ${p.port}`);
    used.set(p.port, p.id);
  }
  try {
    const r = assembleEmulator(em);
    if (r.bytes.length > ATMEGA328P.flashBytes) errors.push(`firmware is ${r.bytes.length} bytes, flash is ${ATMEGA328P.flashBytes}`);
  } catch (e) {
    errors.push(`firmware: ${(e as Error).message}`);
  }
  return errors;
}

export class EmulatorModel implements SimModel {
  private mcu: AvrMcuModel;
  private ctx!: ModelContext;
  private values: number[] = [];
  private dacs: { index: number; src: VoltageSource; mv: number }[] = [];

  constructor(private em: EmulatorDef) {
    this.mcu = new AvrMcuModel(ATMEGA328P, em.clockHz, assembleEmulator(em).bytes);
  }

  setup(ctx: ModelContext): void {
    this.ctx = ctx;
    this.mcu.setup(ctx);
    this.values = this.em.controls.map((c) => {
      return parseControl(ctx.prop(controlProp(c.key))) ?? c.default;
    });
    for (const p of ctx.def.pins) {
      const m = p.port && /^DAC([0-3])$/.exec(p.port);
      if (!m) continue;
      const inner = ctx.internalNode(`dac${m[1]}`);
      const src = new VoltageSource(inner, 0, { kind: "dc", v: 0 });
      ctx.addElement(src);
      ctx.addElement(new Resistor(inner, ctx.node(p.id), DAC_ROUT));
      this.dacs.push({ index: +m[1], src, mv: 0 });
    }
    this.writeControls();
  }

  start(): void {
    this.mcu.start();
  }

  advance(t: number): void {
    this.mcu.advance(t);
    const d = this.mcu.core.data;
    for (const dac of this.dacs) {
      const a = EMU_DAC_BASE + 2 * dac.index;
      const mv = d[a] | (d[a + 1] << 8);
      if (mv !== dac.mv) {
        dac.mv = mv;
        dac.src.setDc(mv / 1000);
        this.ctx.sim.kick(); // a quiet analog side would otherwise skip the re-solve
      }
    }
  }

  private writeControls(): void {
    const d = this.mcu.core.data;
    this.em.controls.forEach((c, i) => {
      const raw = Math.round(this.values[i] * (c.scale ?? 1)) | 0;
      const a = EMU_CTRL_BASE + 4 * i;
      d[a] = raw & 0xff;
      d[a + 1] = (raw >> 8) & 0xff;
      d[a + 2] = (raw >> 16) & 0xff;
      d[a + 3] = (raw >>> 24) & 0xff;
    });
    d[EMU_CTRL_CHANGED] = (d[EMU_CTRL_CHANGED] + 1) & 0xff;
  }

  /** { control: KEY, value } sets a sensed quantity. */
  actuate(a: Record<string, unknown>): void {
    const i = this.em.controls.findIndex((c) => c.key === a.control);
    if (i < 0 || typeof a.value !== "number" || !Number.isFinite(a.value)) {
      this.ctx.warn(`unknown emulator action ${JSON.stringify(a)}`);
      return;
    }
    const c = this.em.controls[i];
    this.values[i] = Math.min(c.max, Math.max(c.min, a.value));
    this.writeControls();
  }

  indicate(): unknown {
    const cpu = this.mcu.indicate() as Record<string, unknown>;
    return {
      emulator: true,
      loaded: cpu.loaded,
      cycles: cpu.cycles,
      sleeping: cpu.sleeping,
      clock: cpu.clock,
      controls: Object.fromEntries(this.em.controls.map((c, i) => [c.key, this.values[i]])),
      dacs: Object.fromEntries(this.dacs.map((x) => [`DAC${x.index}`, x.mv / 1000])),
    };
  }
}
