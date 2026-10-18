// Component library format.
//
// One schema describes every part: built-in passives, logic chips, MCUs,
// peripherals, and parts imported from a datasheet by Claude. Each part has a
// symbol, a pin list, editable properties, and a reference to a simulation
// model (`model`).

import { z } from "zod";

export const PinType = z.enum([
  "input",
  "output",
  "bidir",
  "tristate",
  "opendrain",
  "passive",
  "analog",
  "power",
  "ground",
  "nc",
]);
export type PinType = z.infer<typeof PinType>;

export const PinDef = z.object({
  id: z.string().describe("Identifier used by models, e.g. PB5, VCC, Q0. Letters, digits, underscore."),
  name: z.string().describe("Label drawn on the symbol, e.g. 'PB5 (SCK)'. Prefix with ~ for active-low."),
  number: z.string().describe("Physical package pin number, e.g. '19'."),
  type: PinType,
  side: z.enum(["left", "right", "top", "bottom"]).describe("Which side of the box symbol the pin sits on."),
  port: z.string().optional().describe("MCU GPIO port bit this pin maps to, e.g. 'PB5'. MCU parts, and emulated parts (port bit of the backing MCU, or DAC0..DAC3)."),
  functions: z.array(z.string()).optional().describe("Alternate functions, e.g. ['SCK', 'PCINT5']."),
});
export type PinDef = z.infer<typeof PinDef>;

export const PropertyDef = z.object({
  key: z.string(),
  label: z.string(),
  default: z.string(),
  unit: z.string().optional(),
  kind: z.enum(["number", "text", "file", "choice"]).optional(),
  choices: z.array(z.string()).optional(),
});
export type PropertyDef = z.infer<typeof PropertyDef>;

export const ElectricalChars = z.object({
  supplyMin: z.number().optional(),
  supplyMax: z.number().optional(),
  vil: z.number().optional().describe("Max input LOW voltage at nominal supply (V)."),
  vih: z.number().optional().describe("Min input HIGH voltage at nominal supply (V)."),
  vol: z.number().optional(),
  voh: z.number().optional(),
  outputResistance: z.number().optional().describe("Approximate output drive resistance (ohms)."),
  maxPinCurrent: z.number().optional().describe("Absolute max per-pin current (A)."),
  absMaxVoltage: z.number().optional().describe("Absolute max voltage on any pin (V)."),
  propagationDelay: z.number().optional().describe("Typical propagation delay (s)."),
});
export type ElectricalChars = z.infer<typeof ElectricalChars>;

// --- MCU description --------------------------------------------------------
// The AVR8 core is generic; a variant supplies memory sizes, the I/O register
// map and the interrupt vector table, which is what the datasheet's
// "Register Summary" and "Interrupt Vectors" tables contain.

export const AvrTimerConfig = z.object({
  name: z.string().describe("e.g. TIMER0"),
  bits: z.union([z.literal(8), z.literal(16)]),
  regs: z.object({
    TCCRA: z.number(),
    TCCRB: z.number(),
    TCNT: z.number().describe("Data address of TCNTn (low byte for 16-bit)."),
    OCRA: z.number(),
    OCRB: z.number(),
    ICR: z.number().optional(),
    TIMSK: z.number(),
    TIFR: z.number(),
  }),
  vectors: z.object({ ovf: z.number(), compa: z.number(), compb: z.number(), capt: z.number().optional() }),
  flagBits: z.object({ tov: z.number(), ocfa: z.number(), ocfb: z.number(), icf: z.number().optional() }).optional()
    .describe("Bit positions of this timer's flags in TIFR (and enables in TIMSK). Default tov=0, ocfa=1, ocfb=2, icf=5; differs on parts with a shared TIMSK."),
  ocPins: z.object({ a: z.string().optional(), b: z.string().optional() }).describe("Port bits for OCnA/OCnB, e.g. PD6."),
  prescalers: z.array(z.number()).describe("Divider for CS=1..7; 0 means external/unsupported."),
});

export const AvrVariant = z.object({
  flashBytes: z.number(),
  sramBytes: z.number(),
  eepromBytes: z.number(),
  sramStart: z.number().describe("Data address of first SRAM byte (0x100 on ATmega328P, 0x60 on ATtiny85)."),
  vectorWords: z.number().describe("Words per vector table entry: 2 on parts with JMP, 1 on small parts."),
  ports: z.array(z.object({ name: z.string(), pin: z.number(), ddr: z.number(), port: z.number() }))
    .describe("GPIO ports, data-space addresses of PINx/DDRx/PORTx."),
  sreg: z.number(),
  spl: z.number(),
  sph: z.number().optional(),
  timers: z.array(AvrTimerConfig),
  usart: z.object({
    UDR: z.number(), UCSRA: z.number(), UCSRB: z.number(), UCSRC: z.number(), UBRRL: z.number(), UBRRH: z.number(),
    rxPin: z.string(), txPin: z.string(),
    vectors: z.object({ rx: z.number(), udre: z.number(), tx: z.number() }),
  }).optional(),
  adc: z.object({
    ADCL: z.number(), ADCH: z.number(), ADCSRA: z.number(), ADCSRB: z.number(), ADMUX: z.number(),
    channels: z.array(z.string()).describe("Port bit for ADC0, ADC1, ..."),
    vector: z.number(),
    internalRef: z.number().describe("Internal bandgap reference voltage, e.g. 1.1"),
  }).optional(),
  extInt: z.object({
    EICRA: z.number(), EIMSK: z.number(), EIFR: z.number(),
    pins: z.array(z.string()).describe("Port bit for INT0, INT1, ..."),
    vectors: z.array(z.number()),
  }).optional(),
  pcint: z.object({
    PCICR: z.number(), PCIFR: z.number(),
    groups: z.array(z.object({ mask: z.number(), port: z.string(), vector: z.number() })),
  }).optional(),
  eeprom: z.object({ EECR: z.number(), EEDR: z.number(), EEARL: z.number(), EEARH: z.number().optional() }).optional(),
});
export type AvrVariant = z.infer<typeof AvrVariant>;
export type AvrTimerConfig = z.infer<typeof AvrTimerConfig>;

export const McuModel = z.object({
  core: z.enum(["avr8", "unsupported"]).describe("CPU core to execute firmware on. 'unsupported' = pin-accurate symbol only."),
  coreName: z.string().describe("Datasheet's name for the CPU architecture, e.g. 'AVR', 'ARM Cortex-M0+', 'PIC16'."),
  variant: AvrVariant.optional(),
  defaultClockHz: z.number(),
});
export type McuModel = z.infer<typeof McuModel>;

// --- Emulated parts ----------------------------------------------------------
// A sensor or module simulated by a hidden "backing" microcontroller (an AVR
// core the user never sees) running emulator firmware. The part's pins map to
// the backing MCU's port bits (so USART, timers and GPIO work as usual) or to
// virtual DAC outputs for analog signals. The user sets the sensed quantities
// (distance, temperature...) live from the part's emulator controls; the
// firmware reads them from reserved RAM. See sim/mcu/avr/emulator.ts.

export const EmulatorControl = z.object({
  key: z.string().describe("Upper-case identifier, e.g. DIST. Firmware reads it at the CTRL_<KEY> address."),
  label: z.string().describe("Shown next to the control, e.g. 'Distance'."),
  unit: z.string().optional().describe("Display unit, e.g. 'm', '°C'."),
  min: z.number(),
  max: z.number(),
  step: z.number().optional(),
  default: z.number(),
  scale: z.number().optional().describe("The firmware sees round(value * scale) as a signed 32-bit integer. Default 1. E.g. metres with scale 1000 gives millimetres."),
  kind: z.enum(["slider", "toggle"]).optional().describe("toggle: a 0/1 switch (min 0, max 1)."),
});
export type EmulatorControl = z.infer<typeof EmulatorControl>;

export const EmulatorDef = z.object({
  core: z.literal("avr8").describe("Backing MCU core: an ATmega328P-compatible AVR."),
  clockHz: z.number().describe("Backing MCU clock; pick one that divides the UART baud rate well, e.g. 18432000 for 115200 baud."),
  source: z.string().describe("Emulator firmware, AVR assembly (avrasm syntax, ATmega328P register names)."),
  controls: z.array(EmulatorControl).describe("Sensed quantities the user can set while simulating (at most 16)."),
});
export type EmulatorDef = z.infer<typeof EmulatorDef>;

export const ModelDef = z.object({
  kind: z.enum(["spice", "logic", "mixed", "builtin", "mcu", "emulator", "none"]),
  spice: z.string().optional().describe("SPICE-style primitive netlist; node names are pin ids, GND/0, or internal names. {KEY} substitutes a property."),
  logic: z.string().optional().describe("Behavioral logic program in the simulator's DSL."),
  builtin: z.string().optional(),
  mcu: McuModel.optional(),
  emulator: EmulatorDef.optional(),
});
export type ModelDef = z.infer<typeof ModelDef>;

export const SymbolDef = z.object({
  kind: z.enum(["box", "builtin"]),
  builtin: z.string().optional(),
});

export const ComponentDef = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum(["passive", "source", "semiconductor", "logic", "analog-ic", "mcu", "peripheral", "indicator", "instrument", "terminal", "misc"]),
  description: z.string(),
  manufacturer: z.string().optional(),
  refPrefix: z.string().describe("Reference designator prefix, e.g. U, R, C, D, Q."),
  pins: z.array(PinDef),
  properties: z.array(PropertyDef),
  symbol: SymbolDef,
  model: ModelDef,
  electrical: ElectricalChars.optional(),
  footprint: z.string().optional().describe("KiCad footprint for the package, as 'Library:Footprint' from the standard KiCad libraries, e.g. 'Package_DIP:DIP-8_W7.62mm' or 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm'. Pads are the pin numbers."),
  source: z.object({
    kind: z.enum(["builtin", "datasheet", "emulated"]),
    file: z.string().optional(),
    /** Full local path of the datasheet PDF it was imported from. */
    path: z.string().optional(),
    importedAt: z.string().optional(),
    notes: z.array(z.string()).optional(),
  }).optional(),
});
export type ComponentDef = z.infer<typeof ComponentDef>;

// --- Netlist handed from editor to simulator --------------------------------

export interface NetlistInstance {
  ref: string;
  def: ComponentDef;
  props: Record<string, string>;
  /** Contents of file-typed properties (e.g. firmware HEX), keyed by property. */
  files?: Record<string, string>;
}

export interface NetlistNet {
  name: string;
  ground: boolean;
  pins: { ref: string; pin: string }[];
}

export interface Netlist {
  instances: NetlistInstance[];
  nets: NetlistNet[];
}
