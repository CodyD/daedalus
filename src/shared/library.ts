// Built-in component library. Logic chips and the 555 are written in the same
// behavioural DSL that datasheet import produces, and discrete semiconductors
// are SPICE .model cards, so built-in and imported parts take one code path.

import type { ComponentDef, PinDef, PropertyDef } from "./component";
import { ATMEGA328P } from "../sim/mcu/avr/variants";

const pin = (id: string, number: string, type: PinDef["type"], side: PinDef["side"] = "left", name = id): PinDef =>
  ({ id, name, number, type, side });

const prop = (key: string, label: string, def: string, unit?: string, extra: Partial<PropertyDef> = {}): PropertyDef =>
  ({ key, label, default: def, unit, ...extra });

const builtin = (sym: string) => ({ kind: "builtin" as const, builtin: sym });
const SRC = { kind: "builtin" as const };

function part(d: Omit<ComponentDef, "source">): ComponentDef {
  return { ...d, source: SRC };
}

// --- terminals, passives, sources ------------------------------------------

const terminals: ComponentDef[] = [
  part({
    id: "GROUND", name: "Ground", category: "terminal", description: "Ground reference (0 V).", refPrefix: "GND",
    pins: [pin("GND", "1", "ground", "top")], properties: [], symbol: builtin("ground"),
    model: { kind: "builtin", builtin: "ground" },
  }),
  part({
    id: "POWER", name: "Power rail", category: "terminal", description: "Ideal DC supply rail. Terminals with the same NET name are connected.",
    refPrefix: "PWR", pins: [pin("P", "1", "power", "bottom")],
    properties: [prop("NET", "Net name", "VCC"), prop("VOLTAGE", "Voltage", "5", "V")],
    symbol: builtin("power"), model: { kind: "builtin", builtin: "power" },
  }),
  part({
    id: "NETLABEL", name: "Net label", category: "terminal", description: "Connects every pin it touches to other labels with the same NAME.",
    refPrefix: "LBL", pins: [pin("N", "1", "passive", "left")], properties: [prop("NAME", "Net name", "NET1")],
    symbol: builtin("label"), model: { kind: "builtin", builtin: "ground" },
  }),
];

const passives: ComponentDef[] = [
  part({
    id: "RES", name: "Resistor", category: "passive", description: "Ideal resistor.", refPrefix: "R",
    pins: [pin("A", "1", "passive"), pin("B", "2", "passive", "right")],
    properties: [prop("R", "Resistance", "1k", "Ω")], symbol: builtin("resistor"),
    model: { kind: "spice", spice: "R1 A B {R}" },
  }),
  part({
    id: "CAP", name: "Capacitor", category: "passive", description: "Ideal capacitor.", refPrefix: "C",
    pins: [pin("A", "1", "passive"), pin("B", "2", "passive", "right")],
    properties: [prop("C", "Capacitance", "100n", "F")], symbol: builtin("capacitor"),
    model: { kind: "spice", spice: "C1 A B {C}" },
  }),
  part({
    id: "CAP-ELEC", name: "Electrolytic capacitor", category: "passive", description: "Polarised capacitor (+ on A).", refPrefix: "C",
    pins: [pin("A", "1", "passive", "left", "+"), pin("B", "2", "passive", "right", "-")],
    properties: [prop("C", "Capacitance", "10u", "F")], symbol: builtin("capacitor-polar"),
    model: { kind: "spice", spice: "C1 A B {C}" },
  }),
  part({
    id: "IND", name: "Inductor", category: "passive", description: "Ideal inductor.", refPrefix: "L",
    pins: [pin("A", "1", "passive"), pin("B", "2", "passive", "right")],
    properties: [prop("L", "Inductance", "1m", "H")], symbol: builtin("inductor"),
    model: { kind: "spice", spice: "L1 A B {L}" },
  }),
  part({
    id: "POT", name: "Potentiometer", category: "passive", description: "Interactive potentiometer; drag the wiper while simulating.",
    refPrefix: "RV", pins: [pin("A", "1", "passive"), pin("W", "2", "passive", "top"), pin("B", "3", "passive", "right")],
    properties: [prop("R", "Resistance", "10k", "Ω"), prop("POSITION", "Wiper position (0-1)", "0.5")],
    symbol: builtin("pot"), model: { kind: "builtin", builtin: "pot" },
  }),
];

const sources: ComponentDef[] = [
  part({
    id: "BATTERY", name: "DC voltage source", category: "source", description: "Ideal DC source.", refPrefix: "V",
    pins: [pin("P", "1", "passive", "top", "+"), pin("N", "2", "passive", "bottom", "-")],
    properties: [prop("VOLTAGE", "Voltage", "9", "V")], symbol: builtin("battery"),
    model: { kind: "spice", spice: "V1 P N DC {VOLTAGE}" },
  }),
  part({
    id: "VSINE", name: "Sine generator", category: "source", description: "Sinusoidal voltage source.", refPrefix: "V",
    pins: [pin("P", "1", "passive", "top", "+"), pin("N", "2", "passive", "bottom", "-")],
    properties: [prop("OFFSET", "Offset", "0", "V"), prop("AMPL", "Amplitude", "1", "V"), prop("FREQ", "Frequency", "1k", "Hz")],
    symbol: builtin("vsource"), model: { kind: "spice", spice: "V1 P N SIN({OFFSET} {AMPL} {FREQ})" },
  }),
  part({
    id: "VPULSE", name: "Pulse generator", category: "source", description: "Square/pulse voltage source.", refPrefix: "V",
    pins: [pin("P", "1", "passive", "top", "+"), pin("N", "2", "passive", "bottom", "-")],
    properties: [prop("V1", "Low", "0", "V"), prop("V2", "High", "5", "V"), prop("PW", "Pulse width", "500u", "s"), prop("PER", "Period", "1m", "s")],
    symbol: builtin("vsource"), model: { kind: "spice", spice: "V1 P N PULSE({V1} {V2} 0 1u 1u {PW} {PER})" },
  }),
  part({
    id: "DCLOCK", name: "Digital clock", category: "source", description: "Event-driven digital clock generator.", refPrefix: "CLK",
    pins: [pin("Q", "1", "output", "right")], properties: [prop("FREQ", "Frequency", "1k", "Hz")],
    symbol: builtin("clock"), model: { kind: "builtin", builtin: "clock" },
  }),
];

// --- semiconductors ----------------------------------------------------------

const diodePins = [pin("A", "1", "passive", "left"), pin("K", "2", "passive", "right")];
const led = (color: string, vf: string): ComponentDef => part({
  id: `LED-${color.toUpperCase()}`, name: `LED (${color})`, category: "indicator",
  description: `Animated ${color} LED. Brightness follows forward current.`, refPrefix: "D", pins: diodePins,
  properties: [prop("COLOR", "Colour", color), prop("VF", "Forward voltage", vf, "V"), prop("IF", "Rated current", "10m", "A"), prop("IMAX", "Max current", "30m", "A")],
  symbol: builtin("led"), model: { kind: "builtin", builtin: "led" },
});

const semis: ComponentDef[] = [
  part({
    id: "1N4148", name: "1N4148", category: "semiconductor", description: "Small-signal switching diode.", refPrefix: "D",
    manufacturer: "generic", pins: diodePins, properties: [], symbol: builtin("diode"),
    model: { kind: "spice", spice: "D1 A K D1N4148\n.model D1N4148 D(IS=2.52n N=1.752 RS=0.568 BV=100)" },
  }),
  part({
    id: "1N4733A", name: "1N4733A (5.1 V zener)", category: "semiconductor", description: "5.1 V zener diode.", refPrefix: "D",
    pins: diodePins, properties: [], symbol: builtin("zener"),
    model: { kind: "spice", spice: "D1 A K DZ\n.model DZ D(IS=1n N=1.5 RS=1 BV=5.1)" },
  }),
  led("red", "1.8"), led("green", "2.1"), led("yellow", "2.0"), led("blue", "3.0"),
  part({
    id: "2N2222", name: "2N2222 (NPN)", category: "semiconductor", description: "General-purpose NPN transistor.", refPrefix: "Q",
    pins: [pin("C", "1", "passive", "top"), pin("B", "2", "passive", "left"), pin("E", "3", "passive", "bottom")],
    properties: [], symbol: builtin("npn"), model: { kind: "spice", spice: "Q1 C B E Q2222\n.model Q2222 NPN(IS=14.34f BF=255.9 BR=6.092)" },
  }),
  part({
    id: "2N3906", name: "2N3906 (PNP)", category: "semiconductor", description: "General-purpose PNP transistor.", refPrefix: "Q",
    pins: [pin("C", "1", "passive", "bottom"), pin("B", "2", "passive", "left"), pin("E", "3", "passive", "top")],
    properties: [], symbol: builtin("pnp"), model: { kind: "spice", spice: "Q1 C B E Q3906\n.model Q3906 PNP(IS=1.41f BF=180.7 BR=4.977)" },
  }),
  part({
    id: "2N7000", name: "2N7000 (N-MOSFET)", category: "semiconductor", description: "Small-signal N-channel enhancement MOSFET.", refPrefix: "Q",
    pins: [pin("D", "1", "passive", "top"), pin("G", "2", "passive", "left"), pin("S", "3", "passive", "bottom")],
    properties: [], symbol: builtin("nmos"), model: { kind: "spice", spice: "M1 D G S M2N7000\n.model M2N7000 NMOS(VTO=2.1 KP=0.32 LAMBDA=0.01)" },
  }),
];

// --- analog ICs --------------------------------------------------------------

const analogIcs: ComponentDef[] = [
  part({
    id: "OPAMP", name: "Op-amp (ideal)", category: "analog-ic", description: "High-gain op-amp with rail clamping.", refPrefix: "U",
    pins: [pin("INP", "3", "analog", "left", "+"), pin("INN", "2", "analog", "left", "-"), pin("OUT", "6", "analog", "right"),
      pin("VP", "7", "power", "top", "V+"), pin("VN", "4", "power", "bottom", "V-")],
    properties: [prop("GAIN", "Open-loop gain", "100k")], symbol: builtin("opamp"),
    model: { kind: "spice", spice: "X1 INP INN OUT VP VN OPAMP(GAIN={GAIN} HEADROOM=0.05)" },
  }),
  part({
    id: "LM358", name: "LM358 dual op-amp", category: "analog-ic", manufacturer: "Texas Instruments",
    description: "Dual low-power op-amp. Output swings close to ground, ~1.5 V below V+.", refPrefix: "U",
    pins: [
      pin("OUT1", "1", "analog", "right", "1OUT"), pin("INN1", "2", "analog", "left", "1IN-"), pin("INP1", "3", "analog", "left", "1IN+"),
      pin("GND", "4", "power", "bottom"), pin("INP2", "5", "analog", "left", "2IN+"), pin("INN2", "6", "analog", "left", "2IN-"),
      pin("OUT2", "7", "analog", "right", "2OUT"), pin("VCC", "8", "power", "top"),
    ],
    properties: [], symbol: { kind: "box" },
    model: { kind: "spice", spice: "X1 INP1 INN1 OUT1 VCC GND OPAMP(GAIN=100k HEADROOM=0.75)\nX2 INP2 INN2 OUT2 VCC GND OPAMP(GAIN=100k HEADROOM=0.75)" },
  }),
  part({
    id: "NE555", name: "NE555 timer", category: "analog-ic", manufacturer: "Texas Instruments",
    description: "555 timer: SPICE divider plus behavioural comparators/flip-flop (mixed model).", refPrefix: "U",
    pins: [
      pin("GND", "1", "ground", "bottom"), pin("TRIG", "2", "analog", "left"), pin("OUT", "3", "output", "right"),
      pin("RESET", "4", "analog", "top", "~RESET"), pin("CTRL", "5", "analog", "left"), pin("THR", "6", "analog", "left"),
      pin("DIS", "7", "opendrain", "left"), pin("VCC", "8", "power", "top"),
    ],
    properties: [prop("VCC", "Supply (for output level)", "5", "V")], symbol: { kind: "box" },
    model: {
      kind: "mixed",
      spice: "R1 VCC CTRL 5k\nR2 CTRL n1 5k\nR3 n1 GND 5k\nR4 VCC RESET 100k",
      logic: `state q = 0
always {
  if (v(TRIG) < v(CTRL) / 2) q = 1
  else if (v(THR) > v(CTRL)) q = 0
  if (v(RESET) < 0.7) q = 0
  OUT = q
  DIS = q ? Z : 0
}`,
    },
    electrical: { supplyMin: 4.5, supplyMax: 16, outputResistance: 10 },
  }),
];

// --- 74HC logic ---------------------------------------------------------------

const hcElec = { supplyMin: 2, supplyMax: 6, vil: 1.35, vih: 3.15, outputResistance: 50, propagationDelay: 9e-9 };

function quadGate(id: string, name: string, op: string, invert: boolean): ComponentDef {
  const pins: PinDef[] = [];
  const nums = [[1, 2, 3], [4, 5, 6], [10, 9, 8], [13, 12, 11]];
  nums.forEach(([a, b, y], i) => {
    pins.push(pin(`A${i + 1}`, String(a), "input", "left", `${i + 1}A`));
    pins.push(pin(`B${i + 1}`, String(b), "input", "left", `${i + 1}B`));
    pins.push(pin(`Y${i + 1}`, String(y), "output", "right", `${i + 1}Y`));
  });
  pins.push(pin("GND", "7", "ground", "bottom"), pin("VCC", "14", "power", "top"));
  const lines = [1, 2, 3, 4].map((i) => `  Y${i} = ${invert ? "!" : ""}(A${i} ${op} B${i})`).join("\n");
  return part({
    id, name, category: "logic", manufacturer: "Nexperia", description: `${name}. Power pins are optional in simulation.`,
    refPrefix: "U", pins, properties: [], symbol: { kind: "box" }, electrical: hcElec,
    model: { kind: "logic", logic: `always {\n${lines}\n}` },
  });
}

const logic: ComponentDef[] = [
  quadGate("74HC00", "74HC00 quad 2-input NAND", "&&", true),
  quadGate("74HC08", "74HC08 quad 2-input AND", "&&", false),
  quadGate("74HC32", "74HC32 quad 2-input OR", "||", false),
  quadGate("74HC86", "74HC86 quad 2-input XOR", "^", false),
  part({
    id: "74HC04", name: "74HC04 hex inverter", category: "logic", manufacturer: "Nexperia", description: "Six inverters.", refPrefix: "U",
    pins: [
      ...[[1, 2], [3, 4], [5, 6], [9, 8], [11, 10], [13, 12]].flatMap(([a, y], i) => [
        pin(`A${i + 1}`, String(a), "input", "left", `${i + 1}A`), pin(`Y${i + 1}`, String(y), "output", "right", `${i + 1}Y`),
      ]),
      pin("GND", "7", "ground", "bottom"), pin("VCC", "14", "power", "top"),
    ],
    properties: [], symbol: { kind: "box" }, electrical: hcElec,
    model: { kind: "logic", logic: `always {\n${[1, 2, 3, 4, 5, 6].map((i) => `  Y${i} = !A${i}`).join("\n")}\n}` },
  }),
  part({
    id: "74HC74", name: "74HC74 dual D flip-flop", category: "logic", manufacturer: "Nexperia",
    description: "Dual positive-edge D flip-flop with active-low set and reset.", refPrefix: "U",
    pins: [
      pin("CLR1", "1", "input", "left", "~1RD"), pin("D1", "2", "input", "left", "1D"), pin("CLK1", "3", "input", "left", "1CP"),
      pin("PR1", "4", "input", "left", "~1SD"), pin("Q1", "5", "output", "right", "1Q"), pin("QN1", "6", "output", "right", "~1Q"),
      pin("GND", "7", "ground", "bottom"), pin("QN2", "8", "output", "right", "~2Q"), pin("Q2", "9", "output", "right", "2Q"),
      pin("PR2", "10", "input", "left", "~2SD"), pin("CLK2", "11", "input", "left", "2CP"), pin("D2", "12", "input", "left", "2D"),
      pin("CLR2", "13", "input", "left", "~2RD"), pin("VCC", "14", "power", "top"),
    ],
    properties: [], symbol: { kind: "box" }, electrical: hcElec,
    model: {
      kind: "logic",
      logic: `state q1 = 0
state q2 = 0
on rising(CLK1) { q1 = D1 }
on rising(CLK2) { q2 = D2 }
always {
  if (!CLR1) q1 = 0 else if (!PR1) q1 = 1
  if (!CLR2) q2 = 0 else if (!PR2) q2 = 1
  Q1 = q1
  QN1 = !q1
  Q2 = q2
  QN2 = !q2
}`,
    },
  }),
  part({
    id: "74HC595", name: "74HC595 shift register", category: "logic", manufacturer: "Nexperia",
    description: "8-bit serial-in, parallel-out shift register with output latch and tri-state outputs.", refPrefix: "U",
    pins: [
      pin("Q1", "1", "tristate", "right"), pin("Q2", "2", "tristate", "right"), pin("Q3", "3", "tristate", "right"),
      pin("Q4", "4", "tristate", "right"), pin("Q5", "5", "tristate", "right"), pin("Q6", "6", "tristate", "right"),
      pin("Q7", "7", "tristate", "right"), pin("GND", "8", "ground", "bottom"), pin("Q7S", "9", "output", "right"),
      pin("MR", "10", "input", "left", "~MR"), pin("SHCP", "11", "input", "left"), pin("STCP", "12", "input", "left"),
      pin("OE", "13", "input", "left", "~OE"), pin("DS", "14", "input", "left"), pin("Q0", "15", "tristate", "right"),
      pin("VCC", "16", "power", "top"),
    ],
    properties: [], symbol: { kind: "box" }, electrical: hcElec,
    model: {
      kind: "logic",
      logic: `state sr = 0
state latch = 0
on rising(SHCP) { sr = MR ? ((sr << 1) | DS) & 0xFF : 0 }
on rising(STCP) { latch = sr }
always {
  if (!MR) sr = 0
  bus(Q0..Q7) = OE ? Z : latch
  Q7S = bit(sr, 7)
}`,
    },
  }),
  part({
    id: "CD4017", name: "CD4017 decade counter", category: "logic", manufacturer: "Texas Instruments",
    description: "Decade counter with 10 decoded outputs.", refPrefix: "U",
    pins: [
      pin("Q5", "1", "output", "right"), pin("Q1", "2", "output", "right"), pin("Q0", "3", "output", "right"),
      pin("Q2", "4", "output", "right"), pin("Q6", "5", "output", "right"), pin("Q7", "6", "output", "right"),
      pin("Q3", "7", "output", "right"), pin("VSS", "8", "ground", "bottom"), pin("Q8", "9", "output", "right"),
      pin("Q4", "10", "output", "right"), pin("Q9", "11", "output", "right"), pin("CO", "12", "output", "right"),
      pin("CLKINH", "13", "input", "left", "CLK INH"), pin("CLK", "14", "input", "left"), pin("RST", "15", "input", "left"),
      pin("VDD", "16", "power", "top"),
    ],
    properties: [], symbol: { kind: "box" }, electrical: { propagationDelay: 100e-9 },
    model: {
      kind: "logic",
      logic: `state n = 0
on rising(CLK) { if (!CLKINH && !RST) n = (n + 1) % 10 }
always {
  if (RST) n = 0
  bus(Q0..Q9) = 1 << n
  CO = n < 5
}`,
    },
  }),
];

// --- microcontrollers ----------------------------------------------------------

const m328pins: [string, string, string, PinDef["type"], PinDef["side"], string[]?][] = [
  ["RESET", "1", "~RESET", "input", "left"],
  ["PD0", "2", "PD0/RXD", "bidir", "left", ["RXD", "PCINT16"]],
  ["PD1", "3", "PD1/TXD", "bidir", "left", ["TXD", "PCINT17"]],
  ["PD2", "4", "PD2/INT0", "bidir", "left", ["INT0", "PCINT18"]],
  ["PD3", "5", "PD3/INT1", "bidir", "left", ["INT1", "OC2B", "PCINT19"]],
  ["PD4", "6", "PD4", "bidir", "left", ["T0", "XCK", "PCINT20"]],
  ["VCC", "7", "VCC", "power", "top"],
  ["GND", "8", "GND", "ground", "bottom"],
  ["PB6", "9", "PB6/XTAL1", "bidir", "right", ["XTAL1", "PCINT6"]],
  ["PB7", "10", "PB7/XTAL2", "bidir", "right", ["XTAL2", "PCINT7"]],
  ["PD5", "11", "PD5/OC0B", "bidir", "left", ["OC0B", "T1", "PCINT21"]],
  ["PD6", "12", "PD6/OC0A", "bidir", "left", ["OC0A", "AIN0", "PCINT22"]],
  ["PD7", "13", "PD7", "bidir", "left", ["AIN1", "PCINT23"]],
  ["PB0", "14", "PB0", "bidir", "right", ["ICP1", "CLKO", "PCINT0"]],
  ["PB1", "15", "PB1/OC1A", "bidir", "right", ["OC1A", "PCINT1"]],
  ["PB2", "16", "PB2/OC1B", "bidir", "right", ["SS", "OC1B", "PCINT2"]],
  ["PB3", "17", "PB3/MOSI", "bidir", "right", ["MOSI", "OC2A", "PCINT3"]],
  ["PB4", "18", "PB4/MISO", "bidir", "right", ["MISO", "PCINT4"]],
  ["PB5", "19", "PB5/SCK", "bidir", "right", ["SCK", "PCINT5"]],
  ["AVCC", "20", "AVCC", "power", "top"],
  ["AREF", "21", "AREF", "analog", "top"],
  ["GND2", "22", "GND", "ground", "bottom"],
  ["PC0", "23", "PC0/ADC0", "bidir", "right", ["ADC0", "PCINT8"]],
  ["PC1", "24", "PC1/ADC1", "bidir", "right", ["ADC1", "PCINT9"]],
  ["PC2", "25", "PC2/ADC2", "bidir", "right", ["ADC2", "PCINT10"]],
  ["PC3", "26", "PC3/ADC3", "bidir", "right", ["ADC3", "PCINT11"]],
  ["PC4", "27", "PC4/SDA", "bidir", "right", ["ADC4", "SDA", "PCINT12"]],
  ["PC5", "28", "PC5/SCL", "bidir", "right", ["ADC5", "SCL", "PCINT13"]],
];

const mcus: ComponentDef[] = [
  part({
    id: "ATMEGA328P", name: "ATmega328P", category: "mcu", manufacturer: "Microchip",
    description: "8-bit AVR, 32 KB flash, 2 KB SRAM (Arduino Uno). Simulates GPIO, timers 0/1/2 incl. PWM, USART, ADC, INT0/1, PCINT, EEPROM.",
    refPrefix: "U",
    pins: m328pins.map(([id, number, name, type, side, functions]) => ({
      id, number, name, type, side: side!, ...(id.startsWith("P") && id.length === 3 ? { port: id } : {}),
      ...(functions ? { functions } : {}),
    })),
    properties: [
      prop("PROGRAM", "Program file", "", undefined, { kind: "file" }),
      prop("CLOCK", "Clock frequency", "16MHz", "Hz"),
      prop("VCC", "Supply voltage", "5", "V"),
    ],
    symbol: { kind: "box" },
    electrical: { supplyMin: 1.8, supplyMax: 5.5, vil: 1.5, vih: 3.0, outputResistance: 25, maxPinCurrent: 0.04, absMaxVoltage: 6 },
    model: { kind: "mcu", mcu: { core: "avr8", coreName: "AVR", variant: ATMEGA328P, defaultClockHz: 16e6 } },
  }),
];

// --- peripherals & instruments ---------------------------------------------------

const peripherals: ComponentDef[] = [
  part({
    id: "BUTTON", name: "Push button", category: "peripheral", description: "Momentary push button; click and hold while simulating.",
    refPrefix: "SW", pins: [pin("A", "1", "passive"), pin("B", "2", "passive", "right")], properties: [],
    symbol: builtin("button"), model: { kind: "builtin", builtin: "button" },
  }),
  part({
    id: "SWITCH", name: "Toggle switch (SPST)", category: "peripheral", description: "Click to toggle while simulating.",
    refPrefix: "SW", pins: [pin("A", "1", "passive"), pin("B", "2", "passive", "right")],
    properties: [prop("STATE", "Initial state", "open", undefined, { kind: "choice", choices: ["open", "closed"] })],
    symbol: builtin("switch"), model: { kind: "builtin", builtin: "switch" },
  }),
  part({
    id: "LOGICSTATE", name: "Logic state", category: "source", description: "Clickable digital source (0/1).", refPrefix: "L",
    pins: [pin("Q", "1", "output", "right")], properties: [prop("STATE", "Initial state", "0")],
    symbol: builtin("logicstate"), model: { kind: "builtin", builtin: "logicstate" },
  }),
  part({
    id: "LOGICPROBE", name: "Logic probe", category: "instrument", description: "Shows the digital level of a net.", refPrefix: "LP",
    pins: [pin("D", "1", "input", "left")], properties: [], symbol: builtin("logicprobe"),
    model: { kind: "builtin", builtin: "logicprobe" },
  }),
  part({
    id: "VTERM", name: "Virtual terminal", category: "instrument", description: "Serial terminal (8N1). Wire RXD to the MCU's TXD.",
    refPrefix: "TERM", pins: [pin("RXD", "1", "input", "left"), pin("TXD", "2", "output", "left")],
    properties: [prop("BAUD", "Baud rate", "9600")], symbol: builtin("vterm"), model: { kind: "builtin", builtin: "vterm" },
  }),
  part({
    id: "LCD1602", name: "LCD 16x2 (HD44780)", category: "peripheral", manufacturer: "Hitachi HD44780 compatible",
    description: "Character LCD with HD44780 controller, 4- or 8-bit interface.", refPrefix: "LCD",
    pins: [
      pin("VSS", "1", "ground", "bottom"), pin("VDD", "2", "power", "bottom"), pin("VEE", "3", "power", "bottom", "VO"),
      pin("RS", "4", "input", "bottom"), pin("RW", "5", "input", "bottom"), pin("E", "6", "input", "bottom"),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => pin(`D${i}`, String(7 + i), "bidir", "bottom")),
    ],
    properties: [prop("ROWS", "Rows", "2"), prop("COLS", "Columns", "16")],
    symbol: builtin("lcd"), model: { kind: "builtin", builtin: "hd44780" },
  }),
  ...(["cathode", "anode"] as const).map((t) => part({
    id: `7SEG-${t === "cathode" ? "CC" : "CA"}`, name: `7-segment (common ${t})`, category: "indicator" as const,
    description: `Seven-segment display, common ${t}. Segment inputs are logic-level.`, refPrefix: "DS",
    pins: [...["A", "B", "C", "D", "E", "F", "G", "DP"].map((s, i) => pin(s, String(i + 1), "input", "bottom")), pin("COM", "9", "passive", "top")],
    properties: [prop("TYPE", "Type", `common-${t}`)], symbol: builtin("sevenseg"), model: { kind: "builtin" as const, builtin: "sevenseg" },
  })),
  part({
    id: "VOLTMETER", name: "DC voltmeter", category: "instrument", description: "10 MΩ DC voltmeter.", refPrefix: "VM",
    pins: [pin("P", "1", "passive", "left", "+"), pin("N", "2", "passive", "right", "-")], properties: [],
    symbol: builtin("voltmeter"), model: { kind: "builtin", builtin: "voltmeter" },
  }),
  part({
    id: "AMMETER", name: "DC ammeter", category: "instrument", description: "Ideal series ammeter.", refPrefix: "AM",
    pins: [pin("P", "1", "passive", "left", "+"), pin("N", "2", "passive", "right", "-")], properties: [],
    symbol: builtin("ammeter"), model: { kind: "builtin", builtin: "ammeter" },
  }),
  part({
    id: "SCOPE", name: "Oscilloscope", category: "instrument", description: "4-channel oscilloscope (ground-referenced).", refPrefix: "OSC",
    pins: ["A", "B", "C", "D"].map((c, i) => pin(c, String(i + 1), "analog", "left")),
    properties: [prop("TIMEBASE", "Time window", "20m", "s")], symbol: builtin("scope"), model: { kind: "builtin", builtin: "scope" },
  }),
];

export const BUILTIN_LIBRARY: ComponentDef[] = [
  ...terminals, ...passives, ...sources, ...semis, ...analogIcs, ...logic, ...mcus, ...peripherals,
];

