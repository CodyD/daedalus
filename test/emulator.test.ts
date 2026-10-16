import { describe, expect, it } from "vitest";
import type { ComponentDef } from "../src/shared/component";
import { checkEmulator } from "../src/sim/mcu/avr/emulator";
import { validateComponent } from "../src/sim/validate";
import { Circuit, lib, volts } from "./helpers";

const STACK = `
  ldi r16, high(RAMEND)
  out SPH, r16
  ldi r16, low(RAMEND)
  out SPL, r16`;

/** TMP36-style analog temperature sensor: VOUT = 0.5 V + 10 mV/°C, through virtual DAC0. */
const TEMP_SENSOR: ComponentDef = {
  id: "EMU_TMP", name: "Test temp sensor", category: "peripheral", description: "emulated", refPrefix: "U",
  pins: [
    { id: "VS", name: "+VS", number: "1", type: "power", side: "left" },
    { id: "VOUT", name: "VOUT", number: "2", type: "analog", side: "right", port: "DAC0" },
    { id: "GND", name: "GND", number: "3", type: "ground", side: "left" },
  ],
  properties: [],
  symbol: { kind: "box" },
  model: {
    kind: "emulator",
    emulator: {
      core: "avr8", clockHz: 1e6,
      controls: [{ key: "TEMP", label: "Temperature", unit: "°C", min: -40, max: 125, default: 25, scale: 10 }],
      source: `
.org 0
  jmp reset
reset:${STACK}
loop:
  lds r24, CTRL_TEMP        ; tenths of a degree
  lds r25, CTRL_TEMP+1
  subi r24, low(-500)       ; + 500 mV offset (10 mV/degC = 1 mV per tenth)
  sbci r25, high(-500)
  sts DAC0+1, r25
  sts DAC0, r24
  rjmp loop`,
    },
  },
  source: { kind: "emulated" },
};

/** UART sensor: streams one character per reading, 'A' + LEVEL, at 9600 8N1. */
const UART_SENSOR: ComponentDef = {
  id: "EMU_UART", name: "Test UART sensor", category: "peripheral", description: "emulated", refPrefix: "U",
  pins: [
    { id: "TX", name: "TX", number: "1", type: "output", side: "right", port: "PD1" },
    { id: "RX", name: "RX", number: "2", type: "input", side: "right", port: "PD0" },
  ],
  properties: [],
  symbol: { kind: "box" },
  model: {
    kind: "emulator",
    emulator: {
      core: "avr8", clockHz: 16e6,
      controls: [{ key: "LEVEL", label: "Level", min: 0, max: 25, default: 0, step: 1 }],
      source: `
.org 0
  jmp reset
reset:${STACK}
  ldi r16, 103              ; 9600 baud at 16 MHz
  sts UBRR0L, r16
  ldi r16, 0
  sts UBRR0H, r16
  ldi r16, (1<<TXEN0)
  sts UCSR0B, r16
  ldi r16, (1<<UCSZ01)|(1<<UCSZ00)
  sts UCSR0C, r16
loop:
  lds r17, CTRL_LEVEL
  ldi r18, 65
  add r17, r18
wait:
  lds r16, UCSR0A
  sbrs r16, UDRE0
  rjmp wait
  sts UDR0, r17
  rjmp loop`,
    },
  },
  source: { kind: "emulated" },
};

describe("emulated parts", () => {
  it("validate cleanly", () => {
    expect(validateComponent(TEMP_SENSOR).errors).toEqual([]);
    expect(validateComponent(UART_SENSOR).errors).toEqual([]);
  });

  it("drive an analog output from a control through a virtual DAC", () => {
    const sim = new Circuit()
      .add("U1", TEMP_SENSOR)
      .add("RL", lib("RES"), { R: "100k" })
      .net("OUT", "U1.VOUT", "RL.A")
      .net("GND", "RL.B", "U1.GND")
      .sim();
    sim.runUntil(5e-3);
    expect(volts(sim, "OUT")).toBeCloseTo(0.75, 2);
    sim.actuate("U1", { control: "TEMP", value: 100 });
    sim.runUntil(10e-3);
    expect(volts(sim, "OUT")).toBeCloseTo(1.5, 2);
    expect(sim.indicateAll().U1).toMatchObject({ controls: { TEMP: 100 }, dacs: { DAC0: 1.5 } });
  });

  it("starts from the instance's saved control value and clamps to the range", () => {
    const sim = new Circuit().add("U1", TEMP_SENSOR, { "ctl.TEMP": "-10" }).add("RL", lib("RES"), { R: "100k" })
      .net("OUT", "U1.VOUT", "RL.A").net("GND", "RL.B").sim();
    sim.runUntil(5e-3);
    expect(volts(sim, "OUT")).toBeCloseTo(0.4, 2);
    sim.actuate("U1", { control: "TEMP", value: 1000 });
    expect(sim.indicateAll().U1).toMatchObject({ controls: { TEMP: 125 } });
  });

  it("speaks UART through the backing MCU's USART, following live control changes", () => {
    const sim = new Circuit()
      .add("U1", UART_SENSOR)
      .add("TERM", lib("VTERM"), { BAUD: "9600" })
      .net("SER", "U1.TX", "TERM.RXD")
      .sim();
    sim.runUntil(0.03);
    sim.actuate("U1", { control: "LEVEL", value: 2 });
    sim.runUntil(0.06);
    const text = (sim.indicateAll().TERM as { text: string }).text;
    expect(text).toMatch(/^A{20,}C{20,}$/);
  });

  it("rejects bad pin maps, control keys and firmware", () => {
    const bad: ComponentDef = structuredClone(UART_SENSOR);
    bad.pins[0].port = "PE9";
    bad.pins[1].port = "PE9";
    bad.model.emulator!.controls[0].key = "level";
    bad.model.emulator!.source += "\n  frob r1";
    const errs = checkEmulator(bad).join("\n");
    expect(errs).toMatch(/pin TX maps to 'PE9'/);
    expect(errs).toMatch(/both map to PE9/);
    expect(errs).toMatch(/control key 'level'/);
    expect(errs).toMatch(/firmware:/);
  });
});
