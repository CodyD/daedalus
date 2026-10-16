// Programmatic schematic builder used to generate (and test) the bundled
// example projects. Wires are routed orthogonally between pin tips.

import type { ComponentDef } from "../src/shared/component";
import { BUILTIN_LIBRARY } from "../src/shared/library";
import { PartInstance, Project, pinPositions } from "../src/shared/project";
import type { Rotation } from "../src/shared/symbols";

type Pt = [number, number];

export const DEFS = new Map<string, ComponentDef>(BUILTIN_LIBRARY.map((d) => [d.id, d]));

export class SchematicBuilder {
  project: Project;
  private n = 0;
  constructor(name: string) {
    this.project = { version: 1, name, parts: [], wires: [], sources: {} };
  }

  part(defId: string, ref: string, x: number, y: number, props: Record<string, string> = {}, rot: Rotation = 0): this {
    if (!DEFS.has(defId)) throw new Error(`unknown part ${defId}`);
    this.project.parts.push({ ref, defId, x, y, rot, props });
    return this;
  }

  pin(ref: string, id: string): Pt {
    const part = this.project.parts.find((p) => p.ref === ref) as PartInstance;
    const pos = pinPositions(part, DEFS.get(part.defId)!).find((p) => p.id === id);
    if (!pos) throw new Error(`${ref} has no pin ${id}`);
    return [pos.x, pos.y];
  }

  /** Wire through explicit corner points. */
  path(...pts: (Pt | string)[]): this {
    const points = pts.map((p) => (typeof p === "string" ? this.pin(...(p.split(".") as [string, string])) : p));
    this.project.wires.push({ id: `w${++this.n}`, points });
    return this;
  }

  /** Horizontal-first L route between two pins ("U1.PB5" form). */
  wire(a: string, b: string, viaX?: number): this {
    const pa = this.pin(...(a.split(".") as [string, string]));
    const pb = this.pin(...(b.split(".") as [string, string]));
    if (pa[0] === pb[0] || pa[1] === pb[1]) return this.path(pa, pb);
    const x = viaX ?? pb[0];
    const pts: Pt[] = [pa, [x, pa[1]]];
    if (x !== pb[0]) pts.push([x, pb[1]]);
    pts.push(pb);
    return this.path(...pts);
  }

  /** Ground symbol `dy` below a pin with a short wire. */
  ground(pinRef: string, dy = 30, dx = 0): this {
    const [x, y] = this.pin(...(pinRef.split(".") as [string, string]));
    const ref = `GND${++this.n}`;
    this.part("GROUND", ref, x + dx, y + dy + 10);
    return dx ? this.path([x, y], [x + dx, y], [x + dx, y + dy]) : this.path([x, y], [x, y + dy]);
  }

  /** Power rail symbol `dy` above a pin. */
  power(pinRef: string, net = "VCC", volts = "5", dy = 30): this {
    const [x, y] = this.pin(...(pinRef.split(".") as [string, string]));
    const ref = `PWR${++this.n}`;
    this.part("POWER", ref, x, y - dy - 10, { NET: net, VOLTAGE: volts });
    return this.path([x, y], [x, y - dy]);
  }

  source(name: string, text: string): this {
    this.project.sources![name] = text;
    return this;
  }
}
