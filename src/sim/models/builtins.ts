// Built-in interactive and instrument models (parts implemented natively
// rather than in SPICE): power rails, LEDs, switches,
// pots, logic sources/probes, clock generator, virtual terminal, HD44780 LCD,
// seven-segment display, voltmeter, ammeter and a 4-channel oscilloscope.

import { Diode, Resistor, VoltageSource } from "../analog/elements";
import { DPin, ModelContext, SimModel } from "../engine";
import { Drive, Level } from "../logic";
import { UartRx, uartSend } from "./uart";

export type BuiltinFactory = () => SimModel;

class Ground implements SimModel {
  setup(): void {}
}

class PowerRail implements SimModel {
  setup(ctx: ModelContext): void {
    const node = ctx.node("P");
    const v = ctx.num("VOLTAGE", 5);
    const nets = ctx.sim.railNets;
    const net = ctx.sim.nets.find((n) => n.analogNode === node)!;
    const existing = nets.get(net);
    if (existing !== undefined) {
      if (Math.abs(existing - v) > 1e-9) ctx.warn(`rail ${net.name} already driven at ${existing} V; ${v} V ignored`);
      return;
    }
    nets.set(net, v);
    ctx.addElement(new VoltageSource(node, 0, { kind: "dc", v }));
  }
}

class Led implements SimModel {
  private d!: Diode;
  private ifNom = 0.01;
  private imax = 0.03;
  private ctx!: ModelContext;
  private burnt = false;
  private brightness = 0;
  setup(ctx: ModelContext): void {
    this.ctx = ctx;
    const vf = ctx.num("VF", 2);
    this.ifNom = ctx.num("IF", 0.01);
    this.imax = ctx.num("IMAX", 0.03);
    const n = 2;
    const is = this.ifNom / (Math.exp(vf / (n * 0.025852)) - 1);
    this.d = new Diode(ctx.node("A"), ctx.node("K"), { is, n, bv: 0, ibv: 0 });
    ctx.addElement(this.d);
  }
  afterAnalogStep(): void {
    const i = this.d.current;
    this.brightness = Math.max(0, Math.min(1, i / this.ifNom));
    if (i > this.imax && !this.burnt) {
      this.burnt = true;
      this.ctx.warn(`LED current ${(i * 1000).toFixed(1)} mA exceeds IMAX ${(this.imax * 1000).toFixed(0)} mA`);
    }
  }
  indicate(): unknown {
    return { brightness: this.brightness, current: this.d.current, overloaded: this.burnt };
  }
}

class Switch implements SimModel {
  private r!: Resistor;
  private closed = false;
  constructor(private momentary: boolean) {}
  setup(ctx: ModelContext): void {
    this.closed = !this.momentary && ctx.prop("STATE") === "closed";
    this.r = new Resistor(ctx.node("A"), ctx.node("B"), this.closed ? 0.01 : 1e9);
    ctx.addElement(this.r);
  }
  actuate(a: Record<string, unknown>): void {
    if (this.momentary) this.closed = !!a.pressed;
    else this.closed = !this.closed;
    this.r.r = this.closed ? 0.01 : 1e9;
  }
  indicate(): unknown {
    return { closed: this.closed };
  }
}

class Pot implements SimModel {
  private r1!: Resistor;
  private r2!: Resistor;
  private total = 10e3;
  private pos = 0.5;
  setup(ctx: ModelContext): void {
    this.total = ctx.num("R", 10e3);
    this.pos = Math.min(1, Math.max(0, ctx.num("POSITION", 0.5)));
    const w = ctx.node("W");
    this.r1 = new Resistor(ctx.node("A"), w, 1);
    this.r2 = new Resistor(w, ctx.node("B"), 1);
    this.apply();
    ctx.addElement(this.r1);
    ctx.addElement(this.r2);
  }
  private apply(): void {
    this.r1.r = Math.max(this.total * this.pos, 0.1);
    this.r2.r = Math.max(this.total * (1 - this.pos), 0.1);
  }
  actuate(a: Record<string, unknown>): void {
    if (typeof a.position === "number") this.pos = Math.min(1, Math.max(0, a.position));
    this.apply();
  }
  indicate(): unknown {
    return { position: this.pos };
  }
}

class LogicState implements SimModel {
  private pin!: DPin;
  private level = 0;
  private ctx!: ModelContext;
  setup(ctx: ModelContext): void {
    this.ctx = ctx;
    this.level = ctx.num("STATE", 0) ? 1 : 0;
    this.pin = ctx.pin("Q");
  }
  start(): void {
    this.pin.set(0, this.level ? Drive.SH : Drive.SL);
  }
  actuate(): void {
    this.level ^= 1;
    this.pin.set(this.ctx.now(), this.level ? Drive.SH : Drive.SL);
  }
  indicate(): unknown {
    return { level: this.level };
  }
}

class LogicProbe implements SimModel {
  private pin!: DPin;
  setup(ctx: ModelContext): void {
    this.pin = ctx.pin("D");
  }
  indicate(): unknown {
    return { level: this.pin.read() };
  }
}

class Clock implements SimModel {
  private pin!: DPin;
  private half = 0.5e-3;
  private ctx!: ModelContext;
  setup(ctx: ModelContext): void {
    this.ctx = ctx;
    this.half = 0.5 / ctx.num("FREQ", 1000);
    this.pin = ctx.pin("Q");
  }
  start(): void {
    this.tick(0, 0);
  }
  private tick(t: number, level: number): void {
    this.pin.set(t, level ? Drive.SH : Drive.SL);
    this.ctx.schedule(t + this.half, () => this.tick(t + this.half, level ^ 1));
  }
}

/** Virtual terminal: decodes RXD, transmits typed characters on TXD. */
class VirtualTerminal implements SimModel {
  private text = "";
  private tx!: DPin;
  private rx!: DPin;
  private ctx!: ModelContext;
  private bitTime = 1 / 9600;
  private txFree = 0;
  private errors = 0;
  setup(ctx: ModelContext): void {
    this.ctx = ctx;
    this.bitTime = 1 / ctx.num("BAUD", 9600);
    const uart = new UartRx(
      (t, fn) => ctx.schedule(t, fn),
      () => this.bitTime,
      (b, _t, fe) => {
        if (fe) this.errors++;
        this.receive(b);
      },
      () => this.rx.read(),
    );
    this.rx = ctx.pin("RXD", { onChange: (t, l) => uart.onChange(t, l) });
    this.tx = ctx.pin("TXD");
  }
  start(): void {
    this.tx.set(0, Drive.SH);
  }
  private receive(b: number): void {
    if (b === 13) return; // CRLF line endings render as one newline
    if (b === 8) this.text = this.text.slice(0, -1);
    else this.text += String.fromCharCode(b);
    if (this.text.length > 20000) this.text = this.text.slice(-16000);
  }
  actuate(a: Record<string, unknown>): void {
    if (a.clear) {
      this.text = "";
      return;
    }
    const s = String(a.send ?? "");
    let t = Math.max(this.ctx.now(), this.txFree);
    for (const ch of s) t = uartSend(this.tx, t, ch.charCodeAt(0) & 0xff, this.bitTime);
    this.txFree = t;
  }
  indicate(): unknown {
    return { text: this.text, framingErrors: this.errors };
  }
}

/** HD44780-compatible character LCD (16x2 / 20x4), 4- or 8-bit bus. */
class Hd44780 implements SimModel {
  private rs!: DPin;
  private rw!: DPin;
  private e!: DPin;
  private d: DPin[] = [];
  private ddram = new Uint8Array(128).fill(0x20);
  private cgram = new Uint8Array(64);
  private ac = 0;
  private cgMode = false;
  private eightBit = true;
  private nibble: number | null = null;
  private displayOn = false;
  private cursorOn = false;
  private blinkOn = false;
  private inc = true;
  private shiftOnWrite = false;
  private shift = 0;
  private rows = 2;
  private cols = 16;
  private ctx!: ModelContext;
  private readNibbleHigh = true;

  setup(ctx: ModelContext): void {
    this.ctx = ctx;
    this.rows = ctx.num("ROWS", 2);
    this.cols = ctx.num("COLS", 16);
    this.rs = ctx.pin("RS");
    this.rw = ctx.pin("RW");
    this.e = ctx.pin("E", { onChange: (t, l) => this.onE(t, l) });
    for (let i = 0; i < 8; i++) this.d.push(ctx.pin(`D${i}`));
  }

  private bus(): number {
    let v = 0;
    for (let i = 0; i < 8; i++) if (this.d[i].read() === Level.H) v |= 1 << i;
    return v;
  }

  private onE(t: number, l: Level): void {
    const reading = this.rw.read() === Level.H;
    if (l === Level.H && reading) {
      this.driveRead(t);
      return;
    }
    if (l === Level.L) {
      if (reading) {
        for (const p of this.d) p.set(t + 10e-9, Drive.Z);
        return;
      }
      const v = this.bus();
      if (this.eightBit) this.write(v);
      else {
        const nib = (v >> 4) & 0xf;
        if (this.nibble === null) this.nibble = nib;
        else {
          const full = (this.nibble << 4) | nib;
          this.nibble = null;
          this.write(full);
        }
      }
    }
  }

  private driveRead(t: number): void {
    const rs = this.rs.read() === Level.H;
    let v = rs ? this.readData() : this.ac & 0x7f; // busy flag always clear
    if (!this.eightBit) {
      v = this.readNibbleHigh ? v & 0xf0 : (v << 4) & 0xf0;
      this.readNibbleHigh = !this.readNibbleHigh;
    }
    const first = this.eightBit ? 0 : 4;
    for (let i = first; i < 8; i++) this.d[i].set(t + 100e-9, (v >> i) & 1 ? Drive.SH : Drive.SL);
  }

  private readData(): number {
    const v = this.cgMode ? this.cgram[this.ac & 0x3f] : this.ddram[this.ac & 0x7f];
    this.bumpAddress();
    return v;
  }

  private rs_high(): boolean {
    return this.rs.read() === Level.H;
  }

  private bumpAddress(): void {
    if (this.cgMode) this.ac = (this.ac + (this.inc ? 1 : -1)) & 0x3f;
    else this.ac = (this.ac + (this.inc ? 1 : -1)) & 0x7f;
  }

  private write(v: number): void {
    if (this.rs_high()) {
      if (this.cgMode) this.cgram[this.ac & 0x3f] = v & 0x1f;
      else this.ddram[this.ac & 0x7f] = v;
      this.bumpAddress();
      if (this.shiftOnWrite && !this.cgMode) this.shift += this.inc ? 1 : -1;
      return;
    }
    if (v & 0x80) { this.cgMode = false; this.ac = v & 0x7f; }
    else if (v & 0x40) { this.cgMode = true; this.ac = v & 0x3f; }
    else if (v & 0x20) {
      this.eightBit = !!(v & 0x10);
      this.nibble = null;
      this.readNibbleHigh = true;
    } else if (v & 0x10) {
      const dir = v & 0x04 ? 1 : -1;
      if (v & 0x08) this.shift -= dir;
      else this.ac = (this.ac + dir) & 0x7f;
    } else if (v & 0x08) {
      this.displayOn = !!(v & 4);
      this.cursorOn = !!(v & 2);
      this.blinkOn = !!(v & 1);
    } else if (v & 0x04) {
      this.inc = !!(v & 2);
      this.shiftOnWrite = !!(v & 1);
    } else if (v & 0x02) {
      this.ac = 0;
      this.shift = 0;
      this.cgMode = false;
    } else if (v & 0x01) {
      this.ddram.fill(0x20);
      this.ac = 0;
      this.shift = 0;
      this.inc = true;
      this.cgMode = false;
    }
  }

  indicate(): unknown {
    const offsets = [0x00, 0x40, this.cols, 0x40 + this.cols];
    const lines: number[][] = [];
    for (let r = 0; r < this.rows; r++) {
      const row: number[] = [];
      for (let c = 0; c < this.cols; c++) {
        const lineLen = 40;
        const base = offsets[r] & 0x40;
        const col = ((((offsets[r] & 0x3f) + c + this.shift) % lineLen) + lineLen) % lineLen;
        row.push(this.ddram[base + col]);
      }
      lines.push(row);
    }
    let cursor: { row: number; col: number } | null = null;
    if (this.cursorOn || this.blinkOn) {
      for (let r = 0; r < this.rows; r++) {
        const start = offsets[r];
        const c = this.ac - start - this.shift;
        if ((this.ac & 0x40) === (start & 0x40) && c >= 0 && c < this.cols) cursor = { row: r, col: c };
      }
    }
    return { on: this.displayOn, lines, cursor, cgram: Array.from(this.cgram) };
  }
}

class SevenSeg implements SimModel {
  private segs: DPin[] = [];
  private com!: DPin;
  private anode = false;
  setup(ctx: ModelContext): void {
    this.anode = ctx.prop("TYPE") === "common-anode";
    for (const s of ["A", "B", "C", "D", "E", "F", "G", "DP"]) this.segs.push(ctx.pin(s));
    this.com = ctx.pin("COM");
  }
  indicate(): unknown {
    const comHigh = this.com.read() === Level.H;
    let mask = 0;
    this.segs.forEach((p, i) => {
      const h = p.read() === Level.H;
      const on = this.anode ? comHigh && !h : !comHigh && h;
      if (on) mask |= 1 << i;
    });
    return { segments: mask };
  }
}

class Voltmeter implements SimModel {
  private p = 0;
  private n = 0;
  private ctx!: ModelContext;
  setup(ctx: ModelContext): void {
    this.ctx = ctx;
    this.p = ctx.node("P");
    this.n = ctx.node("N");
    ctx.addElement(new Resistor(this.p, this.n, 10e6));
  }
  indicate(): unknown {
    return { value: this.ctx.v(this.p) - this.ctx.v(this.n), unit: "V" };
  }
}

class Ammeter implements SimModel {
  private src!: VoltageSource;
  private ctx!: ModelContext;
  setup(ctx: ModelContext): void {
    this.ctx = ctx;
    this.src = new VoltageSource(ctx.node("P"), ctx.node("N"), { kind: "dc", v: 0 });
    ctx.addElement(this.src);
  }
  indicate(): unknown {
    const a = this.ctx.sim.analog;
    const row = a.nodeCount - 1 + (this.src.branch ?? 0);
    return { value: a.x[row] ?? 0, unit: "A" };
  }
}

/** 4-channel oscilloscope: samples node voltages into a rolling buffer. */
class Scope implements SimModel {
  private nodes: number[] = [];
  private ctx!: ModelContext;
  private samples: number[][] = [];
  private window = 0.02;
  private lastT = -1;
  setup(ctx: ModelContext): void {
    this.ctx = ctx;
    this.window = ctx.num("TIMEBASE", 0.02);
    for (const ch of ["A", "B", "C", "D"]) this.nodes.push(ctx.isConnected(ch) ? ctx.node(ch) : -1);
  }
  afterAnalogStep(t: number): void {
    if (t - this.lastT < this.window / 2000) return;
    this.lastT = t;
    this.samples.push([t, ...this.nodes.map((n) => (n < 0 ? NaN : this.ctx.v(n)))]);
    const cutoff = t - this.window;
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop][0] < cutoff) drop++;
    if (drop > 256) this.samples.splice(0, drop);
  }
  indicate(): unknown {
    const cutoff = this.lastT - this.window;
    return { window: this.window, samples: this.samples.filter((s) => s[0] >= cutoff) };
  }
}

export const BUILTINS: Record<string, BuiltinFactory> = {
  ground: () => new Ground(),
  power: () => new PowerRail(),
  led: () => new Led(),
  button: () => new Switch(true),
  switch: () => new Switch(false),
  pot: () => new Pot(),
  logicstate: () => new LogicState(),
  logicprobe: () => new LogicProbe(),
  clock: () => new Clock(),
  vterm: () => new VirtualTerminal(),
  hd44780: () => new Hd44780(),
  sevenseg: () => new SevenSeg(),
  voltmeter: () => new Voltmeter(),
  ammeter: () => new Ammeter(),
  scope: () => new Scope(),
};
