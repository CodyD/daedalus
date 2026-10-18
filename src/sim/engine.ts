// Mixed-mode co-simulation kernel.
//
// Three engines share one timeline (a SPICE
// analogue kernel plus an event-driven digital simulator, with CPU models
// executing firmware against both):
//
//   * Digital nets that touch only digital pins are purely event driven.
//   * Any net touching an analog element becomes an MNA node. Digital outputs
//     on it are Norton drivers (VOH/VOL behind Rout); digital inputs on it see
//     the node voltage through VIL/VIH thresholds with hysteresis.
//   * CPU models run ahead to the end of each slice, emitting time-stamped pin
//     events, then the digital queue drains, then the analog matrix is solved.
//
// The slice length is adaptive: it collapses to dtMin whenever a digital edge
// lands on an analog net and grows while node voltages are quiet.

import type { ComponentDef, Netlist, NetlistInstance, PinDef } from "../shared/component";
import { AnalogElement, AnalogSolver, nodeV } from "./analog/mna";
import { DigitalDriver } from "./analog/elements";
import { EventQueue } from "./events";
import { Drive, Level, driveLevel, resolve, strength } from "./logic";
import { parseValue } from "./units";

// --- Model API (compare: VSM's IDSIMMODEL / ISPICEMODEL / IACTIVEMODEL) -----

export interface SimModel {
  /** Acquire pins and stamp analog elements. */
  setup(ctx: ModelContext): void;
  /** Called after setup, once the DC operating point is known. */
  start?(): void;
  /** CPU models: execute until absolute time t. */
  advance?(t: number): void;
  /** Sample analog state after each solved time point. */
  afterAnalogStep?(t: number): void;
  /** UI state for this part (LED brightness, LCD text, CPU registers...). */
  indicate?(): unknown;
  /** UI input (button press, key typed into a terminal, pot moved...). */
  actuate?(action: Record<string, unknown>): void;
}

export interface PinOptions {
  /** Called whenever the level seen by this pin changes. */
  onChange?: (time: number, level: Level) => void;
}

export interface ModelContext {
  readonly ref: string;
  readonly def: ComponentDef;
  readonly sim: Simulator;
  prop(key: string): string;
  num(key: string, fallback?: number): number;
  file(key: string): string | undefined;
  node(pinId: string): number;
  internalNode(name: string): number;
  pin(pinId: string, opts?: PinOptions): DPin;
  hasPin(pinId: string): boolean;
  isConnected(pinId: string): boolean;
  addElement(el: AnalogElement): void;
  schedule(time: number, fn: () => void): void;
  now(): number;
  v(node: number): number;
  log(msg: string): void;
  warn(msg: string): void;
}

export type ModelFactory = (inst: NetlistInstance) => SimModel;

// --- Nets and pins ----------------------------------------------------------

export class Net {
  analogNode = -1;
  pins: DPin[] = [];
  level: Level = Level.Z;
  constructor(readonly name: string, readonly ground: boolean) {
    if (ground) this.analogNode = 0;
  }
  get isAnalog(): boolean {
    return this.analogNode >= 0;
  }
}

export interface PinElectrical {
  vil: number;
  vih: number;
  voh: number;
  vol: number;
  rout: number;
  rpull: number;
}

export class DPin {
  drive: Drive = Drive.Z;
  /** Level this pin currently reads. */
  level: Level = Level.Z;
  driver?: DigitalDriver;
  private scheduled: Drive = Drive.Z;
  listeners: ((time: number, level: Level) => void)[] = [];
  /** Highest current magnitude seen while driving (A), for stress checks. */
  peakCurrent = 0;

  constructor(
    readonly sim: Simulator,
    readonly owner: string,
    readonly id: string,
    readonly net: Net,
    readonly elec: PinElectrical,
  ) {}

  /** Schedule a new drive state at absolute time t. */
  set(t: number, d: Drive): void {
    if (d === this.scheduled) return;
    this.scheduled = d;
    this.sim.schedule(t, () => this.apply(d, t));
  }

  /** Apply immediately (used by models already running inside an event). */
  apply(d: Drive, t: number): void {
    this.scheduled = d;
    if (d === this.drive) return;
    this.drive = d;
    this.sim.onDriveChange(this, t);
  }

  read(): Level {
    return this.level;
  }

  isHigh(): boolean {
    return this.level === Level.H;
  }

  /** Voltage at the pin: the node voltage on analog nets, else the logic level. */
  voltage(): number {
    if (this.net.isAnalog) return this.sim.nodeVoltage(this.net.analogNode);
    return this.level === Level.H ? this.elec.voh : 0;
  }

  updateDriver(): void {
    if (!this.driver) return;
    const s = strength(this.drive);
    if (s === 0) this.driver.set(0, 0);
    else {
      const high = driveLevel(this.drive) === Level.H;
      this.driver.set(high ? this.elec.voh : this.elec.vol, s === 2 ? this.elec.rout : this.elec.rpull);
    }
  }

  setLevel(t: number, l: Level): void {
    if (l === this.level) return;
    this.level = l;
    for (const fn of this.listeners) fn(t, l);
  }
}

// --- Simulator --------------------------------------------------------------

export interface SimOptions {
  dtMin?: number;
  dtMax?: number;
  /** Max slice while a CPU model is present (bounds input latency). */
  cpuSlice?: number;
}

export interface LogEntry {
  time: number;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
}

interface Instance {
  inst: NetlistInstance;
  model: SimModel;
}

export class Simulator {
  time = 0;
  readonly queue = new EventQueue();
  readonly analog = new AnalogSolver();
  readonly nets: Net[] = [];
  readonly instances: Instance[] = [];
  readonly logs: LogEntry[] = [];
  readonly railNets = new Map<Net, number>();
  private pinNet = new Map<string, Net>();
  private cpus: SimModel[] = [];
  private samplers: SimModel[] = [];
  private mixedPins: DPin[] = [];
  private nodeCount = 1;
  private analogDirty = true;
  private dt: number;
  private readonly opts: Required<SimOptions>;
  private quietSteps = 0;
  private lastX = new Float64Array(0);
  private stressWarned = new Set<DPin>();
  stats = { analogSteps: 0, newtonIterations: 0, events: 0, skippedSteps: 0 };
  failed: string | null = null;

  constructor(readonly netlist: Netlist, factory: ModelFactory, opts: SimOptions = {}) {
    this.opts = { dtMin: 1e-6, dtMax: 1e-3, cpuSlice: 1e-4, ...opts };
    this.dt = this.opts.dtMin;
    for (const n of netlist.nets) {
      const net = new Net(n.name, n.ground);
      this.nets.push(net);
      for (const p of n.pins) this.pinNet.set(`${p.ref}.${p.pin}`, net);
    }
    for (const inst of netlist.instances) {
      let model: SimModel;
      try {
        model = factory(inst);
      } catch (e) {
        this.log("error", inst.ref, (e as Error).message);
        continue;
      }
      this.instances.push({ inst, model });
    }
    for (const { inst, model } of this.instances) {
      try {
        model.setup(this.makeContext(inst));
      } catch (e) {
        this.log("error", inst.ref, `setup failed: ${(e as Error).message}`);
      }
      if (model.advance) this.cpus.push(model);
      if (model.afterAnalogStep) this.samplers.push(model);
    }
    this.attachMixedPins();
    this.analog.finalize(this.nodeCount);
    this.lastX = new Float64Array(this.analog.size);
    this.operatingPoint();
    for (const { model } of this.instances) model.start?.();
    this.processDigital(0);
  }

  log(level: LogEntry["level"], source: string, message: string): void {
    this.logs.push({ time: this.time, level, source, message });
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
  }

  schedule(t: number, fn: () => void): void {
    this.queue.push(Math.max(t, this.time), fn);
  }

  nodeVoltage(node: number): number {
    return node <= 0 ? 0 : nodeV(this.analog.x, node);
  }

  /** Mark the analog side as needing a fresh solve at fine timestep. */
  kick(): void {
    this.analogDirty = true;
  }

  private netFor(ref: string, pin: string): Net {
    const key = `${ref}.${pin}`;
    let net = this.pinNet.get(key);
    if (!net) {
      net = new Net(`${key}(nc)`, false);
      this.nets.push(net);
      this.pinNet.set(key, net);
    }
    return net;
  }

  private allocNode(net: Net): number {
    if (net.analogNode < 0) net.analogNode = this.nodeCount++;
    return net.analogNode;
  }

  private makeContext(inst: NetlistInstance): ModelContext {
    const sim = this;
    const def = inst.def;
    const internal = new Map<string, number>();
    const pins = new Map<string, DPin>();
    const pinDef = (id: string): PinDef | undefined => def.pins.find((p) => p.id === id);
    const prop = (key: string): string => {
      if (key in inst.props) return inst.props[key];
      const d = def.properties.find((p) => p.key === key);
      return d ? d.default : "";
    };
    const vcc = parseValue(prop("VCC") || "5") || 5;
    const e = def.electrical ?? {};
    const elec: PinElectrical = {
      vil: e.vil ?? 0.3 * vcc,
      vih: e.vih ?? 0.6 * vcc,
      voh: e.voh ?? vcc,
      vol: e.vol ?? 0,
      rout: e.outputResistance ?? 25,
      rpull: 35e3,
    };
    return {
      ref: inst.ref,
      def,
      sim,
      prop,
      num(key, fallback = 0) {
        const v = parseValue(prop(key));
        return isFinite(v) ? v : fallback;
      },
      file: (key) => inst.files?.[key],
      node(pinId) {
        if (!pinDef(pinId)) throw new Error(`no pin '${pinId}'`);
        return sim.allocNode(sim.netFor(inst.ref, pinId));
      },
      internalNode(name) {
        let n = internal.get(name);
        if (n === undefined) {
          n = sim.nodeCount++;
          internal.set(name, n);
        }
        return n;
      },
      pin(pinId, opts) {
        if (!pinDef(pinId)) throw new Error(`no pin '${pinId}'`);
        let p = pins.get(pinId);
        if (!p) {
          const net = sim.netFor(inst.ref, pinId);
          p = new DPin(sim, inst.ref, pinId, net, elec);
          net.pins.push(p);
          pins.set(pinId, p);
        }
        if (opts?.onChange) p.listeners.push(opts.onChange);
        return p;
      },
      hasPin: (id) => !!pinDef(id),
      isConnected: (id) => sim.pinNet.has(`${inst.ref}.${id}`) &&
        !sim.pinNet.get(`${inst.ref}.${id}`)!.name.endsWith("(nc)"),
      addElement: (el) => sim.analog.add(el),
      schedule: (t, fn) => sim.schedule(t, fn),
      now: () => sim.time,
      v: (n) => sim.nodeVoltage(n),
      log: (msg) => sim.log("info", inst.ref, msg),
      warn: (msg) => sim.log("warn", inst.ref, msg),
    };
  }

  /** Digital pins on analog nets get a Norton driver and threshold reader. */
  private attachMixedPins(): void {
    for (const net of this.nets) {
      if (!net.isAnalog) continue;
      for (const p of net.pins) {
        p.driver = new DigitalDriver(net.analogNode);
        this.analog.add(p.driver);
        this.mixedPins.push(p);
      }
    }
  }

  private operatingPoint(): void {
    for (const p of this.mixedPins) p.updateDriver();
    if (this.analog.isEmpty) return;
    const r = this.analog.solve(0, 0, "dc");
    if (!r.ok) {
      this.log("warn", "SPICE", `DC operating point failed (${r.error}); starting transient from zero`);
    }
    this.lastX.set(this.analog.x);
    for (const p of this.mixedPins) {
      const v = this.nodeVoltage(p.net.analogNode);
      p.setLevel(0, v >= (p.elec.vil + p.elec.vih) / 2 ? Level.H : Level.L);
    }
    for (const s of this.samplers) s.afterAnalogStep!(0);
  }

  /** A pin's drive changed: update the net (digital) or the Norton source (analog). */
  onDriveChange(pin: DPin, t: number): void {
    const net = pin.net;
    if (net.isAnalog) {
      pin.updateDriver();
      this.analogDirty = true;
      return;
    }
    const l = resolve(net.pins.map((p) => p.drive));
    if (l === net.level) return;
    net.level = l;
    for (const p of net.pins) p.setLevel(t, l);
  }

  private processDigital(tEnd: number): void {
    while (this.queue.peekTime() <= tEnd) {
      const ev = this.queue.pop()!;
      this.time = ev.time;
      this.stats.events++;
      ev.run();
    }
    this.time = tEnd;
  }

  private sampleThresholds(t: number): void {
    for (const p of this.mixedPins) {
      const v = this.nodeVoltage(p.net.analogNode);
      if (p.level !== Level.H && v >= p.elec.vih) p.setLevel(t, Level.H);
      else if (p.level !== Level.L && v <= p.elec.vil) p.setLevel(t, Level.L);
      if (p.driver && p.driver.g > 0) {
        const i = Math.abs((p.driver.v - v) * p.driver.g);
        if (i > p.peakCurrent) p.peakCurrent = i;
        if (i > 0.04 && !this.stressWarned.has(p)) {
          this.stressWarned.add(p);
          this.log("warn", p.owner, `pin ${p.id} sourcing/sinking ${(i * 1000).toFixed(0)} mA (exceeds 40 mA)`);
        }
      }
    }
  }

  private analogStep(t0: number, t1: number): boolean {
    let t = t0;
    let h = t1 - t0;
    while (t < t1 - 1e-15) {
      h = Math.min(h, t1 - t);
      const r = this.analog.solve(t + h, h, "tran");
      this.stats.newtonIterations += r.iterations;
      if (r.ok) {
        t += h;
        this.stats.analogSteps++;
        continue;
      }
      h /= 8;
      if (h < 1e-13) {
        this.failed = `Timestep too small at t=${t.toExponential(4)}s: ${r.error}`;
        this.log("error", "SPICE", this.failed);
        return false;
      }
    }
    return true;
  }

  /** Advance the whole system to absolute time tEnd. */
  runUntil(tEnd: number): void {
    if (this.failed) return;
    const hasAnalog = !this.analog.isEmpty;
    const timeVarying = hasAnalog && this.analog.hasTimeVarying();
    const dtMax = this.cpus.length ? Math.min(this.opts.dtMax, this.opts.cpuSlice) : this.opts.dtMax;
    if (!hasAnalog && !this.cpus.length) {
      this.processDigital(tEnd);
      return;
    }
    while (this.time < tEnd - 1e-15) {
      const t0 = this.time;
      // A digital edge or UI action on the analog side restarts at the finest step.
      let dt = this.analogDirty ? this.opts.dtMin : Math.min(this.dt, dtMax);
      if (hasAnalog) dt = Math.min(dt, this.analog.maxStep(t0));
      const t1 = Math.min(t0 + dt, tEnd);
      for (const c of this.cpus) c.advance!(t1);
      this.processDigital(t1);
      if (!hasAnalog) continue;

      const quiet = !this.analogDirty && !timeVarying && this.quietSteps > 3;
      if (quiet) {
        // Nothing moved: keep the solution, but let instruments log the time point.
        this.stats.skippedSteps++;
        this.dt = Math.min(this.dt * 2, dtMax);
        for (const sm of this.samplers) sm.afterAnalogStep!(t1);
        this.processDigital(t1);
        continue;
      }
      const forcedFine = this.analogDirty;
      this.analogDirty = false;
      if (!this.analogStep(t0, t1)) return;
      // Step-size control from the largest node voltage change.
      const x = this.analog.x;
      let maxDv = 0;
      for (let i = 0; i < this.nodeCount - 1; i++) maxDv = Math.max(maxDv, Math.abs(x[i] - this.lastX[i]));
      this.lastX.set(x);
      if (forcedFine) this.dt = this.opts.dtMin;
      else if (maxDv > 0.2) this.dt = Math.max(this.opts.dtMin, this.dt / 2);
      else if (maxDv < 0.05) this.dt = Math.min(this.dt * 2, dtMax);
      this.quietSteps = maxDv < 1e-6 ? this.quietSteps + 1 : 0;

      this.sampleThresholds(t1);
      for (const s of this.samplers) s.afterAnalogStep!(t1);
      this.processDigital(t1);
    }
  }

  actuate(ref: string, action: Record<string, unknown>): void {
    const i = this.instances.find((x) => x.inst.ref === ref);
    i?.model.actuate?.(action);
    this.analogDirty = true;
    this.quietSteps = 0;
  }

  /** Voltage (analog nets) or level (digital nets) for every named net. */
  netStates(): Record<string, { v?: number; level?: Level }> {
    const out: Record<string, { v?: number; level?: Level }> = {};
    for (const n of this.nets) {
      if (n.name.endsWith("(nc)")) continue;
      out[n.name] = n.isAnalog ? { v: this.nodeVoltage(n.analogNode) } : { level: n.level };
    }
    return out;
  }

  indicateAll(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const { inst, model } of this.instances) {
      if (model.indicate) out[inst.ref] = model.indicate();
    }
    return out;
  }
}
