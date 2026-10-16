// On-chip AVR peripherals, parameterised by the variant's register map so the
// same code serves any AVR whose datasheet register summary we have.

import type { AvrTimerConfig, AvrVariant } from "../../../shared/component";
import type { DPin } from "../../engine";
import { Drive, Level } from "../../logic";
import { UartRx, uartSend } from "../../models/uart";
import type { AvrCore, Peripheral } from "./core";

/** Services the MCU model provides to its peripherals. */
export interface McuBus {
  core: AvrCore;
  freq: number;
  vcc: number;
  time(cycle: number): number;
  pin(portBit: string): DPin | undefined;
  /** Claim (or release with null) a pin for a peripheral function. */
  override(portBit: string, d: Drive | "owned" | null, cycle: number): void;
  onPinChange(portBit: string, fn: (t: number, l: Level) => void): void;
  schedule(t: number, fn: () => void): void;
  voltage(portBit: string): number;
}

// --- GPIO -------------------------------------------------------------------

export class GpioPort implements Peripheral {
  private overrides: (Drive | "owned" | null)[] = new Array(8).fill(null);
  private applied: Drive[] = new Array(8).fill(Drive.Z);
  /** Pin handles per bit, resolved once: PINx reads sit in tight polling loops. */
  private pins: (DPin | undefined)[];
  private lastDdr = -1;
  private lastPort = -1;

  constructor(private bus: McuBus, readonly name: string, private cfg: AvrVariant["ports"][number]) {
    const core = bus.core;
    this.pins = [0, 1, 2, 3, 4, 5, 6, 7].map((b) => bus.pin(this.bitName(b)));
    core.pinAddrs.add(cfg.pin);
    core.readHooks[cfg.pin] = () => this.readPins();
    core.writeHooks[cfg.pin] = (v) => {
      // Writing 1 to PINx toggles PORTx (ATmega48/88/168/328 and later).
      core.data[cfg.port] ^= v;
      core.data[cfg.pin] = 0;
      this.update(core.cycles);
    };
    core.writeHooks[cfg.port] = () => this.update(core.cycles);
    core.writeHooks[cfg.ddr] = () => this.update(core.cycles);
  }

  service(): void {}
  nextEvent(): number {
    return Infinity;
  }

  bitName(b: number): string {
    return `P${this.name}${b}`;
  }

  private readPins(): number {
    const ddr = this.bus.core.data[this.cfg.ddr];
    const port = this.bus.core.data[this.cfg.port];
    let v = 0;
    for (let b = 0; b < 8; b++) {
      const pin = this.pins[b];
      let bit: number;
      if (ddr & (1 << b) && !this.overrides[b]) bit = (port >> b) & 1;
      else if (pin) bit = pin.read() === Level.H ? 1 : 0;
      else bit = (port >> b) & 1 & (~ddr >> b);
      v |= bit << b;
    }
    return v;
  }

  setOverride(b: number, d: Drive | "owned" | null, cycle: number): void {
    this.overrides[b] = d;
    this.lastDdr = -1;
    this.update(cycle);
  }

  update(cycle: number): void {
    const ddr = this.bus.core.data[this.cfg.ddr];
    const port = this.bus.core.data[this.cfg.port];
    // Firmware often rewrites PORTx with the same value inside loops.
    if (ddr === this.lastDdr && port === this.lastPort) return;
    this.lastDdr = ddr;
    this.lastPort = port;
    for (let b = 0; b < 8; b++) {
      const ov = this.overrides[b];
      if (ov === "owned") continue;
      const out = ddr & (1 << b);
      let d: Drive;
      if (ov !== null && out) d = ov;
      else if (out) d = port & (1 << b) ? Drive.SH : Drive.SL;
      else d = port & (1 << b) ? Drive.WH : Drive.Z;
      if (d !== this.applied[b]) {
        this.applied[b] = d;
        this.pins[b]?.set(this.bus.time(cycle), d);
      }
    }
  }

  /** Re-sync after a peripheral releases an owned pin. */
  forget(b: number): void {
    this.applied[b] = -1 as Drive;
    this.lastDdr = -1;
  }
}

// --- Timers -----------------------------------------------------------------

type WaveMode = { kind: "normal" | "ctc" | "fast" | "pc"; top: "max" | "ocra" | "icr" | number };

const WGM8: Record<number, WaveMode> = {
  0: { kind: "normal", top: "max" }, 1: { kind: "pc", top: 0xff }, 2: { kind: "ctc", top: "ocra" },
  3: { kind: "fast", top: 0xff }, 5: { kind: "pc", top: "ocra" }, 7: { kind: "fast", top: "ocra" },
};
const WGM16: Record<number, WaveMode> = {
  0: { kind: "normal", top: "max" }, 1: { kind: "pc", top: 0xff }, 2: { kind: "pc", top: 0x1ff },
  3: { kind: "pc", top: 0x3ff }, 4: { kind: "ctc", top: "ocra" }, 5: { kind: "fast", top: 0xff },
  6: { kind: "fast", top: 0x1ff }, 7: { kind: "fast", top: 0x3ff }, 8: { kind: "pc", top: "icr" },
  9: { kind: "pc", top: "ocra" }, 10: { kind: "pc", top: "icr" }, 11: { kind: "pc", top: "ocra" },
  12: { kind: "ctc", top: "icr" }, 14: { kind: "fast", top: "icr" }, 15: { kind: "fast", top: "ocra" },
};

export class AvrTimer implements Peripheral {
  private tcnt = 0;
  private ocr = [0, 0];
  private icr = 0;
  private dir = 1;
  private last = 0;
  private temp = 0;
  private oc = [0, 0];
  private max: number;
  private fb: { tov: number; ocfa: number; ocfb: number; icf: number };

  constructor(private bus: McuBus, private cfg: AvrTimerConfig) {
    this.max = cfg.bits === 16 ? 0xffff : 0xff;
    this.fb = { tov: 0, ocfa: 1, ocfb: 2, icf: 5, ...cfg.flagBits };
    const core = bus.core;
    const r = cfg.regs;
    const wide = cfg.bits === 16;
    const cfgWrite = () => {
      this.serviceNow();
      this.applyOutputs(core.cycles);
      core.reschedule();
    };
    core.writeHooks[r.TCCRA] = cfgWrite;
    core.writeHooks[r.TCCRB] = cfgWrite;
    core.writeHooks[r.TIMSK] = () => core.irqChanged();
    const mine = (1 << this.fb.tov) | (1 << this.fb.ocfa) | (1 << this.fb.ocfb) | (1 << this.fb.icf);
    const prevTifr = core.writeHooks[r.TIFR];
    core.writeHooks[r.TIFR] = (v, a, old) => {
      core.data[r.TIFR] = old & ~(v & mine); // write 1 to clear (only this timer's bits)
      prevTifr?.(v, a, (old & ~mine) | (core.data[r.TIFR] & mine));
      core.irqChanged();
    };
    const prevRead = core.readHooks[r.TIFR]; // shared TIFR on older parts
    core.readHooks[r.TIFR] = (a) => {
      this.serviceNow();
      prevRead?.(a);
      return core.data[r.TIFR];
    };
    // Counter and compare registers (16-bit ones use the shared TEMP byte).
    const reg16 = (addr: number, get: () => number, set: (v: number) => void) => {
      if (!wide) {
        core.readHooks[addr] = () => get() & 0xff;
        core.writeHooks[addr] = (v) => set(v);
        return;
      }
      core.readHooks[addr] = () => {
        const v = get();
        this.temp = v >> 8;
        return v & 0xff;
      };
      core.readHooks[addr + 1] = () => this.temp;
      core.writeHooks[addr + 1] = (v) => { this.temp = v; };
      core.writeHooks[addr] = (v) => set((this.temp << 8) | v);
    };
    reg16(r.TCNT, () => { this.serviceNow(); return this.tcnt; }, (v) => {
      this.serviceNow();
      this.tcnt = v & this.max;
      core.reschedule();
    });
    reg16(r.OCRA, () => this.ocr[0], (v) => { this.serviceNow(); this.ocr[0] = v; core.reschedule(); });
    reg16(r.OCRB, () => this.ocr[1], (v) => { this.serviceNow(); this.ocr[1] = v; core.reschedule(); });
    if (r.ICR !== undefined) reg16(r.ICR, () => this.icr, (v) => { this.serviceNow(); this.icr = v; core.reschedule(); });

    const flag = (bit: number, vector: number | undefined) => {
      if (vector === undefined) return;
      core.addIrq({
        vector,
        pending: () => !!(core.data[r.TIFR] & core.data[r.TIMSK] & (1 << bit)),
        ack: () => { core.data[r.TIFR] &= ~(1 << bit); },
      });
    };
    flag(this.fb.tov, cfg.vectors.ovf);
    flag(this.fb.ocfa, cfg.vectors.compa);
    flag(this.fb.ocfb, cfg.vectors.compb);
    flag(this.fb.icf, cfg.vectors.capt);
  }

  private get tccra(): number {
    return this.bus.core.data[this.cfg.regs.TCCRA];
  }
  private get tccrb(): number {
    return this.bus.core.data[this.cfg.regs.TCCRB];
  }

  private mode(): WaveMode {
    const wgm = this.cfg.bits === 16
      ? (this.tccra & 3) | (((this.tccrb >> 3) & 3) << 2)
      : (this.tccra & 3) | (((this.tccrb >> 3) & 1) << 2);
    return (this.cfg.bits === 16 ? WGM16 : WGM8)[wgm] ?? { kind: "normal", top: "max" };
  }

  private top(m: WaveMode): number {
    if (m.top === "max") return this.max;
    if (m.top === "ocra") return this.ocr[0];
    if (m.top === "icr") return this.icr;
    return m.top;
  }

  private prescale(): number {
    const cs = this.tccrb & 7;
    return cs ? this.cfg.prescalers[cs - 1] ?? 0 : 0;
  }

  private serviceNow(): void {
    this.service(this.bus.core.cycles);
  }

  /** Ticks until the counter next lands on an interesting value. */
  private ticksToEvent(m: WaveMode, top: number): number {
    let best: number;
    if (m.kind === "pc") {
      if (this.dir > 0) {
        best = Math.max(top - this.tcnt, 1);
        for (const o of this.ocr) if (o > this.tcnt && o <= top) best = Math.min(best, o - this.tcnt);
      } else {
        best = Math.max(this.tcnt, 1);
        for (const o of this.ocr) if (o < this.tcnt) best = Math.min(best, this.tcnt - o);
      }
      return best;
    }
    const wrap = this.tcnt > top ? this.max - this.tcnt + 1 : top - this.tcnt + 1;
    best = wrap;
    for (const o of this.ocr) if (o > this.tcnt && o - this.tcnt < best) best = o - this.tcnt;
    return best;
  }

  service(cycle: number): void {
    const p = this.prescale();
    if (!p) {
      this.last = cycle;
      return;
    }
    let ticks = Math.floor((cycle - this.last) / p);
    if (ticks <= 0) return;
    const m = this.mode();
    while (ticks > 0) {
      const top = this.top(m);
      const d = this.ticksToEvent(m, top);
      if (d > ticks) {
        this.tcnt += this.dir * ticks;
        this.last += ticks * p;
        return;
      }
      this.last += d * p;
      ticks -= d;
      this.arrive(m, top, d);
    }
  }

  private arrive(m: WaveMode, top: number, d: number): void {
    const core = this.bus.core;
    const tifr = this.cfg.regs.TIFR;
    const at = this.last;
    if (m.kind === "pc") {
      this.tcnt += this.dir * d;
      if (this.dir > 0 && this.tcnt >= top) {
        this.tcnt = top;
        this.dir = -1;
      } else if (this.dir < 0 && this.tcnt <= 0) {
        this.tcnt = 0;
        this.dir = 1;
        core.data[tifr] |= 1 << this.fb.tov;
        core.irqChanged();
      }
      for (let ch = 0; ch < 2; ch++) {
        if (this.tcnt === this.ocr[ch]) this.compare(m, ch, at, this.dir < 0 || this.tcnt === top);
      }
      return;
    }
    const wrapDist = this.tcnt > top ? this.max - this.tcnt + 1 : top - this.tcnt + 1;
    if (d === wrapDist) {
      const wasTop = this.tcnt + d - 1;
      this.tcnt = 0;
      if (m.kind !== "ctc" || wasTop === this.max) {
        core.data[tifr] |= 1 << this.fb.tov;
        core.irqChanged();
      }
      if (m.kind === "fast") this.bottom(at);
    } else this.tcnt += d;
    for (let ch = 0; ch < 2; ch++) if (this.tcnt === this.ocr[ch]) this.compare(m, ch, at, false);
  }

  private com(ch: number): number {
    return (this.tccra >> (ch === 0 ? 6 : 4)) & 3;
  }

  private compare(m: WaveMode, ch: number, cycle: number, downCount: boolean): void {
    const core = this.bus.core;
    core.data[this.cfg.regs.TIFR] |= 1 << (ch === 0 ? this.fb.ocfa : this.fb.ocfb);
    core.irqChanged();
    const com = this.com(ch);
    if (!com) return;
    let next = this.oc[ch];
    if (m.kind === "normal" || m.kind === "ctc") {
      next = com === 1 ? next ^ 1 : com === 2 ? 0 : 1;
    } else if (m.kind === "fast") {
      if (com === 1) { if (ch === 0 && m.top === "ocra") next ^= 1; else return; }
      else next = com === 2 ? 0 : 1;
    } else {
      if (com === 1) { if (ch === 0 && m.top === "ocra") next ^= 1; else return; }
      else next = (com === 2) !== downCount ? 0 : 1;
    }
    this.setOc(ch, next, cycle);
  }

  private bottom(cycle: number): void {
    for (let ch = 0; ch < 2; ch++) {
      const com = this.com(ch);
      if (com === 2) this.setOc(ch, 1, cycle);
      else if (com === 3) this.setOc(ch, 0, cycle);
    }
  }

  private setOc(ch: number, v: number, cycle: number): void {
    this.oc[ch] = v;
    const pin = ch === 0 ? this.cfg.ocPins.a : this.cfg.ocPins.b;
    if (pin) this.bus.override(pin, v ? Drive.SH : Drive.SL, cycle);
  }

  /** Connect/disconnect OC pins when COM bits change. */
  private applyOutputs(cycle: number): void {
    for (let ch = 0; ch < 2; ch++) {
      const pin = ch === 0 ? this.cfg.ocPins.a : this.cfg.ocPins.b;
      if (!pin) continue;
      this.bus.override(pin, this.com(ch) ? (this.oc[ch] ? Drive.SH : Drive.SL) : null, cycle);
    }
  }

  nextEvent(): number {
    const p = this.prescale();
    if (!p) return Infinity;
    const m = this.mode();
    return this.last + this.ticksToEvent(m, this.top(m)) * p;
  }
}

// --- USART ------------------------------------------------------------------

export class AvrUsart implements Peripheral {
  private udre = true;
  private txc = false;
  private rxc = false;
  private rxData = 0;
  private fe = false;
  private u2x = false;
  private txBusyUntil = 0;
  private txActive = false;
  private buffer: number | null = null;
  private txPin?: DPin;

  constructor(private bus: McuBus, private cfg: NonNullable<AvrVariant["usart"]>) {
    const core = bus.core;
    const c = cfg;
    this.txPin = bus.pin(c.txPin);
    core.readHooks[c.UCSRA] = () => {
      this.service(core.cycles);
      return (this.rxc ? 0x80 : 0) | (this.txc ? 0x40 : 0) | (this.udre ? 0x20 : 0) | (this.fe ? 0x10 : 0) | (this.u2x ? 2 : 0);
    };
    core.writeHooks[c.UCSRA] = (v) => {
      if (v & 0x40) this.txc = false;
      this.u2x = !!(v & 2);
      core.irqChanged();
    };
    core.writeHooks[c.UCSRB] = (v, _a, old) => {
      if ((v ^ old) & 0x08) {
        bus.override(c.txPin, v & 0x08 ? "owned" : null, core.cycles);
        if (v & 0x08) this.txPin?.set(bus.time(core.cycles), Drive.SH);
      }
      core.irqChanged();
    };
    core.readHooks[c.UDR] = () => {
      this.rxc = false;
      core.irqChanged();
      return this.rxData;
    };
    core.writeHooks[c.UDR] = (v) => this.write(v);
    const rx = new UartRx(
      (t, fn) => bus.schedule(t, fn),
      () => this.bitCycles() / bus.freq,
      (b, _t, fe) => {
        if (!(core.data[c.UCSRB] & 0x10)) return;
        this.rxData = b;
        this.rxc = true;
        this.fe = fe;
        core.irqChanged();
      },
      () => bus.pin(c.rxPin)?.read() ?? Level.H,
    );
    bus.onPinChange(c.rxPin, (t, l) => rx.onChange(t, l));
    core.addIrq({ vector: c.vectors.rx, pending: () => this.rxc && !!(core.data[c.UCSRB] & 0x80), ack: () => {} });
    core.addIrq({ vector: c.vectors.udre, pending: () => this.udre && !!(core.data[c.UCSRB] & 0x20), ack: () => {} });
    core.addIrq({
      vector: c.vectors.tx,
      pending: () => this.txc && !!(core.data[c.UCSRB] & 0x40),
      ack: () => { this.txc = false; },
    });
  }

  private bitCycles(): number {
    const d = this.bus.core.data;
    const ubrr = ((d[this.cfg.UBRRH] & 0x0f) << 8) | d[this.cfg.UBRRL];
    return (this.u2x ? 8 : 16) * (ubrr + 1);
  }

  private write(v: number): void {
    const core = this.bus.core;
    if (!(core.data[this.cfg.UCSRB] & 0x08)) return;
    this.service(core.cycles);
    if (!this.txActive) this.startFrame(v, core.cycles);
    else {
      this.buffer = v;
      this.udre = false;
    }
    core.irqChanged();
    core.reschedule();
  }

  private startFrame(v: number, cycle: number): void {
    const bc = this.bitCycles();
    if (this.txPin) uartSend(this.txPin, this.bus.time(cycle), v, bc / this.bus.freq);
    this.txActive = true;
    this.txBusyUntil = cycle + 10 * bc;
  }

  service(cycle: number): void {
    while (this.txActive && cycle >= this.txBusyUntil) {
      const end = this.txBusyUntil;
      if (this.buffer !== null) {
        const b = this.buffer;
        this.buffer = null;
        this.udre = true;
        this.startFrame(b, end);
      } else {
        this.txActive = false;
        this.txc = true;
      }
      this.bus.core.irqChanged();
    }
  }

  nextEvent(): number {
    return this.txActive ? this.txBusyUntil : Infinity;
  }
}

// --- ADC --------------------------------------------------------------------

export class AvrAdc implements Peripheral {
  private converting = false;
  private convEnd = 0;
  private first = true;

  constructor(private bus: McuBus, private cfg: NonNullable<AvrVariant["adc"]>) {
    const core = bus.core;
    core.writeHooks[cfg.ADCSRA] = (v, _a, old) => {
      // ADIF is write-one-to-clear; ADSC can only be set by software.
      let nv = (v & ~0x10) | (old & 0x10 & ~v);
      if (!(v & 0x80)) { this.first = true; nv &= ~0x40; }
      core.data[cfg.ADCSRA] = nv;
      if (v & 0x40 && v & 0x80 && !this.converting) this.start(core.cycles);
      core.irqChanged();
    };
    core.readHooks[cfg.ADCSRA] = () => {
      this.service(core.cycles);
      return core.data[cfg.ADCSRA];
    };
    core.addIrq({
      vector: cfg.vector,
      pending: () => (core.data[cfg.ADCSRA] & 0x18) === 0x18,
      ack: () => { core.data[cfg.ADCSRA] &= ~0x10; },
    });
  }

  private start(cycle: number): void {
    const ps = this.bus.core.data[this.cfg.ADCSRA] & 7;
    const div = ps < 2 ? 2 : 1 << ps;
    this.converting = true;
    this.convEnd = cycle + (this.first ? 25 : 13) * div;
    this.first = false;
    this.bus.core.reschedule();
  }

  service(cycle: number): void {
    if (!this.converting || cycle < this.convEnd) return;
    const core = this.bus.core;
    const d = core.data;
    const admux = d[this.cfg.ADMUX];
    const mux = admux & 0x0f;
    let v = 0;
    if (mux < this.cfg.channels.length) v = this.bus.voltage(this.cfg.channels[mux]);
    else if (mux === 14) v = this.cfg.internalRef;
    const refs = admux >> 6;
    const vref = refs === 3 ? this.cfg.internalRef : this.bus.vcc;
    const result = Math.max(0, Math.min(1023, Math.floor((v * 1024) / vref)));
    if (admux & 0x20) {
      d[this.cfg.ADCH] = result >> 2;
      d[this.cfg.ADCL] = (result & 3) << 6;
    } else {
      d[this.cfg.ADCH] = result >> 8;
      d[this.cfg.ADCL] = result & 0xff;
    }
    this.converting = false;
    d[this.cfg.ADCSRA] = (d[this.cfg.ADCSRA] & ~0x40) | 0x10;
    core.irqChanged();
    // Free-running auto trigger.
    if (d[this.cfg.ADCSRA] & 0x20 && (d[this.cfg.ADCSRB] & 7) === 0) {
      d[this.cfg.ADCSRA] |= 0x40;
      this.start(this.convEnd);
    }
  }

  nextEvent(): number {
    return this.converting ? this.convEnd : Infinity;
  }
}

// --- External and pin-change interrupts -------------------------------------

export function attachExtInt(bus: McuBus, cfg: NonNullable<AvrVariant["extInt"]>): void {
  const core = bus.core;
  core.writeHooks[cfg.EIFR] = (v, _a, old) => {
    core.data[cfg.EIFR] = old & ~v;
    core.irqChanged();
  };
  core.writeHooks[cfg.EIMSK] = () => core.irqChanged();
  core.writeHooks[cfg.EICRA] = () => core.irqChanged();
  cfg.pins.forEach((pinName, i) => {
    const sense = () => (core.data[cfg.EICRA] >> (2 * i)) & 3;
    bus.onPinChange(pinName, (_t, l) => {
      const s = sense();
      if (s === 1 || (s === 2 && l === Level.L) || (s === 3 && l === Level.H)) {
        core.data[cfg.EIFR] |= 1 << i;
      }
      core.irqChanged();
    });
    core.addIrq({
      vector: cfg.vectors[i],
      pending: () => {
        if (!(core.data[cfg.EIMSK] & (1 << i))) return false;
        if (sense() === 0) return bus.pin(pinName)?.read() === Level.L;
        return !!(core.data[cfg.EIFR] & (1 << i));
      },
      ack: () => { core.data[cfg.EIFR] &= ~(1 << i); },
    });
  });
}

export function attachPcint(bus: McuBus, cfg: NonNullable<AvrVariant["pcint"]>): void {
  const core = bus.core;
  core.writeHooks[cfg.PCIFR] = (v, _a, old) => {
    core.data[cfg.PCIFR] = old & ~v;
    core.irqChanged();
  };
  core.writeHooks[cfg.PCICR] = () => core.irqChanged();
  cfg.groups.forEach((g, i) => {
    for (let b = 0; b < 8; b++) {
      bus.onPinChange(`P${g.port}${b}`, () => {
        if (core.data[g.mask] & (1 << b)) {
          core.data[cfg.PCIFR] |= 1 << i;
          core.irqChanged();
        }
      });
    }
    core.addIrq({
      vector: g.vector,
      pending: () => !!(core.data[cfg.PCICR] & core.data[cfg.PCIFR] & (1 << i)),
      ack: () => { core.data[cfg.PCIFR] &= ~(1 << i); },
    });
  });
}

export function attachEeprom(bus: McuBus, cfg: NonNullable<AvrVariant["eeprom"]>, size: number): Uint8Array {
  const core = bus.core;
  const mem = new Uint8Array(size).fill(0xff);
  const addr = () => (core.data[cfg.EEARL] | (cfg.EEARH !== undefined ? core.data[cfg.EEARH] << 8 : 0)) % size;
  core.writeHooks[cfg.EECR] = (v) => {
    if (v & 1) core.data[cfg.EEDR] = mem[addr()];
    if (v & 2) mem[addr()] = core.data[cfg.EEDR];
    core.data[cfg.EECR] = v & 0x38; // clear EERE/EEPE/EEMPE: operations complete instantly
  };
  return mem;
}
