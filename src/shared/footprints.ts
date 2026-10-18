// PCB footprints from the KiCad standard libraries.
//
// A footprint is picked from what the parts list already decided: the mount
// (through-hole or SMD), the chip size and the package. Each schematic pin
// lands on one or more pads; usually the pad is the pin's package number, but
// discrete semiconductors and some packages number pads their own way.

import type { ComponentDef, PinDef } from "./component";
import type { SmdSize } from "./project";

export interface Footprint {
  /** KiCad library id, "Library:Footprint". */
  id: string;
  /** Pads per pin id. */
  pads: Record<string, string[]>;
}

const METRIC: Record<SmdSize, string> = { "0402": "1005", "0603": "1608", "0805": "2012", "1206": "3216" };
const chip = (lib: string, prefix: string, size: string) =>
  `${lib}:${prefix}_${size}_${METRIC[size as SmdSize]}Metric`;
const isChip = (pkg: string): pkg is SmdSize => pkg in METRIC;

const SOIC: Record<number, string> = {
  8: "SOIC-8_3.9x4.9mm_P1.27mm",
  14: "SOIC-14_3.9x8.7mm_P1.27mm",
  16: "SOIC-16_3.9x9.9mm_P1.27mm",
};

/** Footprint by package name alone (ICs and discrete packages). */
function byPackage(pkg: string): string | null {
  let m = /^DIP-(\d+)$/.exec(pkg);
  if (m) return `Package_DIP:DIP-${m[1]}_W${Number(m[1]) >= 32 ? "15.24" : "7.62"}mm`;
  m = /^SOIC-(\d+)$/.exec(pkg);
  if (m) return SOIC[Number(m[1])] ? `Package_SO:${SOIC[Number(m[1])]}` : null;
  m = /^SIP-(\d+)$/.exec(pkg);
  if (m) return `Resistor_THT:R_Array_SIP${m[1]}`;
  switch (pkg) {
    case "TO-92": return "Package_TO_SOT_THT:TO-92_Inline";
    case "SOT-23": return "Package_TO_SOT_SMD:SOT-23";
    case "SOT-363": return "Package_TO_SOT_SMD:SOT-363_SC-70-6";
    case "SOD-123": return "Diode_SMD:D_SOD-123";
    case "DO-35": return "Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal";
    case "DO-41": return "Diode_THT:D_DO-41_SOD81_P10.16mm_Horizontal";
    case "TQFP-32": return "Package_QFP:TQFP-32_7x7mm_P0.8mm";
  }
  return null;
}

/** Footprint for parts whose package name alone doesn't say (passives, LEDs, switches). */
function byPart(def: ComponentDef, pkg: string): string | null {
  const smd = isChip(pkg);
  switch (def.id) {
    case "RES": return smd ? chip("Resistor_SMD", "R", pkg) : "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal";
    case "CAP": return smd ? chip("Capacitor_SMD", "C", pkg) : "Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm";
    case "IND": return smd ? chip("Inductor_SMD", "L", pkg) : "Inductor_THT:L_Axial_L5.3mm_D2.2mm_P10.16mm_Horizontal_Vishay_IM-1-1";
    case "CAP-ELEC": return pkg === "Radial" ? "Capacitor_THT:CP_Radial_D5.0mm_P2.00mm" : "Capacitor_SMD:CP_Elec_6.3x5.4";
    case "POT": return pkg === "THT" ? "Potentiometer_THT:Potentiometer_Bourns_3386P_Vertical" : "Potentiometer_SMD:Potentiometer_Bourns_3314J_Vertical";
    case "BUTTON": return pkg === "THT" ? "Button_Switch_THT:SW_PUSH_6mm" : "Button_Switch_SMD:SW_SPST_TL3342";
    // Toggle switches are panel mounted: the board gets a header for the leads.
    case "SWITCH": return "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical";
    case "LCD1602": return "Connector_PinHeader_2.54mm:PinHeader_1x16_P2.54mm_Vertical";
  }
  if (def.id.startsWith("LED-")) return smd ? chip("LED_SMD", "LED", pkg) : "LED_THT:LED_D5.0mm";
  return null;
}

// Pad numbers where they differ from the symbol's pin numbers.
// KiCad diode and LED footprints put the cathode on pad 1.
const DIODE = { K: ["1"], A: ["2"] };
const PADS: Record<string, Record<string, Record<string, string[]>>> = {
  // TO-92 is E-B-C for the bipolars and S-G-D for the 2N7000; SOT-23 is B-E-C / G-S-D.
  "2N2222": { "TO-92": { E: ["1"], B: ["2"], C: ["3"] }, "SOT-23": { B: ["1"], E: ["2"], C: ["3"] } },
  "2N3906": { "TO-92": { E: ["1"], B: ["2"], C: ["3"] }, "SOT-23": { B: ["1"], E: ["2"], C: ["3"] } },
  "2N7000": { "TO-92": { S: ["1"], G: ["2"], D: ["3"] }, "SOT-23": { G: ["1"], S: ["2"], D: ["3"] } },
  ATMEGA328P: {
    "TQFP-32": {
      RESET: ["29"], PD0: ["30"], PD1: ["31"], PD2: ["32"], PD3: ["1"], PD4: ["2"], VCC: ["4", "6"], GND: ["3", "5"],
      PB6: ["7"], PB7: ["8"], PD5: ["9"], PD6: ["10"], PD7: ["11"], PB0: ["12"], PB1: ["13"], PB2: ["14"],
      PB3: ["15"], PB4: ["16"], PB5: ["17"], AVCC: ["18"], AREF: ["20"], GND2: ["21"],
      PC0: ["23"], PC1: ["24"], PC2: ["25"], PC3: ["26"], PC4: ["27"], PC5: ["28"],
    },
  },
};

const isDiode = (def: ComponentDef) => ["1N4148", "1N4733A"].includes(def.id) || def.id.startsWith("LED-");

function padsFor(def: ComponentDef, pkg: string): Record<string, string[]> {
  const special = PADS[def.id]?.[pkg] ?? (isDiode(def) ? DIODE : null);
  const out: Record<string, string[]> = {};
  for (const p of def.pins as PinDef[]) out[p.id] = special?.[p.id] ?? [p.number];
  return out;
}

/**
 * Footprint for a part, given the package the parts list chose for it.
 * An explicit footprint on the part definition (set by datasheet import or by
 * hand) wins. Null when no standard footprint fits; assign one in KiCad.
 */
export function footprintFor(def: ComponentDef, pkg: string): Footprint | null {
  if (def.footprint) return { id: def.footprint, pads: padsFor(def, "") };
  // SMD resistor and capacitor arrays ("4×0805") have no entry: their pads run
  // around the body, not the way packages.ts numbers the pins.
  const id = byPart(def, pkg) ?? byPackage(pkg);
  return id ? { id, pads: padsFor(def, pkg) } : null;
}
