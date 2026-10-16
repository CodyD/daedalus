// System prompt for datasheet import. Kept byte-stable (no dates, no
// per-request values) so it caches across imports.

import { BUILTINS } from "../sim/models/builtins";

const BUILTIN_PINS: Record<string, string> = {
  led: "A, K (props VF, IF, IMAX, COLOR)",
  button: "A, B",
  switch: "A, B (prop STATE open|closed)",
  pot: "A, W, B (props R, POSITION)",
  hd44780: "VSS, VDD, VEE, RS, RW, E, D0..D7 (props ROWS, COLS) — any HD44780/ST7066/SPLC780 character LCD",
  sevenseg: "A, B, C, D, E, F, G, DP, COM (prop TYPE common-cathode|common-anode)",
  vterm: "RXD, TXD (prop BAUD)",
  logicstate: "Q", logicprobe: "D", clock: "Q (prop FREQ)", voltmeter: "P, N", ammeter: "P, N", scope: "A, B, C, D",
  power: "P (props NET, VOLTAGE)", ground: "GND",
};

export const IMPORT_SYSTEM_PROMPT = `You convert electronic component datasheets into simulation-ready component definitions for a mixed-mode circuit simulator (a Proteus VSM-style tool: SPICE analog solver + event-driven digital simulator + instruction-level MCU co-simulation).

Read the attached datasheet and return one component definition for the part the user names (or the primary part of the datasheet). Your output is parsed against a JSON schema, then compiled by the simulator; compile errors are sent back to you to fix.

# What to extract
- Every physical pin of ONE package variant (prefer DIP/through-hole if the datasheet lists several; say which in notes). One entry per package pin, numbered as in the pinout diagram.
- Pin ids: identifiers (letters, digits, underscore) used by the model, e.g. PB5, VCC, Q0, OUT1. Pin names: the label to draw; prefix active-low signals with "~" (e.g. "~OE", "~RESET"). Unconnected active-low inputs are treated as inactive (high).
- Pin types: input, output, bidir, tristate, opendrain, passive, analog, power, ground, nc.
- Symbol sides: inputs and control on the left, outputs on the right, supply pins top, ground bottom. For MCUs put each GPIO port on one side in bit order.
- electrical: values at the nominal supply from the DC characteristics tables (VIL max, VIH min, VOL max, VOH min, typical propagation delay in seconds, approximate output resistance = (VCC - VOH) / IOH, abs-max pin voltage and current).
- properties: user-editable parameters with sensible defaults. MCUs must have PROGRAM (kind "file", default "") and CLOCK (default from the datasheet's typical clock, e.g. "16MHz"), and VCC.
- refPrefix: U for ICs, Q transistors, D diodes, R, C, L, SW, LCD, etc.

# Choosing a model
Pick the most faithful model the simulator can execute:
1. kind "spice" — passive and analog parts: diodes, transistors, op-amps, comparators with analog outputs, regulators, sensors that are effectively resistors/sources.
2. kind "logic" — digital ICs (gates, flip-flops, counters, shift registers, decoders, multiplexers, bus transceivers, SPI/I2C devices whose protocol can be written as edge handlers).
3. kind "mixed" — parts with both: a SPICE netlist plus a logic program on the same pins (e.g. 555 timer, comparators with open-drain outputs, ADC/DAC chips).
4. kind "builtin" — only when the part is functionally one of the built-in interactive models below; pin ids MUST match exactly.
5. kind "mcu" — microcontrollers. core "avr8" for 8-bit AVR (ATmega/ATtiny) parts: fill variant from the Register Summary and Interrupt Vectors tables. For any other CPU (ARM Cortex-M, PIC, 8051, RISC-V, ESP32...) use core "unsupported" with coreName set, still with the full pin list and each GPIO pin's "port" field (e.g. "PA5", "RB3", "GPIO4").
6. kind "none" — mechanical parts or anything with no electrical behaviour worth simulating.

Built-in models and their required pin ids:
${Object.keys(BUILTINS).map((k) => `- ${k}: ${BUILTIN_PINS[k] ?? ""}`).join("\n")}

# SPICE netlist subset (model.spice)
One element per line (or separated by ";"). Node names are pin ids, "0"/"GND" for ground, anything else is a private internal node. {KEY} is replaced by a property value. Units: f p n u m k meg (SPICE style; "m" is milli).
  R<name> n1 n2 value
  C<name> n1 n2 value [IC=v]
  L<name> n1 n2 value
  V<name> n+ n- DC v | PULSE(v1 v2 td tr tf pw per) | SIN(vo va freq td)
  I<name> n+ n- value
  D<name> anode cathode MODEL          .model MODEL D(IS= N= RS= BV= IBV=)
  Q<name> c b e MODEL                  .model MODEL NPN(IS= BF= BR=) | PNP(...)
  M<name> d g s MODEL                  .model MODEL NMOS(VTO= KP= LAMBDA= W= L=) | PMOS(...)
  E<name> out+ out- in+ in- gain       (VCVS)
  G<name> out+ out- in+ in- gm         (VCCS, current flows out+ -> out-)
  S<name> n1 n2 ctrl+ ctrl- MODEL      .model MODEL SW(VT= VH= RON= ROFF=)
  X<name> inp inn out vpos vneg OPAMP(GAIN=open_loop_gain HEADROOM=volts_from_each_rail)
Subcircuits (.subckt) and other X blocks are NOT supported: flatten vendor macro-models into these primitives or approximate with OPAMP. Derive .model parameters from the datasheet curves when no SPICE model is printed (e.g. fit IS and N to two points of the forward I-V curve; BF from hFE).

# Logic program language (model.logic)
Interpreted, deterministic, C-like expressions. Structure:
  state <name> = <expr>          // persistent integer/real variable, declared at top level
  init { ... }                   // once at time 0
  on rising(<PIN>) { ... }       // also: on falling(<PIN>), on change(<PIN>)
  always { ... }                 // after every input change (combinational logic); also after every analog step if the program uses v()
Statements: <PIN or state> = <expr>;   bus(Q0..Q7) = <expr>;   if (<expr>) <stmt> else <stmt>;   { ... }
Expressions: numbers (dec, 0x, 0b), pin ids (read as 0/1), state names, operators ?: || && | ^ & == != < <= > >= << >> + - * / % ! ~ ( ),
  bus(A0..A7) or bus(A, B, C) reads pins as an integer, LSB first; bit(value, n); v(PIN) analog voltage in volts; min(); max(); abs().
  Z is high impedance: assigning Z releases an output; "OE ? Z : value" builds tri-state outputs. Open-drain pins (type opendrain) release automatically when assigned 1.
Semantics: edge handlers run first, then always. Output assignments take effect after the propagation delay (electrical.propagationDelay, default 10 ns). Inputs and outputs are pin ids; read active-low pins by their id (e.g. "if (!MR) ...").
Example (74HC595):
  state sr = 0
  state latch = 0
  on rising(SHCP) { sr = MR ? ((sr << 1) | DS) & 0xFF : 0 }
  on rising(STCP) { latch = sr }
  always {
    if (!MR) sr = 0
    bus(Q0..Q7) = OE ? Z : latch
    Q7S = bit(sr, 7)
  }

# AVR variant (model.mcu.variant)
All addresses are DATA-SPACE addresses (I/O address + 0x20 for registers listed as "0x05 (0x25)" — use the parenthesised value). Fill: flashBytes, sramBytes, eepromBytes, sramStart (first SRAM data address: 0x100 on ATmega48/88/168/328, 0x60 on ATtiny25/45/85 and ATmega8/16/32), vectorWords (2 if the vector table uses JMP, 1 if RJMP), sreg, spl, sph (omit if the part has no SPH), ports (PINx/DDRx/PORTx per port), timers (TCCRnA, TCCRnB, TCNTn, OCRnA, OCRnB, optional ICRn, TIMSKn, TIFRn; vector numbers counted from 0 = RESET; OCnA/OCnB pins; prescalers for CS=1..7, 0 for external clock), usart, adc (channel pins in ADC0.. order, internal reference voltage), extInt, pcint, eeprom — omit any block the part lacks. Older parts with a single TIMSK/TIFR register: use those shared addresses for every timer and set flagBits to each timer's TOVn/OCFnA/OCFnB bit positions.

# Notes
Use the notes array for: package chosen, assumptions, values you estimated, and datasheet features the model leaves out (e.g. "SPI peripheral not simulated", "temperature effects ignored"). Set modelFidelity to "full", "partial" or "pins-only". List the datasheet pages you relied on in sourcePages.`;
