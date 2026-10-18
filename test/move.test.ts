import { describe, expect, it } from "vitest";
import type { ComponentDef } from "../src/shared/component";
import { connect, transformPart } from "../src/shared/edit";
import { BUILTIN_LIBRARY } from "../src/shared/library";
import { Project, buildNetlist } from "../src/shared/project";

const defs = new Map<string, ComponentDef>(BUILTIN_LIBRARY.map((d) => [d.id, d]));

// Same fixture as the netlist test: R1.B -> R2.A with a T down to ground, VCC on R1.A and R2.B.
const base = (): Project => ({
  version: 1, name: "t",
  parts: [
    { ref: "R1", defId: "RES", x: 0, y: 0, rot: 0, props: {} },
    { ref: "R2", defId: "RES", x: 200, y: 0, rot: 0, props: {} },
    { ref: "PWR1", defId: "POWER", x: -40, y: -50, rot: 0, props: {} },
    { ref: "PWR2", defId: "POWER", x: 240, y: -50, rot: 0, props: {} },
    { ref: "G1", defId: "GROUND", x: 100, y: 60, rot: 0, props: {} },
  ],
  wires: [
    { id: "w1", points: [[40, 0], [160, 0]] },
    { id: "w2", points: [[100, 0], [100, 50]] },
    { id: "w3", points: [[-40, -40], [-40, 0]] },
    { id: "w4", points: [[240, -40], [240, 0]] },
  ],
});

const nets = (p: Project) => {
  const { pinNets } = buildNetlist(p, defs);
  return ["R1.A", "R1.B", "R2.A", "R2.B"].map((k) => pinNets.get(k));
};

const orthogonal = (p: Project) =>
  p.wires.every((w) => w.points.slice(1).every(([x, y], i) => x === w.points[i][0] || y === w.points[i][1]));

describe("moving parts keeps wires attached", () => {
  it("drags wire ends along with a moved part", () => {
    const p = transformPart(base(), defs, "R2", { x: 260, y: 80 });
    expect(nets(p)).toEqual(["VCC", "GND", "GND", "VCC"]);
    expect(orthogonal(p)).toBe(true);
    // The T-junction to ground is untouched.
    expect(p.wires.find((w) => w.id === "w2")!.points).toEqual([[100, 0], [100, 50]]);
  });

  it("stays connected over many small drag steps without piling up corners", () => {
    let p = base();
    for (let i = 1; i <= 10; i++) p = transformPart(p, defs, "R2", { x: 200 + i * 10, y: i * 10 });
    expect(nets(p)).toEqual(["VCC", "GND", "GND", "VCC"]);
    expect(orthogonal(p)).toBe(true);
    expect(Math.max(...p.wires.map((w) => w.points.length))).toBeLessThanOrEqual(4);
  });

  it("follows pins through rotation and mirroring", () => {
    let p = transformPart(base(), defs, "R2", { rot: 90 });
    expect(nets(p)).toEqual(["VCC", "GND", "GND", "VCC"]);
    p = transformPart(p, defs, "R2", { mirror: true });
    expect(nets(p)).toEqual(["VCC", "GND", "GND", "VCC"]);
    expect(orthogonal(p)).toBe(true);
  });

  it("moves terminals with their stubs", () => {
    const p = transformPart(base(), defs, "G1", { x: 100, y: 100 });
    expect(nets(p)).toEqual(["VCC", "GND", "GND", "VCC"]);
  });
});

describe("moving parts wired with net-label stubs", () => {
  // Two 7-seg displays side by side, every segment stubbed out to a label,
  // the way connect() wires dense sheets.
  const labelled = (): Project => {
    let p: Project = {
      version: 1, name: "t",
      parts: [
        { ref: "DS1", defId: "7SEG-CC", x: 0, y: 0, rot: 0, props: {} },
        { ref: "DS2", defId: "7SEG-CC", x: 200, y: 0, rot: 0, props: {} },
      ],
      wires: [],
    };
    for (const ds of ["DS1", "DS2"]) for (const seg of ["A", "B", "C", "D", "E", "F", "G", "DP"]) p = connect(p, defs, `${ds}_${seg}`, [`${ds}.${seg}`]).project;
    return p;
  };
  const groups = (p: Project) => {
    const g = new Map<string, string[]>();
    for (const [k, n] of buildNetlist(p, defs).pinNets) g.set(n, [...(g.get(n) ?? []), k]);
    return [...g.values()].map((x) => x.sort().join(" ")).sort();
  };

  it("carries labels along on a long move without merging nets", () => {
    const before = labelled();
    const p = transformPart(before, defs, "DS1", { x: 1400, y: -200 });
    expect(groups(p)).toEqual(groups(before));
    expect(p.wires.every((w) => w.points.length === 2)).toBe(true);
  });

  it("re-lays label stubs through rotation and mirroring", () => {
    const before = labelled();
    let p = transformPart(before, defs, "DS2", { rot: 90 });
    expect(groups(p)).toEqual(groups(before));
    p = transformPart(p, defs, "DS2", { mirror: true });
    expect(groups(p)).toEqual(groups(before));
  });
});
