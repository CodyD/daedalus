// Drives the assistant's tool layer exactly as Claude would (tool name +
// JSON input), without the API: builds a circuit from nothing, writes
// firmware, simulates, and checks the report the model would see.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ComponentDef, Netlist } from "../src/shared/component";
import { emptyProject, Project, buildNetlist } from "../src/shared/project";
import { runHeadless } from "../src/sim/headless";
import { assemble } from "../src/sim/mcu/avr/asm";
import { M328P_SYMBOLS } from "../src/sim/mcu/avr/variants";
import { toIntelHex } from "../src/sim/mcu/hex";
import { ExecContext, executeTool } from "../src/renderer/src/assistant/executor";
import { DEFS } from "./example-builder";

function session() {
  let project: Project = emptyProject();
  const defs = new Map<string, ComponentDef>(DEFS);
  const ctx: ExecContext = {
    getProject: () => project,
    setProject: (p) => { project = p; },
    defs: () => defs,
    resolveFiles: async (netlist: Netlist, proj: Project) => ({
      netlist: {
        ...netlist,
        instances: netlist.instances.map((i) => {
          const prog = i.props.PROGRAM;
          if (!prog?.startsWith("src:")) return i;
          return { ...i, files: { PROGRAM: toIntelHex(assemble(proj.sources![prog.slice(4)], M328P_SYMBOLS).bytes) } };
        }),
      },
      problems: [],
    }),
    simulate: async (netlist, opts) => runHeadless(netlist, opts),
    askApproval: async () => true,
    askFile: async () => null,
    libraryChanged: async () => {},
    savePart: async (def) => { defs.set(def.id, def); },
  };
  const call = (name: string, input: unknown) => executeTool(name, input, ctx) as Promise<any>;
  return { call, project: () => project, defs };
}

describe("assistant tools", () => {
  it("searches the library", async () => {
    const { call } = session();
    const r = await call("search_library", { query: "shift register" });
    expect(r.parts.map((p: { id: string }) => p.id)).toContain("74HC595");
    const part = await call("get_part", { id: "ATMEGA328P" });
    expect(part.pins.find((p: { id: string }) => p.id === "PB5").port).toBe("PB5");
  });

  it("builds, programs and verifies a button-controlled LED", async () => {
    const { call, project, defs } = session();
    expect((await call("place_part", { def_id: "ATMEGA328P" })).ref).toBe("U1");
    await call("place_part", { def_id: "RES", props: { R: "330" } });
    await call("place_part", { def_id: "LED-RED" });
    await call("place_part", { def_id: "BUTTON" });
    expect((await call("place_part", { def_id: "RES", props: { BOGUS: "1" } })).error).toMatch(/no property 'BOGUS'/);

    await call("connect", { net: "LED_DRIVE", pins: ["U1.PB5", "R1.A"] });
    await call("connect", { net: "LED_A", pins: ["R1.B", "D1.A"] });
    await call("connect", { net: "GND", pins: ["D1.K", "SW1.B", "U1.GND"] });
    await call("connect", { net: "VCC", pins: ["U1.VCC"], rail_voltage: 5 });
    await call("connect", { net: "BTN", pins: ["U1.PD2", "SW1.A"] });
    // re-connecting to the same net is a no-op; to another net is an error
    expect((await call("connect", { net: "BTN", pins: ["U1.PD2"] })).already_on_net).toEqual(["U1.PD2"]);
    expect((await call("connect", { net: "OTHER", pins: ["U1.PD2"] })).error).toMatch(/already connected to net BTN/);
    expect((await call("connect", { net: "X", pins: ["U1.PZ9"] })).error).toMatch(/no pin 'PZ9'/);

    const bad = await call("write_firmware", { mcu_ref: "U1", filename: "main.asm", source: "  ldi r16, 1\n  frob r16\n" });
    expect(bad.error).toMatch(/line 2/);
    expect(bad.source_line).toBe("frob r16");

    const fw = `
        ldi r16, high(RAMEND)
        out SPH, r16
        ldi r16, low(RAMEND)
        out SPL, r16
        sbi DDRB, 5        ; LED output
        sbi PORTD, 2       ; button pull-up
loop:   sbic PIND, 2       ; pressed = low
        rjmp off
        sbi PORTB, 5
        rjmp loop
off:    cbi PORTB, 5
        rjmp loop`;
    expect((await call("write_firmware", { mcu_ref: "U1", filename: "main.asm", source: fw })).bytes).toBeGreaterThan(0);

    const sch = await call("get_schematic", {});
    expect(sch.nets.find((n: { name: string }) => n.name === "LED_DRIVE").pins.sort()).toEqual(["R1.A", "U1.PB5"]);
    expect(sch.rails.VCC).toBe("5");

    const report = await call("run_simulation", {
      seconds: 0.03,
      actions: [{ at: 0.01, ref: "SW1", action: { pressed: true } }, { at: 0.02, ref: "SW1", action: { pressed: false } }],
      watch: ["LED_DRIVE"],
    });
    expect(report.error).toBeUndefined();
    expect(report.indicators.D1.lit).toBe(false); // released at the end
    expect(report.watched.LED_DRIVE.transitions).toBe(2); // on while pressed, then off
    expect(report.indicators.U1.program_loaded).toBe(true);

    // The generated schematic is real: the app's own netlister agrees.
    const { pinNets } = buildNetlist(project(), defs);
    expect(pinNets.get("U1.PB5")).toBe(pinNets.get("R1.A"));
    expect(pinNets.get("D1.K")).toBe("GND");
    if (process.env.WRITE_EXAMPLES) {
      writeFileSync(join(__dirname, "..", "examples", "07-assistant-built-button-led.dad"),
        JSON.stringify({ ...project(), name: "07 Button + LED (built by assistant tools)" }, null, 2));
    }
  });

  it("removes parts with their connections", async () => {
    const { call, project } = session();
    await call("place_part", { def_id: "RES" });
    await call("place_part", { def_id: "LED-RED" });
    await call("connect", { net: "N1", pins: ["R1.B", "D1.A"] });
    await call("connect", { net: "GND", pins: ["D1.K"] });
    await call("remove_part", { ref: "D1" });
    const p = project();
    expect(p.parts.map((x) => x.defId).sort()).toEqual(["NETLABEL", "RES"]);
    expect(p.wires.length).toBe(1);
  });

  it("auto-places parts without overlap", async () => {
    const { call, project, defs } = session();
    for (const id of ["ATMEGA328P", "LCD1602", "74HC595", "RES", "RES", "POT", "NE555"]) await call("place_part", { def_id: id });
    const { partBounds } = await import("../src/shared/edit");
    const boxes = project().parts.map((p) => partBounds(p, defs.get(p.defId)!));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i], boxes[j]];
        const overlap = a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
        expect(overlap, `${project().parts[i].ref} overlaps ${project().parts[j].ref}`).toBe(false);
      }
    }
  });

  it("can rebuild the LCD example from tool calls alone", async () => {
    const { call } = session();
    await call("place_part", { def_id: "ATMEGA328P" });
    await call("place_part", { def_id: "LCD1602" });
    for (let i = 4; i < 8; i++) await call("connect", { net: `LCD_D${i}`, pins: [`U1.PD${i}`, `LCD1.D${i}`] });
    await call("connect", { net: "LCD_RS", pins: ["U1.PB0", "LCD1.RS"] });
    await call("connect", { net: "LCD_E", pins: ["U1.PB1", "LCD1.E"] });
    await call("connect", { net: "GND", pins: ["LCD1.VSS", "LCD1.RW", "LCD1.VEE"] });
    await call("connect", { net: "VCC", pins: ["LCD1.VDD"], rail_voltage: 5 });
    const src = readFileSync(join(__dirname, "..", "examples", "firmware", "lcd.asm"), "utf8");
    await call("write_firmware", { mcu_ref: "U1", filename: "lcd.asm", source: src });
    const r = await call("run_simulation", { seconds: 0.2 });
    expect(r.indicators.LCD1.lines[0]).toBe("Hello, Daedalus!");
  });

  it("defines an emulated sensor, places it and drives its reading from run_simulation", async () => {
    const { call, defs } = session();
    const firmware = `
.org 0
  jmp reset
reset:
  ldi r16, high(RAMEND)
  out SPH, r16
  ldi r16, low(RAMEND)
  out SPL, r16
  ldi r16, 103              ; 9600 baud at 16 MHz
  sts UBRR0L, r16
  ldi r16, (1<<TXEN0)
  sts UCSR0B, r16
  ldi r16, (1<<UCSZ01)|(1<<UCSZ00)
  sts UCSR0C, r16
loop:
  lds r17, CTRL_LEVEL
  ldi r18, 48               ; '0' + level
  add r17, r18
wait:
  lds r16, UCSR0A
  sbrs r16, UDRE0
  rjmp wait
  sts UDR0, r17
  rjmp loop`;
    const input = {
      id: "LEVEL_SENSOR", name: "Level sensor", description: "Streams its level as a digit over UART",
      pins: [
        { id: "VCC", name: "VCC", number: "1", type: "power", side: "left" },
        { id: "TXD", name: "TXD", number: "2", type: "output", side: "right", backing: "PD1" },
        { id: "GND", name: "GND", number: "3", type: "ground", side: "left" },
      ],
      controls: [{ key: "LEVEL", label: "Level", min: 0, max: 9, step: 1, default: 1 }],
      firmware,
    };
    const bad = await call("define_emulated_part", { ...input, firmware: firmware.replace("sbrs r16, UDRE0", "sbrs r16, NOPE") });
    expect(bad.error).toMatch(/firmware: line \d+/);
    expect(bad.source_line).toBe("sbrs r16, NOPE");
    expect(defs.has("LEVEL_SENSOR")).toBe(false);

    expect((await call("define_emulated_part", { ...input, id: "RES" })).error).toMatch(/already a built-in part/);

    const ok = await call("define_emulated_part", input);
    expect(ok.error).toBeUndefined();
    expect(defs.get("LEVEL_SENSOR")!.source!.kind).toBe("emulated");
    await call("place_part", { def_id: "LEVEL_SENSOR" });
    await call("place_part", { def_id: "VTERM" });
    await call("connect", { net: "SER", pins: ["U1.TXD", "TERM1.RXD"] });
    const r = await call("run_simulation", { seconds: 0.06, actions: [{ at: 0.03, ref: "U1", action: { control: "LEVEL", value: 7 } }] });
    expect(r.indicators.TERM1.received).toMatch(/^1{20,}7{20,}$/);
    expect(r.indicators.U1.controls).toEqual({ LEVEL: 7 });
  });
});
