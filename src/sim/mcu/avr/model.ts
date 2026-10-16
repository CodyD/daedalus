// AVR microcontroller simulation model: binds the CPU core and its on-chip
// peripherals to the schematic part's pins, loads the firmware named by the
// PROGRAM property, and runs at the CLOCK property's frequency.

import type { AvrVariant } from "../../../shared/component";
import type { DPin, ModelContext, SimModel } from "../../engine";
import { Drive, Level } from "../../logic";
import { parseIntelHex } from "../hex";
import { AvrCore } from "./core";
import { AvrAdc, AvrTimer, AvrUsart, GpioPort, McuBus, attachEeprom, attachExtInt, attachPcint } from "./peripherals";

export class AvrMcuModel implements SimModel {
  core!: AvrCore;
  private freq = 16e6;
  private ctx!: ModelContext;
  private pins = new Map<string, DPin>();
  private ports = new Map<string, GpioPort>();
  private pinListeners = new Map<string, ((t: number, l: Level) => void)[]>();
  private owned = new Set<string>();
  private loaded = false;
  private faults = 0;

  /** program: firmware image to run instead of the PROGRAM property's file (emulated parts). */
  constructor(private variant: AvrVariant, private defaultClock: number, private program?: Uint8Array) {}

  setup(ctx: ModelContext): void {
    this.ctx = ctx;
    const v = this.variant;
    this.freq = ctx.num("CLOCK", this.defaultClock) || this.defaultClock;
    const ramEnd = v.sramStart + v.sramBytes - 1;
    this.core = new AvrCore({ flashBytes: v.flashBytes, ramEnd, sreg: v.sreg, spl: v.spl, sph: v.sph, vectorWords: v.vectorWords });
    this.core.onFault = (msg) => {
      if (this.faults++ < 5) ctx.warn(msg);
    };

    for (const p of ctx.def.pins) {
      if (!p.port || !/^P[A-Z]\d$/.test(p.port)) continue;
      const name = p.port;
      const pin = ctx.pin(p.id, {
        onChange: (t, l) => this.pinListeners.get(name)?.forEach((fn) => fn(t, l)),
      });
      this.pins.set(name, pin);
    }

    const bus: McuBus = {
      core: this.core,
      freq: this.freq,
      vcc: ctx.num("VCC", 5),
      time: (c) => c / this.freq,
      pin: (n) => this.pins.get(n),
      override: (n, d, cycle) => this.override(n, d, cycle),
      onPinChange: (n, fn) => {
        const list = this.pinListeners.get(n) ?? [];
        list.push(fn);
        this.pinListeners.set(n, list);
      },
      schedule: (t, fn) => ctx.schedule(t, fn),
      voltage: (n) => this.pins.get(n)?.voltage() ?? 0,
    };

    for (const port of v.ports) {
      const g = new GpioPort(bus, port.name, port);
      this.ports.set(port.name, g);
      this.core.addPeripheral(g);
    }
    for (const t of v.timers) this.core.addPeripheral(new AvrTimer(bus, t));
    if (v.usart) this.core.addPeripheral(new AvrUsart(bus, v.usart));
    if (v.adc) this.core.addPeripheral(new AvrAdc(bus, v.adc));
    if (v.extInt) attachExtInt(bus, v.extInt);
    if (v.pcint) attachPcint(bus, v.pcint);
    if (v.eeprom) attachEeprom(bus, v.eeprom, v.eepromBytes);

    const hex = this.program ? null : ctx.file("PROGRAM");
    if (this.program) {
      this.core.loadProgram(this.program);
      this.loaded = true;
    } else if (!hex) {
      ctx.warn("No program file specified; the CPU will not run (set the PROGRAM property to a .hex file)");
    } else {
      try {
        const bytes = parseIntelHex(hex);
        if (bytes.length > v.flashBytes) throw new Error(`program is ${bytes.length} bytes, flash is ${v.flashBytes}`);
        this.core.loadProgram(bytes);
        this.loaded = true;
        ctx.log(`loaded ${bytes.length} bytes of firmware, clock ${this.freq / 1e6} MHz`);
      } catch (e) {
        ctx.warn(`could not load program: ${(e as Error).message}`);
      }
    }
    this.core.reschedule();
  }

  private override(portBit: string, d: Drive | "owned" | null, cycle: number): void {
    const m = /^P([A-Z])(\d)$/.exec(portBit);
    if (!m) return;
    const port = this.ports.get(m[1]);
    if (!port) return;
    const b = +m[2];
    if (this.owned.has(portBit) && d !== "owned") port.forget(b);
    if (d === "owned") this.owned.add(portBit);
    else this.owned.delete(portBit);
    port.setOverride(b, d, cycle);
  }

  start(): void {
    for (const p of this.ports.values()) p.update(0);
  }

  advance(t: number): void {
    if (!this.loaded) return;
    const end = Math.floor(t * this.freq);
    this.core.run(end);
    this.core.syncPeripherals();
  }

  indicate(): unknown {
    const c = this.core;
    return {
      loaded: this.loaded,
      pc: c.pc * 2,
      cycles: c.cycles,
      sreg: c.sreg,
      sp: c.sp,
      sleeping: c.sleeping,
      regs: Array.from(c.data.subarray(0, 32)),
      clock: this.freq,
    };
  }
}
