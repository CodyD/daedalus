// Builds the bundled example projects from code, then runs each one through
// the same path the app uses (schematic -> netlist -> firmware -> simulator)
// and checks it behaves. `WRITE_EXAMPLES=1 npx vitest run test/examples.test.ts`
// regenerates examples/*.dad.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Netlist } from "../src/shared/component";
import { Project, buildNetlist } from "../src/shared/project";
import { Simulator } from "../src/sim/engine";
import { assemble } from "../src/sim/mcu/avr/asm";
import { M328P_SYMBOLS } from "../src/sim/mcu/avr/variants";
import { toIntelHex } from "../src/sim/mcu/hex";
import { createModel } from "../src/sim/models";
import { lcdGlyph } from "../src/renderer/src/lcdfont";
import { DEFS, SchematicBuilder } from "./example-builder";

const ROOT = join(__dirname, "..");
const fw = (name: string) => readFileSync(join(ROOT, "examples", "firmware", name), "utf8");

function blink(): Project {
  return new SchematicBuilder("01 LED blink (Timer1 interrupt)")
    .source("blink.asm", fw("blink.asm"))
    .part("ATMEGA328P", "U1", 0, 0, { PROGRAM: "src:blink.asm" })
    .part("RES", "R1", 200, 10, { R: "330" })
    .part("LED-RED", "D1", 300, 10)
    .wire("U1.PB5", "R1.A").wire("R1.B", "D1.A")
    .ground("D1.K")
    .project;
}

function serial(): Project {
  const b = new SchematicBuilder("02 Serial terminal echo (USART + RX interrupt)")
    .source("serial.asm", fw("serial.asm"))
    .part("ATMEGA328P", "U1", 0, 0, { PROGRAM: "src:serial.asm" })
    .part("VTERM", "T1", -320, -50, { BAUD: "9600" }, 0);
  // Terminal RXD <- MCU TXD (PD1), terminal TXD -> MCU RXD (PD0).
  b.path("T1.RXD", [-400, -60], [-400, -120], [-120, -120], [-120, -40], "U1.PD1");
  b.path("T1.TXD", [-390, -40], [-390, -100], [-140, -100], [-140, -60], "U1.PD0");
  return b.project;
}

function lcd(): Project {
  const b = new SchematicBuilder("03 LCD 16x2 (HD44780, 4-bit)")
    .source("lcd.asm", fw("lcd.asm"))
    .part("ATMEGA328P", "U1", 0, 0, { PROGRAM: "src:lcd.asm" })
    .part("LCD1602", "LCD1", -300, -300);
  for (const [i, d] of ["D4", "D5", "D6", "D7"].entries()) {
    const [x, y] = b.pin("LCD1", d);
    const [, py] = b.pin("U1", `PD${4 + i}`);
    b.path([x, y], [x, py], `U1.PD${4 + i}`);
  }
  b.path("LCD1.RS", [-340, -190], [150, -190], [150, -90], "U1.PB0");
  b.path("LCD1.E", [-320, -180], [140, -180], [140, -70], "U1.PB1");
  b.ground("LCD1.VSS", 20).ground("LCD1.RW", 20).ground("LCD1.VEE", 20);
  b.part("POWER", "PWR_LCD", -420, -260);
  b.path("LCD1.VDD", [-360, -225], [-420, -225], [-420, -250]);
  return b.project;
}

function dimmer(): Project {
  const b = new SchematicBuilder("04 ADC to PWM dimmer with oscilloscope")
    .source("dimmer.asm", fw("dimmer.asm"))
    .part("ATMEGA328P", "U1", 0, 0, { PROGRAM: "src:dimmer.asm" })
    .part("POT", "RV1", 250, 150, { R: "10k", POSITION: "0.5" })
    .part("RES", "R1", -200, 60, { R: "220" })
    .part("LED-GREEN", "D1", -300, 60, {}, 180)
    .part("SCOPE", "OSC1", 400, -50, { TIMEBASE: "5m" });
  b.path("RV1.W", [250, 30], "U1.PC0");
  b.part("POWER", "PWR1", 190, 110);
  b.path("RV1.A", [190, 150], [190, 120]);
  b.ground("RV1.B", 30, 20);
  b.wire("U1.PD6", "R1.B").wire("R1.A", "D1.A").ground("D1.K");
  b.path("OSC1.B", [250, -60], [250, 30]);
  b.path("OSC1.A", [330, -80], [330, -220], [-130, -220], [-130, 60]);
  return b.project;
}

function chaser(): Project {
  const b = new SchematicBuilder("05 555 astable + CD4017 LED chaser (mixed-mode)")
    .part("NE555", "U1", 0, 0)
    .part("RES", "R1", -150, -20, { R: "10k" }, 90)
    .part("RES", "R2", -150, 60, { R: "47k" }, 90)
    .part("CAP-ELEC", "C1", -150, 160, { C: "4.7u" }, 90)
    .part("CD4017", "U2", 300, 0);
  b.path("R2.B", "C1.A");
  b.path("U1.DIS", [-100, 30], [-100, 20], "R1.B");
  b.path("U1.THR", [-80, 10], [-80, 110], [-150, 110]);
  b.path("U1.TRIG", [-70, -30], [-70, 10]);
  b.power("R1.A").power("U1.VCC").power("U1.RESET").ground("C1.B").ground("U1.GND");
  b.wire("U1.OUT", "U2.CLK");
  b.ground("U2.CLKINH", 40, -30);
  b.path("U2.RST", [210, 20], [210, -160], [420, -160], [420, -100], "U2.Q5");
  for (const [k, q] of ["Q0", "Q1", "Q2", "Q3", "Q4"].entries()) {
    const [, y] = b.pin("U2", q);
    b.part("RES", `R${10 + k}`, 460, y, { R: "470" }).part("LED-RED", `D${10 + k}`, 560, y);
    b.wire(`U2.${q}`, `R${10 + k}.A`).wire(`R${10 + k}.B`, `D${10 + k}.A`).path(`D${10 + k}.K`, [620, y]);
  }
  b.path([620, -80], [620, 90]);
  b.part("GROUND", "GND_BUS", 620, 100);
  return b.project;
}

function opamp(): Project {
  const b = new SchematicBuilder("06 Op-amp non-inverting amplifier (gain 3)")
    .part("OPAMP", "U1", 0, 0)
    .part("VSINE", "V1", -150, 60, { AMPL: "1", FREQ: "500" })
    .part("RES", "RF", 0, -120, { R: "20k" })
    .part("RES", "RG", -80, 30, { R: "10k" }, 90)
    .part("SCOPE", "OSC1", 250, 0, { TIMEBASE: "5m" });
  b.path("V1.P", [-150, 10], "U1.INP");
  b.ground("V1.N");
  b.power("U1.VP", "VP", "12");
  b.part("POWER", "PWR_VN", 0, 70, { NET: "VN", VOLTAGE: "-12" }, 180);
  b.path("U1.VN", [0, 60]);
  b.path("U1.OUT", "RF.B");
  b.path("RF.A", [-60, -120], [-60, -10], "U1.INN");
  b.path("RG.A", [-60, -10]);
  b.ground("RG.B");
  b.path("OSC1.B", [100, -10], [100, 0], "U1.OUT");
  b.path("OSC1.A", [160, -30], [160, -160], [-100, -160], [-100, 10]);
  return b.project;
}

export const EXAMPLES: [string, () => Project][] = [
  ["01-blink.dad", blink],
  ["02-serial-echo.dad", serial],
  ["03-lcd-16x2.dad", lcd],
  ["04-adc-pwm-dimmer.dad", dimmer],
  ["05-555-4017-chaser.dad", chaser],
  ["06-opamp-amplifier.dad", opamp],
];

/** Same firmware resolution the renderer does, without IPC. */
function simulate(project: Project): { sim: Simulator; nl: Netlist; pinNets: Map<string, string> } {
  const { netlist, pinNets } = buildNetlist(project, DEFS);
  const nl: Netlist = {
    ...netlist,
    instances: netlist.instances.map((i) => {
      const prog = i.props.PROGRAM;
      if (!prog?.startsWith("src:")) return i;
      const hex = toIntelHex(assemble(project.sources![prog.slice(4)], M328P_SYMBOLS).bytes);
      return { ...i, files: { PROGRAM: hex } };
    }),
  };
  return { sim: new Simulator(nl, createModel), nl, pinNets };
}

function lcdText(ind: { lines: number[][] }): string[] {
  return ind.lines.map((row) => row.map((c) => String.fromCharCode(c)).join(""));
}

describe("bundled examples", () => {
  if (process.env.WRITE_EXAMPLES) {
    it("writes example files", () => {
      for (const [file, make] of EXAMPLES) writeFileSync(join(ROOT, "examples", file), JSON.stringify(make(), null, 2));
    });
  }

  it("every example netlists without dangling wires", () => {
    for (const [file, make] of EXAMPLES) {
      const p = make();
      const { netlist, wireNets } = buildNetlist(p, DEFS);
      for (const w of p.wires) {
        const net = netlist.nets.find((n) => n.name === wireNets.get(w.id));
        expect(net?.pins.length ?? 0, `${file} wire ${w.id} touches no pin`).toBeGreaterThan(0);
      }
    }
  });

  it("01 blinks the LED at 1 Hz", () => {
    const { sim } = simulate(blink());
    const b = () => (sim.indicateAll().D1 as { brightness: number }).brightness;
    sim.runUntil(0.25);
    const first = b();
    sim.runUntil(0.75);
    const second = b();
    sim.runUntil(1.25);
    expect(sim.logs.filter((l) => l.level !== "info")).toEqual([]);
    expect(first).toBeLessThan(0.1);
    expect(second).toBeGreaterThan(0.5);
    expect(b()).toBeLessThan(0.1);
  });

  it("02 prints a banner and echoes in upper case", () => {
    const { sim } = simulate(serial());
    const text = () => (sim.indicateAll().T1 as { text: string }).text;
    sim.runUntil(0.06);
    expect(text()).toBe("Daedalus serial demo\nType something:\n> ");
    sim.actuate("T1", { send: "hi!\r" });
    sim.runUntil(0.08);
    expect(text().endsWith("> HI!\n> ")).toBe(true);
  });

  it("03 writes text and a counter to the LCD", () => {
    const { sim } = simulate(lcd());
    sim.runUntil(0.15);
    const ind = sim.indicateAll().LCD1 as { lines: number[][]; on: boolean };
    expect(ind.on).toBe(true);
    const [l1, l2] = lcdText(ind);
    expect(l1).toBe("Hello, Daedalus!");
    expect(l2.startsWith("Counter: 00")).toBe(true);
    sim.runUntil(0.9);
    expect(lcdText(sim.indicateAll().LCD1 as { lines: number[][] })[1]).toMatch(/Counter: 00[2-4]/);
    expect(lcdGlyph("H".charCodeAt(0))).toEqual([0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11]);
  });

  it("04 maps the pot position to PWM duty", () => {
    const { sim, pinNets } = simulate(dimmer());
    const net = pinNets.get("U1.PD6")!;
    const duty = (from: number) => {
      let hi = 0, n = 0;
      for (let t = from; t < from + 0.01; t += 7e-6) {
        sim.runUntil(t);
        n++;
        if ((sim.netStates()[net].v ?? 0) > 2.5) hi++;
      }
      return hi / n;
    };
    expect(duty(0.01)).toBeCloseTo(0.5, 1);
    sim.actuate("RV1", { position: 0.8 }); // wiper near ground end -> ~1 V
    expect(duty(0.03)).toBeCloseTo(0.2, 1);
    const scope = sim.indicateAll().OSC1 as { samples: number[][] };
    expect(scope.samples.length).toBeGreaterThan(100);
  });

  it("05 steps the LED chaser from the 555 clock", () => {
    const { sim } = simulate(chaser());
    const lit = () => [10, 11, 12, 13, 14].map((k) => (sim.indicateAll()[`D${k}`] as { brightness: number }).brightness > 0.5 ? 1 : 0);
    const seen = new Set<string>();
    for (let t = 0.1; t < 3; t += 0.05) {
      sim.runUntil(t);
      const l = lit();
      expect(l.reduce<number>((a, b) => a + b, 0)).toBe(1);
      seen.add(l.join(""));
    }
    expect(seen.size).toBe(5); // every LED lit at some point, Q5 reset works
  }, 30000);

  it("06 amplifies the sine by 3", () => {
    const { sim, pinNets } = simulate(opamp());
    const outNet = pinNets.get("U1.OUT")!;
    let max = -Infinity, min = Infinity;
    for (let t = 0.002; t < 0.006; t += 2e-5) {
      sim.runUntil(t);
      const v = sim.netStates()[outNet].v!;
      max = Math.max(max, v);
      min = Math.min(min, v);
    }
    expect(max).toBeCloseTo(3, 1);
    expect(min).toBeCloseTo(-3, 1);
  });
});

