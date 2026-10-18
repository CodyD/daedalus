import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ComponentDef } from "../src/shared/component";
import { BUILTIN_LIBRARY } from "../src/shared/library";
import { bomCsv, buildBom, digikeyUrl, mouserUrl } from "../src/shared/bom";
import { consolidate, findConsolidations } from "../src/shared/consolidate";
import { connect, isTerminal } from "../src/shared/edit";
import { parsePackageId } from "../src/shared/packages";
import { PartInstance, Project, Wire, buildNetlist, emptyProject, pinPositions } from "../src/shared/project";
import { Simulator } from "../src/sim/engine";
import { createModel } from "../src/sim/models";

const defs = new Map<string, ComponentDef>(BUILTIN_LIBRARY.map((d) => [d.id, d]));
const ROOT = join(__dirname, "..");

/** Parts spaced far apart; `nets` ties pins together with net labels: { VCC: ["R1.A", "R2.A"] }. */
function schematic(parts: [ref: string, defId: string, props?: Record<string, string>][], nets: Record<string, string[]> = {}): Project {
  const p: Project = { ...emptyProject(), parts: parts.map(([ref, defId, props = {}], i) => ({ ref, defId, x: i * 200, y: 0, rot: 0, props })) };
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

describe("parts list", () => {
  it("groups by part and value, leaving simulation-only parts out", () => {
    const p = schematic([
      ["R1", "RES", { R: "10k" }], ["R2", "RES", { R: "10000" }], ["R3", "RES", { R: "4k7" }], ["R4", "RES"],
      ["V1", "BATTERY"], ["VM1", "VOLTMETER"], ["U1", "74HC00"],
    ]);
    const bom = buildBom(p, defs);
    expect(bom.map((l) => [l.refs.join(" "), l.value])).toEqual([
      ["R1 R2", "10kΩ"], ["R3", "4.7kΩ"], ["R4", "1kΩ"], ["U1", ""],
    ]);
    expect(bom[0].query).toBe("10k ohm resistor 1/4W axial through hole");
    expect(bom[3]).toMatchObject({ query: "74HC00N", package: "DIP-14", mount: "tht" });
  });

  it("switches to surface-mount parts and chip size", () => {
    const p = { ...schematic([["C1", "CAP", { C: "0.1u" }], ["Q1", "2N2222"], ["D1", "LED-RED"], ["LCD1", "LCD1602"]]), bom: { mount: "smd" as const, smdSize: "0603" as const } };
    const bom = buildBom(p, defs);
    expect(bom.map((l) => l.query)).toEqual(["100nF ceramic capacitor 0603", "red LED 0603", "16x2 character LCD module HD44780", "MMBT2222A SOT-23"]);
    expect(bom.find((l) => l.refs[0] === "LCD1")!.mount).toBeNull();
  });

  it("applies per-line mount and search overrides", () => {
    const base = schematic([["R1", "RES"], ["U1", "NE555"]]);
    const key555 = buildBom(base, defs).find((l) => l.refs[0] === "U1")!.key;
    const keyR = buildBom(base, defs).find((l) => l.refs[0] === "R1")!.key;
    const p: Project = { ...base, bom: { mount: "tht", smdSize: "0805", lines: { [key555]: { mount: "smd" }, [keyR]: { query: "CFR-25JB-52-1K" } } } };
    const bom = buildBom(p, defs);
    expect(bom.find((l) => l.refs[0] === "U1")).toMatchObject({ query: "NE555DR", mount: "smd", mountOverride: true });
    expect(bom.find((l) => l.refs[0] === "R1")).toMatchObject({ query: "CFR-25JB-52-1K", autoQuery: "1k ohm resistor 1/4W axial through hole" });
  });

  it("builds distributor links and CSV", () => {
    expect(mouserUrl("10k ohm resistor")).toBe("https://www.mouser.com/c/?q=10k%20ohm%20resistor");
    expect(digikeyUrl("NE555P")).toBe("https://www.digikey.com/en/products/result?keywords=NE555P");
    const csv = bomCsv(buildBom(schematic([["R1", "RES"]]), defs));
    expect(csv.split("\r\n")[1]).toMatch(/^1,R1,Resistor,1kΩ,THT,Axial,1k ohm resistor/);
  });
});

describe("consolidate proposals", () => {
  it("makes bussed networks from resistors sharing a net, isolated arrays from the rest", () => {
    const p = schematic(
      [["R1", "RES", { R: "10k" }], ["R2", "RES", { R: "10k" }], ["R3", "RES", { R: "10k" }], ["R4", "RES", { R: "10k" }], ["R5", "RES", { R: "10k" }], ["R6", "RES", { R: "220" }]],
      { VCC: ["R1.A", "R2.A", "R3.B"] },
    );
    const props = findConsolidations(p, defs, "tht");
    expect(props.map((x) => [x.kind, x.members, x.size])).toEqual([
      ["res-bus", ["R1", "R2", "R3"], 3],
      ["res-iso", ["R4", "R5"], 2],
    ]);
    expect(props[0].detail).toContain("share VCC");
  });

  it("picks the dual-diode topology from the wiring, SMD only", () => {
    const p = schematic(
      [["D1", "1N4148"], ["D2", "1N4148"], ["D3", "1N4148"], ["D4", "1N4148"], ["D5", "1N4148"], ["D6", "1N4148"]],
      { OUT: ["D1.K", "D2.K"], MID: ["D3.A", "D4.K"] },
    );
    expect(findConsolidations(p, defs, "tht")).toEqual([]);
    expect(findConsolidations(p, defs, "smd").map((x) => [x.kind, x.members])).toEqual([
      ["diode-cc", ["D1", "D2"]], ["diode-series", ["D3", "D4"]], ["diode-iso", ["D5", "D6"]],
    ]);
  });

  it("only shares op-amp packages between op-amps on the same supplies", () => {
    const p = schematic(
      [["U1", "OPAMP"], ["U2", "OPAMP"], ["U3", "OPAMP"], ["U4", "OPAMP"]],
      { VCC: ["U1.VP", "U2.VP", "U3.VP", "U4.VP"], GND: ["U1.VN", "U2.VN", "U3.VN"], VEE: ["U4.VN"] },
    );
    const props = findConsolidations(p, defs, "tht");
    expect(props.map((x) => [x.members, x.size])).toEqual([[["U1", "U2", "U3"], 4]]);
  });
});

/** Defs including a project's embedded (imported or package) parts. */
const defsFor = (p: Project) => new Map([...defs, ...(p.embeddedParts ?? []).map((d) => [d.id, d] as const)]);

/**
 * Connectivity among the parts that survive consolidation (terminals aside,
 * since their stubs are rebuilt): for each such pin, the other such pins on its net.
 */
function partition(p: Project, keep: (ref: string) => boolean): Record<string, string> {
  const { netlist } = buildNetlist(p, defsFor(p));
  const kind = new Map(p.parts.map((q) => [q.ref, q.defId]));
  const out: Record<string, string> = {};
  for (const n of netlist.nets) {
    const pins = n.pins.filter((q) => keep(q.ref) && !isTerminal(kind.get(q.ref)!)).map((q) => `${q.ref}.${q.pin}`).sort();
    for (const k of pins) out[k] = pins.join(" ");
  }
  return out;
}

const w = (id: string, ...points: [number, number][]): Wire => ({ id, points });

/** Four 470R resistors fed from one hand-drawn VIN bus, each into its own load to a ground bus. */
function ladder(): Project {
  const parts: PartInstance[] = [
    { ref: "PWR1", defId: "POWER", x: -80, y: -10, rot: 0, props: { NET: "VIN", VOLTAGE: "10" } },
    { ref: "GND1", defId: "GROUND", x: 220, y: 250, rot: 0, props: {} },
  ];
  const wires: Wire[] = [w("bus", [-80, 0], [-80, 240]), w("gbus", [220, 0], [220, 240])];
  for (let i = 0; i < 4; i++) {
    const y = i * 80;
    parts.push({ ref: `R${i + 1}`, defId: "RES", x: 0, y, rot: 0, props: { R: "470" } });
    parts.push({ ref: `RL${i + 1}`, defId: "RES", x: 140, y, rot: 0, props: { R: `${i + 1}k` } });
    wires.push(w(`a${i}`, [-80, y], [-40, y]), w(`m${i}`, [40, y], [100, y]), w(`g${i}`, [180, y], [220, y]));
  }
  return { ...emptyProject(), parts, wires };
}

function loadVolts(p: Project): number[] {
  const { netlist, pinNets } = buildNetlist(p, defsFor(p));
  const sim = new Simulator(netlist, createModel);
  return [1, 2, 3, 4].map((i) => sim.netStates()[pinNets.get(`RL${i}.A`)!].v!);
}

describe("consolidate", () => {
  it("replaces hand-wired resistors with a bussed network and keeps the circuit working", () => {
    const p = ladder();
    const props = findConsolidations(p, defs, "tht");
    expect(props.map((x) => [x.kind, x.members])).toEqual([["res-bus", ["R1", "R2", "R3", "R4"]]]);
    const r = consolidate(p, defs, props);
    const after = r.project;

    expect(after.parts.some((q) => /^R\d$/.test(q.ref))).toBe(false);
    const pkg = after.parts.find((q) => q.ref === r.done[0].ref)!;
    expect(parsePackageId(pkg.defId)).toEqual({ kind: "res-bus", size: 4, baseId: "RES" });
    expect(pkg.props.R).toBe("470");
    // Everything rerouted with wires; no net labels needed.
    expect(r.done[0].labelled).toEqual([]);
    expect(after.parts.filter((q) => q.defId === "NETLABEL")).toEqual([]);

    const keep = (ref: string) => !/^R\d$/.test(ref) && ref !== pkg.ref;
    expect(partition(after, keep)).toEqual(partition(p, keep));
    const before = loadVolts(p);
    expect(before[0]).toBeCloseTo((10 * 1000) / 1470, 4);
    loadVolts(after).forEach((v, i) => expect(v).toBeCloseTo(before[i], 6));
  });

  it("moves ground, rail and label stubs to the package pins", () => {
    let p = schematic([["D1", "1N4148"], ["D2", "1N4148"]]);
    p = connect(p, defs, "OUT", ["D1.K", "D2.K"]).project;
    p = connect(p, defs, "IN1", ["D1.A"]).project;
    p = connect(p, defs, "GND", ["D2.A"]).project;
    const r = consolidate(p, defs, findConsolidations(p, defs, "smd"));
    const pkg = r.project.parts.find((q) => q.ref === r.done[0].ref)!;
    expect(pkg.defId).toBe("PACK-diode-cc-2-1N4148");
    const { pinNets } = buildNetlist(r.project, defsFor(r.project));
    expect([pinNets.get(`${pkg.ref}.A1`), pinNets.get(`${pkg.ref}.A2`), pinNets.get(`${pkg.ref}.K`)]).toEqual(["IN1", "GND", "OUT"]);
    // One OUT stub on the shared cathode, not two.
    expect(r.project.parts.filter((q) => q.defId === "NETLABEL" && q.props.NAME === "OUT")).toHaveLength(1);
  });

  it("lists packages in the parts list", () => {
    const p = ladder();
    const r = consolidate(p, defs, findConsolidations(p, defs, "tht"));
    const line = buildBom(r.project, defsFor(r.project)).find((l) => l.refs[0].startsWith("RN"))!;
    expect(line).toMatchObject({ qty: 1, value: "470Ω", query: "470 ohm resistor network bussed 4 resistors SIP-5", package: "SIP-5", mount: "tht" });
    const smd = buildBom({ ...r.project, bom: { mount: "smd", smdSize: "0603" } }, defsFor(r.project)).find((l) => l.refs[0].startsWith("RN"))!;
    expect(smd.query).toBe("470 ohm resistor array bussed 4 element SMD");

    let d = schematic([["Q1", "2N3906"], ["Q2", "2N3906"]]);
    d = consolidate(d, defs, findConsolidations(d, defs, "smd")).project;
    expect(buildBom(d, defsFor(d))).toMatchObject([{ query: "MMDT3906 SOT-363", mount: "smd", choice: false }]);
  });

  const examples = readdirSync(join(ROOT, "examples")).filter((f) => f.endsWith(".dad"));
  for (const file of examples) {
    for (const mount of ["tht", "smd"] as const) {
      it(`keeps the connectivity of ${file} (${mount})`, () => {
        const p = JSON.parse(readFileSync(join(ROOT, "examples", file), "utf8")) as Project;
        const d = defsFor(p);
        const props = findConsolidations(p, d, mount);
        const r = consolidate(p, d, props);
        expect(r.skipped).toEqual([]);
        const gone = new Set(props.flatMap((x) => x.members));
        const made = new Set(r.done.map((x) => x.ref));
        const keep = (ref: string) => !gone.has(ref) && !made.has(ref);
        expect(partition(r.project, keep)).toEqual(partition(p, keep));
      });
    }
  }
});
