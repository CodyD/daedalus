import { describe, expect, it } from "vitest";
import { parseProgram } from "../src/sim/behavior/dsl";
import { Level } from "../src/sim/logic";
import { Circuit, volts } from "./helpers";

const lv = (sim: ReturnType<Circuit["sim"]>, net: string) => sim.netStates()[net]?.level;

describe("behaviour DSL", () => {
  it("parses ranges, ternaries and handlers", () => {
    const p = parseProgram(`state n = 0x0F
on rising(CLK) { n = (n + 1) % 10 }
always { bus(Q0..Q3) = OE ? Z : n; CO = n < 5 }`);
    expect(p.states[0].name).toBe("n");
    expect(p.handlers[0]).toMatchObject({ kind: "rising", pin: "CLK" });
    expect(p.usesAnalog).toBe(false);
  });

  it("reports syntax errors with a position", () => {
    expect(() => parseProgram("always { Y = A && }")).toThrow(/line 1/);
  });
});

describe("event-driven digital", () => {
  it("evaluates a NAND gate from logic-state sources", () => {
    const sim = new Circuit()
      .add("LA", "LOGICSTATE").add("LB", "LOGICSTATE").add("U1", "74HC00")
      .net("A", "LA.Q", "U1.A1").net("B", "LB.Q", "U1.B1").net("Y", "U1.Y1")
      .sim();
    sim.runUntil(1e-6);
    expect(lv(sim, "Y")).toBe(Level.H);
    sim.actuate("LA", {});
    sim.actuate("LB", {});
    sim.runUntil(2e-6);
    expect(lv(sim, "Y")).toBe(Level.L);
  });

  it("shifts and latches a byte through a 74HC595", () => {
    const c = new Circuit()
      .add("DS", "LOGICSTATE").add("SH", "LOGICSTATE").add("ST", "LOGICSTATE").add("U1", "74HC595")
      .add("OE", "LOGICSTATE").add("MR", "LOGICSTATE", { STATE: "1" })
      .net("DS", "DS.Q", "U1.DS").net("SH", "SH.Q", "U1.SHCP").net("ST", "ST.Q", "U1.STCP")
      .net("OE", "OE.Q", "U1.OE").net("MR", "MR.Q", "U1.MR");
    for (let i = 0; i < 8; i++) c.net(`Q${i}`, `U1.Q${i}`);
    const sim = c.sim();
    let t = 0;
    const step = () => sim.runUntil((t += 1e-6));
    step();
    // shift in 1,0,1,1,0,0,0,0 (first bit ends up in Q7)
    for (const bit of [1, 0, 1, 1, 0, 0, 0, 0]) {
      const ds = (sim.indicateAll().DS as { level: number }).level;
      if (ds !== bit) sim.actuate("DS", {});
      step();
      sim.actuate("SH", {});
      step();
      sim.actuate("SH", {});
      step();
    }
    sim.actuate("ST", {});
    step();
    const q = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (lv(sim, `Q${i}`) === Level.H ? 1 : 0));
    expect(q).toEqual([0, 0, 0, 0, 1, 1, 0, 1]);
  });

  it("counts clock edges with a CD4017", () => {
    const c = new Circuit().add("CK", "DCLOCK", { FREQ: "1k" }).add("U1", "CD4017")
      .add("RST", "LOGICSTATE").add("INH", "LOGICSTATE")
      .net("CK", "CK.Q", "U1.CLK").net("RST", "RST.Q", "U1.RST").net("INH", "INH.Q", "U1.CLKINH");
    for (let i = 0; i < 10; i++) c.net(`Q${i}`, `U1.Q${i}`);
    const sim = c.sim();
    sim.runUntil(3.6e-3); // rising edges at 0.5, 1.5, 2.5, 3.5 ms
    expect(lv(sim, "Q4")).toBe(Level.H);
    expect(lv(sim, "Q3")).toBe(Level.L);
  });

  it("toggles a 74HC74 wired as a divide-by-two", () => {
    const sim = new Circuit().add("CK", "DCLOCK", { FREQ: "10k" }).add("U1", "74HC74")
      .net("CK", "CK.Q", "U1.CLK1").net("FB", "U1.QN1", "U1.D1").net("Q", "U1.Q1")
      .sim();
    const seen: Level[] = [];
    for (let i = 1; i <= 8; i++) {
      sim.runUntil(i * 50e-6 + 25e-6);
      seen.push(lv(sim, "Q")!);
    }
    // Q changes once per clock period (every second 50 µs half-period)
    expect(seen).toEqual([Level.H, Level.H, Level.L, Level.L, Level.H, Level.H, Level.L, Level.L]);
  });
});

describe("mixed-mode", () => {
  it("runs a 555 astable at the textbook frequency", () => {
    // f = 1.44 / ((R1 + 2 R2) C) = 1.44 / (3k * 1u) ≈ 480 Hz
    const sim = new Circuit()
      .add("P", "POWER").add("U1", "NE555").add("R1", "RES", { R: "1k" }).add("R2", "RES", { R: "1k" })
      .add("C1", "CAP", { C: "1u" }).add("C2", "CAP", { C: "10n" }).add("RL", "RES", { R: "10k" })
      .net("VCC", "P.P", "U1.VCC", "U1.RESET", "R1.A").net("DIS", "R1.B", "R2.A", "U1.DIS")
      .net("TH", "R2.B", "U1.THR", "U1.TRIG", "C1.A").net("CV", "U1.CTRL", "C2.A")
      .net("OUT", "U1.OUT", "RL.A").net("GND", "U1.GND", "C1.B", "C2.B", "RL.B")
      .sim({ dtMin: 1e-6, dtMax: 2e-5 });
    sim.runUntil(10e-3); // settle past the first (longer) cycle
    let rises = 0;
    let last = volts(sim, "OUT") > 2.5;
    const t0 = 10e-3;
    for (let t = t0; t < t0 + 20e-3; t += 5e-6) {
      sim.runUntil(t);
      const now = volts(sim, "OUT") > 2.5;
      if (now && !last) rises++;
      last = now;
    }
    const f = rises / 20e-3;
    expect(f).toBeGreaterThan(400);
    expect(f).toBeLessThan(560);
  });

  it("reads analog voltages through digital thresholds", () => {
    const sim = new Circuit()
      .add("P", "POWER").add("RV", "POT", { POSITION: "0.9" }).add("U1", "74HC04")
      .net("VCC", "P.P", "RV.A").net("GND", "RV.B").net("W", "RV.W", "U1.A1").net("Y", "U1.Y1")
      .sim();
    sim.runUntil(1e-4);
    // position 0.9 = wiper near B (ground side): 0.5 V -> input low -> output high
    expect(lv(sim, "Y")).toBe(Level.H);
    sim.actuate("RV", { position: 0.1 });
    sim.runUntil(2e-4);
    expect(lv(sim, "Y")).toBe(Level.L);
  });
});
