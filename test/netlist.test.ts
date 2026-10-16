import { describe, expect, it } from "vitest";
import type { ComponentDef } from "../src/shared/component";
import { BUILTIN_LIBRARY } from "../src/shared/library";
import { Project, buildNetlist, pinPositions } from "../src/shared/project";
import { symbolFor } from "../src/shared/symbols";

const defs = new Map<string, ComponentDef>(BUILTIN_LIBRARY.map((d) => [d.id, d]));

describe("netlist extraction", () => {
  it("joins wires, T-junctions and named rails", () => {
    const res = defs.get("RES")!;
    const p: Project = {
      version: 1, name: "t",
      parts: [
        { ref: "R1", defId: "RES", x: 0, y: 0, rot: 0, props: {} },
        { ref: "R2", defId: "RES", x: 200, y: 0, rot: 0, props: {} },
        { ref: "PWR1", defId: "POWER", x: -40, y: -50, rot: 0, props: {} },
        { ref: "PWR2", defId: "POWER", x: 240, y: -50, rot: 0, props: {} },
        { ref: "G1", defId: "GROUND", x: 100, y: 60, rot: 0, props: {} },
      ],
      wires: [
        { id: "w1", points: [[40, 0], [160, 0]] },       // R1.B -> R2.A
        { id: "w2", points: [[100, 0], [100, 50]] },      // T-junction down to ground
        { id: "w3", points: [[-40, -40], [-40, 0]] },     // VCC -> R1.A
        { id: "w4", points: [[240, -40], [240, 0]] },     // VCC -> R2.B
      ],
    };
    expect(pinPositions(p.parts[0], res).map((x) => [x.x, x.y])).toEqual([[-40, 0], [40, 0]]);
    const { netlist, pinNets } = buildNetlist(p, defs);
    expect(pinNets.get("R1.A")).toBe("VCC");
    expect(pinNets.get("R2.B")).toBe("VCC");
    expect(pinNets.get("R1.B")).toBe("GND");
    expect(pinNets.get("R2.A")).toBe("GND");
    expect(netlist.nets.find((n) => n.name === "GND")!.ground).toBe(true);
  });

  it("places box-symbol pins on the grid", () => {
    for (const d of BUILTIN_LIBRARY) {
      for (const p of symbolFor(d).pins) {
        expect(Math.abs(p.x % 10), `${d.id}.${p.id}`).toBe(0);
        expect(Math.abs(p.y % 10), `${d.id}.${p.id}`).toBe(0);
      }
      expect(symbolFor(d).pins.length, d.id).toBe(d.pins.length);
    }
  });
});
