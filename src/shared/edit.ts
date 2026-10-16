// Programmatic schematic editing for the design assistant.
//
// Connections are made the way people wire dense Proteus sheets: a short stub
// from each pin ending in a net label (or a ground / power terminal). Labels
// with the same name join, so the assistant never has to route wires.

import type { ComponentDef } from "./component";
import { PartInstance, Project, buildNetlist, nextRef, pinPositions } from "./project";
import { Dir, Rotation, rotateDir, rotatePoint, symbolFor } from "./symbols";

const STUB = 20;
const TERMINALS = new Set(["GROUND", "POWER", "NETLABEL"]);
const DIRV: Record<Dir, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

export class EditError extends Error {}

type Defs = Map<string, ComponentDef>;

export function isTerminal(defId: string): boolean {
  return TERMINALS.has(defId);
}

function getPart(project: Project, ref: string): PartInstance {
  const p = project.parts.find((x) => x.ref === ref);
  if (!p) throw new EditError(`no part '${ref}' on the schematic`);
  return p;
}

export function pinTip(project: Project, defs: Defs, pinRef: string): { x: number; y: number; dir: Dir } {
  const [ref, id] = pinRef.split(".");
  if (!ref || !id) throw new EditError(`'${pinRef}' is not REF.PIN`);
  const part = getPart(project, ref);
  const def = defs.get(part.defId)!;
  const sp = symbolFor(def).pins.find((p) => p.id === id);
  if (!sp) throw new EditError(`${ref} (${def.id}) has no pin '${id}'; pins: ${def.pins.map((p) => p.id).join(", ")}`);
  const [dx, dy] = rotatePoint(sp.x, sp.y, part.rot, part.mirror);
  return { x: part.x + dx, y: part.y + dy, dir: rotateDir(sp.dir, part.rot, part.mirror) };
}

/** Axis-aligned bounds of a part including its pins. */
export function partBounds(part: PartInstance, def: ComponentDef): [number, number, number, number] {
  const g = symbolFor(def);
  const pts: [number, number][] = [[-g.w / 2, -g.h / 2], [g.w / 2, g.h / 2], ...g.pins.map((p) => [p.x, p.y] as [number, number])];
  const xs: number[] = [], ys: number[] = [];
  for (const [x, y] of pts) {
    const [rx, ry] = rotatePoint(x, y, part.rot, part.mirror);
    xs.push(part.x + rx);
    ys.push(part.y + ry);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** First free grid slot (left to right, top to bottom) with room for labels. */
export function autoPosition(project: Project, defs: Defs, def: ComponentDef, rot: Rotation): [number, number] {
  const MX = 110, MY = 50;
  const boxes = project.parts
    .filter((p) => !isTerminal(p.defId) && defs.has(p.defId))
    .map((p) => partBounds(p, defs.get(p.defId)!));
  const probe: PartInstance = { ref: "?", defId: def.id, x: 0, y: 0, rot, props: {} };
  const [bx0, by0, bx1, by1] = partBounds(probe, def);
  for (let y = 0; y < 6000; y += 40) {
    for (let x = 0; x <= 1600; x += 40) {
      const r = [x + bx0 - MX, y + by0 - MY, x + bx1 + MX, y + by1 + MY];
      const hit = boxes.some(([a, b, c, d]) => r[0] < c + MX && r[2] > a - MX && r[1] < d + MY && r[3] > b - MY);
      if (!hit) return [x, y];
    }
  }
  return [0, 6000];
}

export function placePart(
  project: Project, defs: Defs,
  opts: { defId: string; ref?: string; props?: Record<string, string>; x?: number; y?: number; rot?: Rotation },
): { project: Project; ref: string } {
  const def = defs.get(opts.defId);
  if (!def) throw new EditError(`unknown part id '${opts.defId}'; use search_library`);
  const ref = opts.ref?.trim() || nextRef(project, def.refPrefix);
  if (project.parts.some((p) => p.ref === ref)) throw new EditError(`ref ${ref} already exists`);
  const rot = opts.rot ?? 0;
  const snap = (v: number) => Math.round(v / 10) * 10;
  const [x, y] = opts.x !== undefined && opts.y !== undefined ? [snap(opts.x), snap(opts.y)] : autoPosition(project, defs, def, rot);
  for (const k of Object.keys(opts.props ?? {})) {
    if (!def.properties.some((p) => p.key === k)) {
      throw new EditError(`${def.id} has no property '${k}'; properties: ${def.properties.map((p) => p.key).join(", ") || "none"}`);
    }
  }
  const embedded = (def.source?.kind === "datasheet" || def.source?.kind === "emulated") && !(project.embeddedParts ?? []).some((d) => d.id === def.id)
    ? [...(project.embeddedParts ?? []), def] : project.embeddedParts;
  return {
    project: { ...project, embeddedParts: embedded, parts: [...project.parts, { ref, defId: def.id, x, y, rot, props: { ...opts.props } }] },
    ref,
  };
}

/** The terminal sitting at the end of a pin's stub, if any. */
function stubAt(project: Project, defs: Defs, tip: { x: number; y: number }) {
  const wire = project.wires.find((w) => w.points.some(([x, y]) => x === tip.x && y === tip.y));
  if (!wire) return null;
  const other = wire.points[0][0] === tip.x && wire.points[0][1] === tip.y ? wire.points[wire.points.length - 1] : wire.points[0];
  const terminal = project.parts.find((p) => {
    if (!isTerminal(p.defId)) return false;
    return pinPositions(p, defs.get(p.defId)!).some((q) => q.x === other[0] && q.y === other[1]);
  });
  return { wire, terminal };
}

function terminalNet(part: PartInstance): string {
  if (part.defId === "GROUND") return "GND";
  if (part.defId === "POWER") return part.props.NET || "VCC";
  return part.props.NAME || "NET";
}

const ROT_FOR: Record<Dir, Rotation> = { right: 0, down: 90, left: 180, up: 270 };

export function connect(
  project: Project, defs: Defs, net: string, pins: string[], railVoltage?: number,
): { project: Project; connected: string[]; skipped: string[] } {
  const name = net.trim();
  if (!/^[\w+\-.]+$/.test(name)) throw new EditError(`net name '${net}' must be letters, digits, _ + - .`);
  const isGnd = name.toUpperCase() === "GND";
  const existingRail = project.parts.find((p) => p.defId === "POWER" && (p.props.NET || "VCC") === name);
  const rail = railVoltage !== undefined || !!existingRail;
  const volts = railVoltage !== undefined ? String(railVoltage) : existingRail?.props.VOLTAGE ?? "5";
  if (existingRail && railVoltage !== undefined && Number(existingRail.props.VOLTAGE ?? 5) !== railVoltage) {
    throw new EditError(`rail ${name} already exists at ${existingRail.props.VOLTAGE} V`);
  }
  let p = project;
  const connected: string[] = [];
  const skipped: string[] = [];
  let n = 0;
  for (const pinRef of pins) {
    const tip = pinTip(p, defs, pinRef);
    const existing = stubAt(p, defs, tip);
    if (existing) {
      if (existing.terminal && terminalNet(existing.terminal) === name) {
        skipped.push(pinRef);
        continue;
      }
      const what = existing.terminal ? `net ${terminalNet(existing.terminal)}` : "a hand-drawn wire";
      throw new EditError(`${pinRef} is already connected to ${what}; disconnect it first`);
    }
    const [dx, dy] = DIRV[tip.dir];
    const end: [number, number] = [tip.x + dx * STUB, tip.y + dy * STUB];
    const wireId = `ai${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    let term: PartInstance;
    if (isGnd) {
      const up = tip.dir === "up";
      term = { ref: nextRef(p, "GND"), defId: "GROUND", x: end[0], y: end[1] + (up ? -10 : 10), rot: up ? 180 : 0, props: {} };
    } else if (rail) {
      const down = tip.dir === "down";
      term = { ref: nextRef(p, "PWR"), defId: "POWER", x: end[0], y: end[1] + (down ? 10 : -10), rot: down ? 180 : 0, props: { NET: name, VOLTAGE: volts } };
    } else {
      const rot = ROT_FOR[tip.dir];
      const [ox, oy] = rotatePoint(-10, 0, rot);
      term = { ref: nextRef(p, "LBL"), defId: "NETLABEL", x: end[0] - ox, y: end[1] - oy, rot, props: { NAME: name } };
    }
    p = { ...p, wires: [...p.wires, { id: wireId, points: [[tip.x, tip.y], end] }], parts: [...p.parts, term] };
    connected.push(pinRef);
  }
  return { project: p, connected, skipped };
}

export function disconnect(project: Project, defs: Defs, pins: string[]): Project {
  let p = project;
  for (const pinRef of pins) {
    const tip = pinTip(p, defs, pinRef);
    const s = stubAt(p, defs, tip);
    if (!s) continue;
    p = {
      ...p,
      wires: p.wires.filter((w) => w !== s.wire),
      parts: s.terminal ? p.parts.filter((x) => x !== s.terminal) : p.parts,
    };
  }
  return p;
}

export function removePart(project: Project, defs: Defs, ref: string): Project {
  const part = getPart(project, ref);
  const def = defs.get(part.defId)!;
  const p = disconnect(project, defs, def.pins.map((x) => `${ref}.${x.id}`));
  // Drop any remaining wires that ended on this part's pins.
  const tips = new Set(pinPositions(part, def).map((t) => `${t.x},${t.y}`));
  return {
    ...p,
    parts: p.parts.filter((x) => x.ref !== ref),
    wires: p.wires.filter((w) => !w.points.some(([x, y]) => tips.has(`${x},${y}`))),
  };
}

export function setProperty(project: Project, defs: Defs, ref: string, key: string, value: string): Project {
  const part = getPart(project, ref);
  const def = defs.get(part.defId)!;
  if (!def.properties.some((p) => p.key === key)) {
    throw new EditError(`${def.id} has no property '${key}'; properties: ${def.properties.map((p) => p.key).join(", ") || "none"}`);
  }
  return { ...project, parts: project.parts.map((x) => (x.ref === ref ? { ...x, props: { ...x.props, [key]: value } } : x)) };
}

/** Compact, model-friendly description of the schematic. */
export function describeSchematic(project: Project, defs: Defs) {
  const { netlist } = buildNetlist(project, defs);
  const terminalRefs = new Set(project.parts.filter((p) => isTerminal(p.defId)).map((p) => p.ref));
  const rails = new Map(project.parts.filter((p) => p.defId === "POWER").map((p) => [p.props.NET || "VCC", p.props.VOLTAGE ?? "5"]));
  const nets = netlist.nets
    .map((n) => ({ name: n.name, pins: n.pins.filter((q) => !terminalRefs.has(q.ref)).map((q) => `${q.ref}.${q.pin}`) }))
    .filter((n) => n.pins.length > 1 || rails.has(n.name) || n.name === "GND");
  const connected = new Set(nets.flatMap((n) => n.pins));
  const unconnectedInputs: string[] = [];
  for (const part of project.parts) {
    if (terminalRefs.has(part.ref)) continue;
    const def = defs.get(part.defId);
    if (!def) continue;
    for (const pin of def.pins) {
      if (pin.type === "input" && !connected.has(`${part.ref}.${pin.id}`)) unconnectedInputs.push(`${part.ref}.${pin.id}${pin.name.startsWith("~") ? " (active-low, idles inactive)" : ""}`);
    }
  }
  return {
    parts: project.parts.filter((p) => !terminalRefs.has(p.ref)).map((p) => ({ ref: p.ref, def_id: p.defId, props: p.props })),
    rails: Object.fromEntries(rails),
    nets: nets.map((n) => ({ name: n.name, rail_volts: rails.get(n.name), pins: n.pins })),
    unconnected_inputs: unconnectedInputs,
    firmware_sources: Object.keys(project.sources ?? {}),
  };
}
