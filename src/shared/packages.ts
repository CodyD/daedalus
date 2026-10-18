// Multi-unit package parts made by Consolidate: resistor and capacitor
// arrays, dual diodes, dual transistors, dual/quad op-amps.
//
// A package's definition is generated from the part it replaces: one copy of
// the base SPICE model per unit, with node names mapped to the package's
// pins. The id encodes what it was made from (PACK-<kind>-<size>-<base id>),
// so the parts list can find the matching distributor part.

import type { ComponentDef, PinDef } from "./component";

export type PackKind =
  | "res-iso" | "res-bus" | "cap-iso"
  | "diode-cc" | "diode-ca" | "diode-series" | "diode-iso"
  | "dual" | "opamp";

export const PACK_INFO: Record<PackKind, { prefix: string; label: string; smdOnly?: boolean }> = {
  "res-iso": { prefix: "RN", label: "Resistor array, isolated" },
  "res-bus": { prefix: "RN", label: "Resistor network, bussed" },
  "cap-iso": { prefix: "CN", label: "Capacitor array", smdOnly: true },
  "diode-cc": { prefix: "D", label: "Dual diode, common cathode", smdOnly: true },
  "diode-ca": { prefix: "D", label: "Dual diode, common anode", smdOnly: true },
  "diode-series": { prefix: "D", label: "Dual diode, series", smdOnly: true },
  "diode-iso": { prefix: "D", label: "Dual diode, isolated", smdOnly: true },
  dual: { prefix: "Q", label: "Dual transistor", smdOnly: true },
  opamp: { prefix: "U", label: "Op-amp" },
};

const KINDS = Object.keys(PACK_INFO) as PackKind[];

export function packageId(kind: PackKind, size: number, baseId: string): string {
  return `PACK-${kind}-${size}-${baseId}`;
}

export function parsePackageId(id: string): { kind: PackKind; size: number; baseId: string } | null {
  const m = /^PACK-([a-z-]+?)-(\d+)-(.+)$/.exec(id);
  if (!m || !KINDS.includes(m[1] as PackKind)) return null;
  return { kind: m[1] as PackKind, size: Number(m[2]), baseId: m[3] };
}

/**
 * Package pin for each base-part pin, per unit, in the canonical orientation
 * (res-bus: A on the common pin; diode-series: unit 1's K meets unit 2's A).
 */
export function unitPins(kind: PackKind, size: number, base: ComponentDef): Record<string, string>[] {
  const units: Record<string, string>[] = [];
  for (let i = 1; i <= size; i++) {
    switch (kind) {
      case "res-iso": case "cap-iso": case "diode-iso": {
        const [a, b] = base.pins.map((p) => p.id);
        units.push({ [a]: `${a}${i}`, [b]: `${b}${i}` });
        break;
      }
      case "res-bus": units.push({ A: "COM", B: `P${i}` }); break;
      case "diode-cc": units.push({ A: `A${i}`, K: "K" }); break;
      case "diode-ca": units.push({ A: "A", K: `K${i}` }); break;
      case "diode-series": units.push(i === 1 ? { A: "A", K: "M" } : { A: "M", K: "K" }); break;
      case "dual": units.push(Object.fromEntries(base.pins.map((p) => [p.id, `${p.id}${i}`]))); break;
      case "opamp": units.push({ INP: `INP${i}`, INN: `INN${i}`, OUT: `OUT${i}`, VP: "VP", VN: "VN" }); break;
    }
  }
  return units;
}

// Pin numbers follow the usual packages: LM358 / LM324, BAV70 / BAW56 / BAV99
// (SOT-23), MMDT-style SOT-363 duals, SIP networks with pin 1 common.
const LM358: Record<string, string> = { OUT1: "1", INN1: "2", INP1: "3", VN: "4", INP2: "5", INN2: "6", OUT2: "7", VP: "8" };
const LM324: Record<string, string> = {
  OUT1: "1", INN1: "2", INP1: "3", VP: "4", INP2: "5", INN2: "6", OUT2: "7",
  OUT3: "8", INN3: "9", INP3: "10", VN: "11", INP4: "12", INN4: "13", OUT4: "14",
};

function pinsFor(kind: PackKind, size: number, base: ComponentDef): PinDef[] {
  const pin = (id: string, number: string, side: PinDef["side"], name: string, type: PinDef["type"] = "passive"): PinDef => ({ id, number, type, side, name });
  const out: PinDef[] = [];
  switch (kind) {
    case "res-iso": case "cap-iso": {
      const letter = kind === "res-iso" ? "R" : "C";
      for (let i = 1; i <= size; i++) out.push(pin(`A${i}`, String(2 * i - 1), "left", `${letter}${i}`));
      for (let i = 1; i <= size; i++) out.push(pin(`B${i}`, String(2 * i), "right", `${letter}${i}`));
      break;
    }
    case "res-bus":
      out.push(pin("COM", "1", "left", "COM"));
      for (let i = 1; i <= size; i++) out.push(pin(`P${i}`, String(i + 1), "right", `R${i}`));
      break;
    case "diode-cc": out.push(pin("A1", "1", "left", "A1"), pin("A2", "2", "left", "A2"), pin("K", "3", "right", "K")); break;
    case "diode-ca": out.push(pin("A", "3", "left", "A"), pin("K1", "1", "right", "K1"), pin("K2", "2", "right", "K2")); break;
    case "diode-series": out.push(pin("A", "1", "left", "A"), pin("M", "3", "right", "K/A"), pin("K", "2", "right", "K")); break;
    case "diode-iso":
      out.push(pin("A1", "1", "left", "A1"), pin("A2", "3", "left", "A2"), pin("K1", "2", "right", "K1"), pin("K2", "4", "right", "K2"));
      break;
    case "dual": {
      // Base pins are [collector/drain, base/gate, emitter/source].
      const nums = [["6", "2", "1"], ["3", "5", "4"]];
      for (let i = 1; i <= size; i++) {
        base.pins.forEach((p, k) => out.push(pin(`${p.id}${i}`, nums[i - 1]?.[k] ?? "?", k === 1 ? "left" : "right", `${p.name}${i}`)));
      }
      break;
    }
    case "opamp": {
      const nums = size === 4 ? LM324 : LM358;
      for (let i = 1; i <= size; i++) {
        out.push(pin(`INN${i}`, nums[`INN${i}`], "left", `${i}IN-`, "analog"), pin(`INP${i}`, nums[`INP${i}`], "left", `${i}IN+`, "analog"));
      }
      for (let i = 1; i <= size; i++) out.push(pin(`OUT${i}`, nums[`OUT${i}`], "right", `${i}OUT`, "analog"));
      out.push(pin("VP", nums.VP, "top", "V+", "power"), pin("VN", nums.VN, "bottom", "V-", "power"));
      break;
    }
  }
  return out;
}

/** One copy of the base model per unit, nodes renamed to package pins; .model cards once. */
function unitSpice(base: ComponentDef, units: Record<string, string>[]): string {
  const src = base.model.spice ?? "";
  const lines = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const cards = lines.filter((l) => l.toLowerCase().startsWith(".model"));
  const elems = lines.filter((l) => !l.toLowerCase().startsWith(".model"));
  const out: string[] = [];
  units.forEach((map, i) => {
    for (const l of elems) {
      const [name, ...rest] = l.split(/\s+/);
      out.push([`${name}_${i + 1}`, ...rest.map((t) => map[t] ?? t)].join(" "));
    }
  });
  return [...out, ...cards].join("\n");
}

const CATEGORY: Record<PackKind, ComponentDef["category"]> = {
  "res-iso": "passive", "res-bus": "passive", "cap-iso": "passive",
  "diode-cc": "semiconductor", "diode-ca": "semiconductor", "diode-series": "semiconductor", "diode-iso": "semiconductor",
  dual: "semiconductor", opamp: "analog-ic",
};

export function packageDef(kind: PackKind, size: number, base: ComponentDef): ComponentDef {
  const what = kind === "opamp" ? (size === 4 ? "Quad op-amp" : "Dual op-amp")
    : kind === "dual" ? `Dual ${base.name.split(" ")[0]}` : `${PACK_INFO[kind].label} (${size})`;
  return {
    id: packageId(kind, size, base.id),
    name: what,
    category: CATEGORY[kind],
    description: `${what}: ${size} × ${base.name} in one package, made by Consolidate.`,
    refPrefix: PACK_INFO[kind].prefix,
    pins: pinsFor(kind, size, base),
    properties: base.properties,
    symbol: { kind: "box" },
    model: { kind: "spice", spice: unitSpice(base, unitPins(kind, size, base)) },
    ...(base.electrical ? { electrical: base.electrical } : {}),
    source: { kind: "builtin", notes: [`Generated from ${base.id} by Consolidate.`] },
  };
}
