// KiCad netlist export, for laying out the board in KiCad's PCB editor
// (File > Import > Netlist, or "Update PCB from Schematic" style import).
//
// Only parts that go on the board are written: the same set the parts list
// buys, with the mount and package it chose. Simulation-only parts (sources,
// instruments, terminals) are left out; power and ground symbols and net
// labels still name the nets they join.

import type { ComponentDef, PinType } from "./component";
import { buildBom, isPurchasable } from "./bom";
import { Footprint, footprintFor } from "./footprints";
import { Project, buildNetlist } from "./project";

type Defs = Map<string, ComponentDef>;

export interface KicadPart {
  ref: string;
  value: string;
  package: string;
  footprint: Footprint | null;
}

export interface KicadExport {
  text: string;
  parts: KicadPart[];
  nets: number;
  warnings: string[];
}

const PIN_TYPE: Record<PinType, string> = {
  input: "input", output: "output", bidir: "bidirectional", tristate: "tri_state", opendrain: "open_collector",
  passive: "passive", analog: "passive", power: "power_in", ground: "power_in", nc: "no_connect",
};

const str = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Stable UUID per reference, so re-importing updates footprints instead of adding new ones. */
export function refUuid(project: string, ref: string): string {
  let h = "";
  for (let seed = 0; seed < 4; seed++) {
    let x = 0x811c9dc5 ^ seed;
    for (const c of `${project}\0${ref}`) x = Math.imul(x ^ c.charCodeAt(0), 0x01000193);
    h += (x >>> 0).toString(16).padStart(8, "0");
  }
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function kicadNetlist(project: Project, defs: Defs, date = new Date().toISOString()): KicadExport {
  const warnings: string[] = [];
  const lines = buildBom(project, defs);
  const lineOf = new Map(lines.flatMap((l) => l.refs.map((r) => [r, l] as const)));

  const parts: KicadPart[] = [];
  const onBoard = new Map<string, { def: ComponentDef; fp: Footprint | null }>();
  for (const part of project.parts) {
    const def = defs.get(part.defId);
    const line = lineOf.get(part.ref);
    if (!def || !line) continue;
    const fp = footprintFor(def, line.package);
    if (!fp) warnings.push(`${part.ref} (${def.name}${line.package ? `, ${line.package}` : ""}): no standard footprint; assign one in KiCad.`);
    parts.push({ ref: part.ref, value: line.value || def.name, package: line.package, footprint: fp });
    onBoard.set(part.ref, { def, fp });
  }

  const { netlist } = buildNetlist(project, defs);
  const nets: string[] = [];
  const sources = new Set<string>();
  for (const net of netlist.nets) {
    const nodes: string[] = [];
    for (const { ref, pin } of net.pins) {
      const b = onBoard.get(ref);
      if (!b) continue;
      const type = PIN_TYPE[b.def.pins.find((p) => p.id === pin)?.type ?? "passive"];
      const pads = b.fp?.pads[pin] ?? [b.def.pins.find((p) => p.id === pin)?.number ?? pin];
      for (const pad of pads) nodes.push(`      (node (ref ${str(ref)}) (pin ${str(pad)}) (pintype ${str(type)}))`);
    }
    if (!nodes.length) continue;
    // A simulated supply or signal feeding the board needs a real way in.
    for (const { ref } of net.pins) {
      const inst = netlist.instances.find((i) => i.ref === ref);
      if (inst?.def.category === "source" && !net.ground) sources.add(`${ref} (${inst.def.name}) drives net ${net.name}; add a connector or supply for it on the board.`);
    }
    nets.push(`    (net (code ${str(String(nets.length + 1))}) (name ${str(net.name)})\n${nodes.join("\n")})`);
  }
  warnings.push(...sources);
  const unused = project.parts.filter((p) => { const d = defs.get(p.defId); return d && !isPurchasable(d) && d.category !== "terminal"; });
  if (unused.length) warnings.push(`Left out (simulation only): ${unused.map((p) => p.ref).join(", ")}.`);

  const comps = parts.map((p) => {
    const def = onBoard.get(p.ref)!.def;
    return [
      `    (comp (ref ${str(p.ref)})`,
      `      (value ${str(p.value)})`,
      ...(p.footprint ? [`      (footprint ${str(p.footprint.id)})`] : []),
      `      (description ${str(def.description)})`,
      `      (libsource (lib "daedalus") (part ${str(def.id)}) (description ${str(def.name)}))`,
      `      (sheetpath (names "/") (tstamps "/"))`,
      `      (tstamps ${str(refUuid(project.name, p.ref))}))`,
    ].join("\n");
  });

  const text = [
    `(export (version "E")`,
    `  (design`,
    `    (source ${str(`${project.name || "Untitled"}.dad`)})`,
    `    (date ${str(date)})`,
    `    (tool "Daedalus"))`,
    `  (components`,
    ...comps,
    `  )`,
    `  (nets`,
    ...nets,
    `  )`,
    `)`,
    ``,
  ].join("\n");
  return { text, parts, nets: nets.length, warnings };
}
