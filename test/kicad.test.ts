import { describe, expect, it } from "vitest";
import type { ComponentDef } from "../src/shared/component";
import { BUILTIN_LIBRARY } from "../src/shared/library";
import { footprintFor } from "../src/shared/footprints";
import { kicadNetlist, refUuid } from "../src/shared/kicad";
import { PartInstance, Project, emptyProject, pinPositions } from "../src/shared/project";

const defs = new Map<string, ComponentDef>(BUILTIN_LIBRARY.map((d) => [d.id, d]));

/** Parts spaced far apart; `nets` ties pins together with net labels: { VCC: ["R1.A", "R2.A"] }. */
function schematic(parts: [ref: string, defId: string, props?: Record<string, string>][], nets: Record<string, string[]> = {}): Project {
  const p: Project = { ...emptyProject(), name: "board", parts: parts.map(([ref, defId, props = {}], i) => ({ ref, defId, x: i * 200, y: 0, rot: 0, props })) };
  let n = 0;
  for (const [name, pins] of Object.entries(nets)) {
    for (const pin of pins) {
      const [ref, id] = pin.split(".");
      const part = p.parts.find((q) => q.ref === ref)!;
      const tip = pinPositions(part, defs.get(part.defId)!).find((t) => t.id === id)!;
      const label: PartInstance = { ref: `LBL${++n}`, defId: "NETLABEL", x: 0, y: 0, rot: 0, props: { NAME: name } };
      const [own] = pinPositions(label, defs.get("NETLABEL")!);
      p.parts.push({ ...label, x: tip.x - own.x, y: tip.y - own.y });
    }
  }
  return p;
}

/** Nodes of one net as "REF.PAD". */
function netNodes(text: string, name: string): string[] {
  const block = text.split("(net (code").find((b) => b.includes(`(name "${name}")`)) ?? "";
  return [...block.matchAll(/\(node \(ref "([^"]+)"\) \(pin "([^"]+)"\)/g)].map((m) => `${m[1]}.${m[2]}`).sort();
}

describe("KiCad export", () => {
  it("picks footprints from the parts list's mount and size", () => {
    const p = schematic([["R1", "RES"], ["C1", "CAP"], ["U1", "NE555"]]);
    const tht = kicadNetlist(p, defs).parts.map((x) => x.footprint?.id);
    expect(tht).toEqual([
      "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal",
      "Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm",
      "Package_DIP:DIP-8_W7.62mm",
    ]);
    const smd = kicadNetlist({ ...p, bom: { mount: "smd", smdSize: "0603" } }, defs).parts.map((x) => x.footprint?.id);
    expect(smd).toEqual(["Resistor_SMD:R_0603_1608Metric", "Capacitor_SMD:C_0603_1608Metric", "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm"]);
  });

  it("maps pins to the footprint's pads", () => {
    const tht = { mount: "tht" as const, smdSize: "0805" as const };
    const p = schematic([["D1", "LED-RED"], ["Q1", "2N2222"], ["R1", "RES"]], {
      A: ["D1.A", "R1.A"], K: ["D1.K", "Q1.C"], B: ["Q1.B", "R1.B"], E: ["Q1.E"],
    });
    const { text } = kicadNetlist({ ...p, bom: tht }, defs);
    expect(netNodes(text, "A")).toEqual(["D1.2", "R1.1"]); // LED anode is pad 2
    expect(netNodes(text, "K")).toEqual(["D1.1", "Q1.3"]); // TO-92 is E-B-C
    expect(netNodes(text, "B")).toEqual(["Q1.2", "R1.2"]);
    const smd = kicadNetlist({ ...p, bom: { mount: "smd", smdSize: "0805" } }, defs).text;
    expect(netNodes(smd, "K")).toEqual(["D1.1", "Q1.3"]);
    expect(netNodes(smd, "B")).toEqual(["Q1.1", "R1.2"]); // SOT-23 is B-E-C
  });

  it("puts every ATmega328P TQFP supply pad on its net", () => {
    const fp = footprintFor(defs.get("ATMEGA328P")!, "TQFP-32")!;
    expect(fp.id).toBe("Package_QFP:TQFP-32_7x7mm_P0.8mm");
    expect(fp.pads.VCC).toEqual(["4", "6"]);
    const pads = Object.values(fp.pads).flat();
    expect(new Set(pads).size).toBe(pads.length);
    const p = schematic([["U1", "ATMEGA328P"]], { VCC: ["U1.VCC"] });
    const { text } = kicadNetlist({ ...p, bom: { mount: "smd", smdSize: "0805" } }, defs);
    expect(netNodes(text, "VCC")).toEqual(["U1.4", "U1.6"]);
  });

  it("leaves out simulation parts and warns about their nets", () => {
    const p = schematic([["R1", "RES"], ["V1", "BATTERY"], ["VM1", "VOLTMETER"]], { VCC: ["R1.A", "V1.P"], GND: ["R1.B", "V1.N"] });
    const out = kicadNetlist(p, defs);
    expect(out.parts.map((x) => x.ref)).toEqual(["R1"]);
    expect(netNodes(out.text, "VCC")).toEqual(["R1.1"]);
    expect(out.warnings.some((w) => w.startsWith("V1") && w.includes("VCC"))).toBe(true);
    expect(out.warnings.some((w) => w.includes("V1, VM1"))).toBe(true);
    expect(out.text).not.toContain('"V1"');
  });

  it("writes balanced s-expressions with stable ids and escaped strings", () => {
    const p = schematic([["R1", "RES"], ["SEG1", "7SEG-CC"]], { 'A"B': ["R1.A", "SEG1.A"] });
    const out = kicadNetlist(p, defs, "2026-10-16");
    let depth = 0, inStr = false;
    for (let i = 0; i < out.text.length; i++) {
      const c = out.text[i];
      if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "(") depth++;
      else if (c === ")") { depth--; expect(depth).toBeGreaterThanOrEqual(0); }
    }
    expect(depth).toBe(0);
    expect(out.text).toContain('(name "A\\"B")');
    expect(out.text).toContain(`(tstamps "${refUuid("board", "R1")}")`);
    expect(refUuid("board", "R1")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(refUuid("board", "R1")).not.toBe(refUuid("board", "R2"));
    expect(out.warnings.some((w) => w.startsWith("SEG1"))).toBe(true);
  });
});
