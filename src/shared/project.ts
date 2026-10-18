// Schematic document model and netlist extraction.

import type { ComponentDef, Netlist, NetlistNet } from "./component";
import type { SavedHistory } from "./history";
import { Rotation, rotatePoint, symbolFor } from "./symbols";

export interface PartInstance {
  ref: string;
  defId: string;
  x: number;
  y: number;
  rot: Rotation;
  mirror?: boolean;
  props: Record<string, string>;
}

export interface Wire {
  id: string;
  points: [number, number][];
}

export type Mount = "tht" | "smd";
export type SmdSize = "0402" | "0603" | "0805" | "1206";

/** Parts list (BOM) preferences, saved with the project. */
export interface BomSettings {
  mount: Mount;
  /** Footprint for chip resistors, capacitors, inductors and LEDs when mounting SMD. */
  smdSize: SmdSize;
  /** Per-line overrides, keyed by BomLine.key. */
  lines?: Record<string, { mount?: Mount; query?: string }>;
}

export interface Project {
  version: 1;
  name: string;
  parts: PartInstance[];
  wires: Wire[];
  bom?: BomSettings;
  /** Firmware sources keyed by file name (assembled inside the app). */
  sources?: Record<string, string>;
  /** Imported part definitions used by this project, so it opens anywhere. */
  embeddedParts?: ComponentDef[];
  /** Undo/redo stacks, so they survive closing the file. */
  history?: SavedHistory;
}

export function emptyProject(): Project {
  return { version: 1, name: "Untitled", parts: [], wires: [] };
}

export function pinPositions(part: PartInstance, def: ComponentDef): { id: string; x: number; y: number }[] {
  return symbolFor(def).pins.map((p) => {
    const [rx, ry] = rotatePoint(p.x, p.y, part.rot, part.mirror);
    return { id: p.id, x: part.x + rx, y: part.y + ry };
  });
}

class UnionFind {
  private parent = new Map<string, string>();
  find(a: string): string {
    if (!this.parent.has(a)) {
      this.parent.set(a, a);
      return a;
    }
    let root = a;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let c = a;
    while (c !== root) {
      const next = this.parent.get(c)!;
      this.parent.set(c, root);
      c = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

const key = (x: number, y: number) => `${x},${y}`;

export function onSegment(px: number, py: number, [ax, ay]: [number, number], [bx, by]: [number, number]): boolean {
  if (ax === bx) return px === ax && py >= Math.min(ay, by) && py <= Math.max(ay, by);
  if (ay === by) return py === ay && px >= Math.min(ax, bx) && px <= Math.max(ax, bx);
  // diagonal segment: exact collinearity
  const cross = (px - ax) * (by - ay) - (py - ay) * (bx - ax);
  return cross === 0 && px >= Math.min(ax, bx) && px <= Math.max(ax, bx) && py >= Math.min(ay, by) && py <= Math.max(ay, by);
}

export interface NetlistResult {
  netlist: Netlist;
  /** Net name per "REF.PIN", for probes and highlighting. */
  pinNets: Map<string, string>;
  /** Net name per wire id. */
  wireNets: Map<string, string>;
}

/**
 * Connectivity rules: wire vertices connect; a wire end
 * or pin tip landing on another wire's segment makes a junction; power and
 * ground terminals and net labels join nets by name.
 */
export function buildNetlist(project: Project, defs: Map<string, ComponentDef>): NetlistResult {
  const uf = new UnionFind();
  const pinKeys: { ref: string; pin: string; at: string; x: number; y: number }[] = [];
  const named = new Map<string, string>(); // net name -> representative key
  const instances: Netlist["instances"] = [];

  for (const part of project.parts) {
    const def = defs.get(part.defId);
    if (!def) continue;
    instances.push({ ref: part.ref, def, props: part.props });
    for (const p of pinPositions(part, def)) {
      const k = key(p.x, p.y);
      uf.find(k);
      pinKeys.push({ ref: part.ref, pin: p.id, at: k, x: p.x, y: p.y });
    }
  }

  const ends: [number, number][] = [];
  for (const w of project.wires) {
    for (let i = 1; i < w.points.length; i++) uf.union(key(...w.points[i - 1]), key(...w.points[i]));
    if (w.points.length) {
      ends.push(w.points[0], w.points[w.points.length - 1]);
      uf.find(key(...w.points[0]));
    }
  }
  // T-junctions: wire ends and pin tips that land in the middle of a segment.
  const probes: [number, number][] = [...ends, ...pinKeys.map((p) => [p.x, p.y] as [number, number])];
  for (const w of project.wires) {
    for (let i = 1; i < w.points.length; i++) {
      for (const pt of probes) {
        if (onSegment(pt[0], pt[1], w.points[i - 1], w.points[i])) uf.union(key(...pt), key(...w.points[i]));
      }
    }
  }

  // Named connections.
  const nameOf = new Map<string, string>(); // representative -> name
  const groundNames = new Set<string>(["GND"]);
  for (const part of project.parts) {
    const def = defs.get(part.defId);
    if (!def) continue;
    let name: string | undefined;
    if (def.id === "GROUND") name = "GND";
    else if (def.id === "POWER") name = part.props.NET || def.properties.find((p) => p.key === "NET")?.default || "VCC";
    else if (def.id === "NETLABEL") name = part.props.NAME || "NET";
    if (!name) continue;
    const pk = pinKeys.find((p) => p.ref === part.ref);
    if (!pk) continue;
    const prev = named.get(name);
    if (prev) uf.union(prev, pk.at);
    else named.set(name, pk.at);
  }
  for (const [name, k] of named) nameOf.set(uf.find(k), name);

  const nets = new Map<string, NetlistNet>();
  let anon = 1;
  const netFor = (rep: string): NetlistNet => {
    let n = nets.get(rep);
    if (!n) {
      const name = nameOf.get(rep) ?? `N${String(anon++).padStart(3, "0")}`;
      n = { name, ground: groundNames.has(name), pins: [] };
      nets.set(rep, n);
    }
    return n;
  };
  const pinNets = new Map<string, string>();
  for (const p of pinKeys) {
    const n = netFor(uf.find(p.at));
    n.pins.push({ ref: p.ref, pin: p.pin });
    pinNets.set(`${p.ref}.${p.pin}`, n.name);
  }
  const wireNets = new Map<string, string>();
  for (const w of project.wires) {
    if (w.points.length) wireNets.set(w.id, netFor(uf.find(key(...w.points[0]))).name);
  }
  return { netlist: { instances, nets: [...nets.values()] }, pinNets, wireNets };
}

export function nextRef(project: Project, prefix: string): string {
  let n = 1;
  const used = new Set(project.parts.map((p) => p.ref));
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}
