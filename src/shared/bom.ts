// Parts list (bill of materials) with distributor search strings.
//
// Each schematic part maps to something buyable: a search string for Mouser
// and DigiKey keyword search, chosen for through-hole or surface-mount
// assembly. Package parts made by Consolidate (packages.ts) map to arrays,
// duals and quads. Stimulus sources, instruments and terminals exist only for
// simulation and are left out.

import type { ComponentDef } from "./component";
import type { BomSettings, Mount, PartInstance, Project, SmdSize } from "./project";
import { PACK_INFO, PackKind, parsePackageId } from "./packages";
import { formatValue, parseValue } from "../sim/units";

type Defs = Map<string, ComponentDef>;

export const DEFAULT_BOM: BomSettings = { mount: "tht", smdSize: "0805" };
export const SMD_SIZES: SmdSize[] = ["0402", "0603", "0805", "1206"];

export interface BomLine {
  /** Stable identity for per-line overrides. */
  key: string;
  refs: string[];
  qty: number;
  name: string;
  /** Display value, e.g. "10kΩ"; empty for parts without one. */
  value: string;
  /** null: the part comes one way only (modules, displays, imported parts). */
  mount: Mount | null;
  /** The part comes in both through-hole and surface-mount versions. */
  choice: boolean;
  /** Mount was chosen for this line rather than taken from the project setting. */
  mountOverride: boolean;
  package: string;
  /** Search string sent to the distributors (override or automatic). */
  query: string;
  autoQuery: string;
}

/** Purchase-relevant property per part; other properties (clock, program...) don't split lines. */
const VALUE_PROP: Record<string, { key: string; unit: string; word: string }> = {
  RES: { key: "R", unit: "Ω", word: " ohm" },
  POT: { key: "R", unit: "Ω", word: " ohm" },
  CAP: { key: "C", unit: "F", word: "F" },
  "CAP-ELEC": { key: "C", unit: "F", word: "F" },
  IND: { key: "L", unit: "H", word: "H" },
};

const SIM_ONLY = new Set<ComponentDef["category"]>(["terminal", "instrument", "source"]);

export function isPurchasable(def: ComponentDef): boolean {
  return !SIM_ONLY.has(def.category);
}

/** Value property of the part, or of the part a package was made from. */
function valueProp(def: ComponentDef) {
  return VALUE_PROP[def.id] ?? VALUE_PROP[parsePackageId(def.id)?.baseId ?? ""];
}

function rawValue(part: PartInstance, def: ComponentDef): string | null {
  const vp = valueProp(def);
  if (!vp) return null;
  return part.props[vp.key] ?? def.properties.find((p) => p.key === vp.key)?.default ?? null;
}

/** Normalised value so "10k", "10000" and "10K" land on one line. */
export function valueKey(part: PartInstance, def: ComponentDef): string {
  const raw = rawValue(part, def);
  if (raw === null) return "";
  const v = parseValue(raw);
  return isFinite(v) ? String(+v.toPrecision(6)) : raw.trim().toLowerCase();
}

function displayValue(part: PartInstance, def: ComponentDef): string {
  const raw = rawValue(part, def);
  if (raw === null) return "";
  const v = parseValue(raw);
  return isFinite(v) ? formatValue(v, valueProp(def).unit) : raw;
}

/** Value as distributors' search understands it: ASCII prefixes and a unit word. */
function searchValue(part: PartInstance, def: ComponentDef): string {
  const raw = rawValue(part, def);
  if (raw === null) return "";
  const v = parseValue(raw);
  const s = isFinite(v) ? formatValue(v, "").replace("µ", "u") : raw;
  return s + valueProp(def).word;
}

interface Catalog { pkg: string; q: string }
type Entry = (v: string, mount: Mount, size: SmdSize, def: ComponentDef, part: PartInstance) => Catalog | null;

const both = (q: string, pkg = ""): Entry => () => ({ q, pkg });
const byMount = (tht: Catalog, smd: Catalog): Entry => (_v, m) => (m === "tht" ? tht : smd);

const CATALOG: Record<string, Entry> = {
  RES: (v, m, s) => m === "tht" ? { q: `${v} resistor 1/4W axial through hole`, pkg: "Axial" } : { q: `${v} resistor ${s}`, pkg: s },
  CAP: (v, m, s) => m === "tht" ? { q: `${v} ceramic capacitor radial through hole`, pkg: "Radial" } : { q: `${v} ceramic capacitor ${s}`, pkg: s },
  "CAP-ELEC": (v, m) => m === "tht" ? { q: `${v} aluminum electrolytic capacitor radial`, pkg: "Radial" } : { q: `${v} aluminum electrolytic capacitor SMD`, pkg: "SMD can" },
  IND: (v, m, s) => m === "tht" ? { q: `${v} inductor axial through hole`, pkg: "Axial" } : { q: `${v} inductor ${s}`, pkg: s },
  POT: (v, m) => m === "tht" ? { q: `${v} potentiometer through hole`, pkg: "THT" } : { q: `${v} trimmer potentiometer SMD`, pkg: "SMD trimmer" },
  "1N4148": byMount({ q: "1N4148", pkg: "DO-35" }, { q: "1N4148W SOD-123", pkg: "SOD-123" }),
  "1N4733A": byMount({ q: "1N4733A", pkg: "DO-41" }, { q: "5.1V zener diode SOD-123", pkg: "SOD-123" }),
  "2N2222": byMount({ q: "2N2222A TO-92", pkg: "TO-92" }, { q: "MMBT2222A SOT-23", pkg: "SOT-23" }),
  "2N3906": byMount({ q: "2N3906 TO-92", pkg: "TO-92" }, { q: "MMBT3906 SOT-23", pkg: "SOT-23" }),
  "2N7000": byMount({ q: "2N7000 TO-92", pkg: "TO-92" }, { q: "2N7002 SOT-23", pkg: "SOT-23" }),
  OPAMP: byMount({ q: "general purpose op amp single DIP-8", pkg: "DIP-8" }, { q: "general purpose op amp single SOIC-8", pkg: "SOIC-8" }),
  LM358: byMount({ q: "LM358P", pkg: "DIP-8" }, { q: "LM358DR", pkg: "SOIC-8" }),
  NE555: byMount({ q: "NE555P", pkg: "DIP-8" }, { q: "NE555DR", pkg: "SOIC-8" }),
  CD4017: byMount({ q: "CD4017BE", pkg: "DIP-16" }, { q: "CD4017BM96", pkg: "SOIC-16" }),
  ATMEGA328P: byMount({ q: "ATMEGA328P-PU", pkg: "DIP-28" }, { q: "ATMEGA328P-AU", pkg: "TQFP-32" }),
  BUTTON: byMount({ q: "6mm tactile switch through hole", pkg: "THT" }, { q: "tactile switch SMD", pkg: "SMD" }),
  SWITCH: byMount({ q: "SPST toggle switch", pkg: "THT" }, { q: "SPST slide switch SMD", pkg: "SMD" }),
  LCD1602: both("16x2 character LCD module HD44780", "Module"),
};
for (const t of ["CC", "CA"]) {
  const kind = t === "CC" ? "common cathode" : "common anode";
  CATALOG[`7SEG-${t}`] = byMount({ q: `7 segment display ${kind} 0.56 inch`, pkg: "THT" }, { q: `7 segment display ${kind} SMD`, pkg: "SMD" });
}

function catalogFor(def: ComponentDef): Entry | null {
  const pk = parsePackageId(def.id);
  if (pk) return (v, m, s) => packCatalog(pk.kind, pk.size, pk.baseId, v, m, s);
  const known = CATALOG[def.id];
  if (known) return known;
  if (def.id.startsWith("LED-")) {
    const color = def.id.slice(4).toLowerCase();
    return (_v, m, s) => m === "tht" ? { q: `${color} LED 5mm through hole`, pkg: "5 mm" } : { q: `${color} LED ${s}`, pkg: s };
  }
  // Nexperia 74HC parts: N suffix is DIP, D is SO.
  if (/^74HC\d+$/.test(def.id)) {
    const pins = def.pins.length;
    return byMount({ q: `${def.id}N`, pkg: `DIP-${pins}` }, { q: `${def.id}D`, pkg: `SOIC-${pins}` });
  }
  return null;
}

/** Whether this part has both a through-hole and a surface-mount version in the catalog. */
export function hasMountChoice(def: ComponentDef): boolean {
  const e = catalogFor(def);
  if (!e) return false;
  const p = { ref: "", defId: def.id, x: 0, y: 0, rot: 0 as const, props: {} };
  return e("", "tht", "0805", def, p)?.q !== e("", "smd", "0805", def, p)?.q;
}

// --- packages ------------------------------------------------------------------

const DUAL_Q: Record<string, Catalog> = {
  "2N2222": { q: "MMDT2222A SOT-363", pkg: "SOT-363" },
  "2N3906": { q: "MMDT3906 SOT-363", pkg: "SOT-363" },
  "2N7000": { q: "2N7002DW SOT-363", pkg: "SOT-363" },
};

function packCatalog(kind: PackKind, n: number, baseId: string, v: string, mount: Mount, size: SmdSize): Catalog {
  const tht = mount === "tht" && !PACK_INFO[kind].smdOnly;
  switch (kind) {
    case "res-iso":
      return tht ? { q: `${v} resistor network isolated ${n} resistors SIP-${n * 2}`, pkg: `SIP-${n * 2}` }
        : { q: `${v} resistor array ${n} element isolated ${size}`, pkg: `${n}×${size}` };
    case "res-bus":
      return tht ? { q: `${v} resistor network bussed ${n} resistors SIP-${n + 1}`, pkg: `SIP-${n + 1}` }
        : { q: `${v} resistor array bussed ${n} element SMD`, pkg: `${n}-element SMD` };
    case "cap-iso": return { q: `${v} capacitor array ${n} element ${size}`, pkg: `${n}×${size}` };
    case "diode-cc": return { q: "BAV70 SOT-23", pkg: "SOT-23" };
    case "diode-ca": return { q: "BAW56 SOT-23", pkg: "SOT-23" };
    case "diode-series": return { q: "BAV99 SOT-23", pkg: "SOT-23" };
    case "diode-iso": return { q: "dual switching diode isolated SOT-363", pkg: "SOT-363" };
    case "dual": return DUAL_Q[baseId] ?? { q: `dual ${baseId} SOT-363`, pkg: "SOT-363" };
    case "opamp":
      return n === 4 ? (tht ? { q: "LM324N", pkg: "DIP-14" } : { q: "LM324DR", pkg: "SOIC-14" })
        : (tht ? { q: "LM358P", pkg: "DIP-8" } : { q: "LM358DR", pkg: "SOIC-8" });
  }
}

// --- the list --------------------------------------------------------------------

export function bomSettings(project: Project): BomSettings {
  return { ...DEFAULT_BOM, ...project.bom };
}

const refOrder = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

export function buildBom(project: Project, defs: Defs): BomLine[] {
  const s = bomSettings(project);
  const lines = new Map<string, BomLine>();
  const finish = (key: string, choice: boolean, auto: Catalog | null, base: Omit<BomLine, "key" | "query" | "autoQuery" | "package" | "mountOverride" | "qty" | "choice">, ref: string, overridden: boolean) => {
    let line = lines.get(key);
    if (!line) {
      const autoQuery = auto?.q ?? base.name;
      line = { ...base, key, refs: [], qty: 0, package: auto?.pkg ?? "", autoQuery, query: s.lines?.[key]?.query || autoQuery, mountOverride: overridden, choice };
      lines.set(key, line);
    }
    line.refs.push(ref);
    line.qty++;
  };

  for (const part of project.parts) {
    const def = defs.get(part.defId);
    if (!def || !isPurchasable(def)) continue;
    const entry = catalogFor(def);
    const baseKey = `${def.id}|${valueKey(part, def)}`;
    const choice = entry ? hasMountChoice(def) : false;
    const over = s.lines?.[baseKey]?.mount;
    const smdOnly = PACK_INFO[parsePackageId(def.id)?.kind as PackKind]?.smdOnly;
    const mount: Mount | null = choice ? over ?? s.mount : smdOnly ? "smd" : null;
    // Keyed without the mount, so a per-line mount override sticks when the project setting changes.
    const auto = entry ? entry(searchValue(part, def), mount ?? s.mount, s.smdSize, def, part) : null;
    const name = def.manufacturer && def.source?.kind !== "builtin" ? `${def.name} (${def.manufacturer})` : def.name;
    finish(baseKey, choice, auto, { refs: [], name, value: displayValue(part, def), mount }, part.ref, !!over && choice);
  }

  const out = [...lines.values()];
  for (const l of out) l.refs.sort(refOrder);
  return out.sort((a, b) => refOrder(a.refs[0], b.refs[0]));
}

export const mouserUrl = (q: string) => `https://www.mouser.com/c/?q=${encodeURIComponent(q)}`;
export const digikeyUrl = (q: string) => `https://www.digikey.com/en/products/result?keywords=${encodeURIComponent(q)}`;

export function bomCsv(lines: BomLine[]): string {
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [["Qty", "References", "Part", "Value", "Mount", "Package", "Search", "Mouser", "DigiKey"]];
  for (const l of lines) {
    rows.push([String(l.qty), l.refs.join(" "), l.name, l.value, l.mount?.toUpperCase() ?? "", l.package,
      l.query, mouserUrl(l.query), digikeyUrl(l.query)]);
  }
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
