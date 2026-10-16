import { describe, expect, it } from "vitest";
import { parseValue } from "../src/sim/units";
import { Circuit, volts } from "./helpers";

describe("units", () => {
  it("parses engineering notation", () => {
    expect(parseValue("4k7")).toBeCloseTo(4700);
    expect(parseValue("10u")).toBeCloseTo(10e-6);
    expect(parseValue("2.2meg")).toBeCloseTo(2.2e6);
    expect(parseValue("16MHz")).toBeCloseTo(16e6);
    expect(parseValue("100n")).toBeCloseTo(1e-7);
  });
});

describe("analog (MNA)", () => {
  it("solves a voltage divider at the operating point", () => {
    const sim = new Circuit()
      .add("V1", "BATTERY", { VOLTAGE: "10" }).add("R1", "RES", { R: "1k" }).add("R2", "RES", { R: "3k" })
      .net("VIN", "V1.P", "R1.A").net("MID", "R1.B", "R2.A").net("GND", "R2.B", "V1.N")
      .sim();
    expect(volts(sim, "MID")).toBeCloseTo(7.5, 6);
  });

  it("charges an RC network with time constant RC", () => {
    // Step from 0 to 5 V at t=0 (1 µs rise) into R=1k, C=1u.
    const c = new Circuit()
      .add("V1", "VPULSE", { V1: "0", V2: "5", PW: "1", PER: "2" }).add("R1", "RES", { R: "1k" }).add("C1", "CAP", { C: "1u" })
      .net("S", "V1.P", "R1.A").net("OUT", "R1.B", "C1.A").net("GND", "C1.B", "V1.N");
    const sim = c.sim({ dtMin: 1e-6, dtMax: 1e-5 });
    expect(volts(sim, "OUT")).toBeCloseTo(0, 3);
    sim.runUntil(1e-3);
    // 5 * (1 - e^-1) = 3.16; backward Euler at 1-10 µs steps is within ~1%
    expect(volts(sim, "OUT")).toBeGreaterThan(3.1);
    expect(volts(sim, "OUT")).toBeLessThan(3.25);
    sim.runUntil(10e-3);
    expect(volts(sim, "OUT")).toBeCloseTo(5, 2);
  });

  it("biases a diode around 0.6-0.7 V", () => {
    const sim = new Circuit()
      .add("P", "POWER").add("R1", "RES", { R: "1k" }).add("D1", "1N4148")
      .net("VCC", "P.P", "R1.A").net("A", "R1.B", "D1.A").net("GND", "D1.K")
      .sim();
    const vd = volts(sim, "A");
    expect(vd).toBeGreaterThan(0.6);
    expect(vd).toBeLessThan(0.8);
  });

  it("regulates with a zener in reverse breakdown", () => {
    const sim = new Circuit()
      .add("V1", "BATTERY", { VOLTAGE: "12" }).add("R1", "RES", { R: "1k" }).add("D1", "1N4733A")
      .net("VIN", "V1.P", "R1.A").net("Z", "R1.B", "D1.K").net("GND", "D1.A", "V1.N")
      .sim();
    expect(volts(sim, "Z")).toBeGreaterThan(4.9);
    expect(volts(sim, "Z")).toBeLessThan(5.6);
  });

  it("saturates an NPN switch", () => {
    const sim = new Circuit()
      .add("P", "POWER").add("RB", "RES", { R: "10k" }).add("RC", "RES", { R: "1k" }).add("Q1", "2N2222")
      .net("VCC", "P.P", "RB.A", "RC.A").net("B", "RB.B", "Q1.B").net("C", "RC.B", "Q1.C").net("GND", "Q1.E")
      .sim();
    expect(volts(sim, "B")).toBeGreaterThan(0.6);
    expect(volts(sim, "B")).toBeLessThan(0.85);
    expect(volts(sim, "C")).toBeLessThan(0.3);
  });

  it("switches an NMOS on with gate drive", () => {
    const sim = new Circuit()
      .add("P", "POWER").add("RD", "RES", { R: "100" }).add("Q1", "2N7000")
      .net("VCC", "P.P", "RD.A", "Q1.G").net("D", "RD.B", "Q1.D").net("GND", "Q1.S")
      .sim();
    expect(volts(sim, "D")).toBeLessThan(0.6);
  });

  it("closes the loop on a non-inverting op-amp (gain 2)", () => {
    const sim = new Circuit()
      .add("VP", "POWER", { NET: "VP", VOLTAGE: "12" }).add("VN", "POWER", { NET: "VN", VOLTAGE: "-12" })
      .add("VI", "BATTERY", { VOLTAGE: "1.5" }).add("U1", "OPAMP")
      .add("RF", "RES", { R: "10k" }).add("RG", "RES", { R: "10k" })
      .net("VP", "VP.P", "U1.VP").net("VN", "VN.P", "U1.VN").net("IN", "VI.P", "U1.INP")
      .net("OUT", "U1.OUT", "RF.A").net("FB", "RF.B", "RG.A", "U1.INN").net("GND", "RG.B", "VI.N")
      .sim();
    expect(volts(sim, "OUT")).toBeCloseTo(3.0, 2);
  });

  it("clips an op-amp at its rails", () => {
    const sim = new Circuit()
      .add("VP", "POWER", { NET: "VP", VOLTAGE: "5" }).add("VI", "BATTERY", { VOLTAGE: "1" }).add("U1", "LM358")
      .net("VP", "VP.P", "U1.VCC").net("IN", "VI.P", "U1.INP1").net("GND", "U1.GND", "U1.INN1", "VI.N")
      .net("OUT", "U1.OUT1")
      .sim();
    expect(volts(sim, "OUT")).toBeGreaterThan(4.0);
    expect(volts(sim, "OUT")).toBeLessThan(4.3);
  });

  it("follows a sine source in transient analysis", () => {
    const sim = new Circuit()
      .add("V1", "VSINE", { AMPL: "2", FREQ: "1k" }).add("R1", "RES")
      .net("S", "V1.P", "R1.A").net("GND", "V1.N", "R1.B")
      .sim();
    sim.runUntil(0.25e-3);
    expect(volts(sim, "S")).toBeCloseTo(2, 1);
    sim.runUntil(0.75e-3);
    expect(volts(sim, "S")).toBeCloseTo(-2, 1);
  });

  it("lights an LED in proportion to current", () => {
    const sim = new Circuit()
      .add("P", "POWER").add("R1", "RES", { R: "330" }).add("D1", "LED-RED")
      .net("VCC", "P.P", "R1.A").net("A", "R1.B", "D1.A").net("GND", "D1.K")
      .sim();
    const ind = sim.indicateAll().D1 as { brightness: number; current: number };
    expect(ind.current).toBeGreaterThan(0.008);
    expect(ind.current).toBeLessThan(0.0105);
    expect(ind.brightness).toBeGreaterThan(0.8);
  });
});
