// Programmatic schematic editing for the design assistant.
//
// Connections are made the way people wire dense schematic sheets: a short stub
// from each pin ending in a net label (or a ground / power terminal). Labels
// with the same name join, so the assistant never has to route wires.

import type { ComponentDef } from "./component";
import { PartInstance, Project, buildNetlist, nextRef, onSegment, pinPositions } from "./project";
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
export function stubAt(project: Project, defs: Defs, tip: { x: number; y: number }) {
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

/** Where a terminal goes so its pin sits on `end`, facing away from a pin that points `dir`. */
function terminalPose(defId: string, end: [number, number], dir: Dir): Pick<PartInstance, "x" | "y" | "rot"> {
  if (defId === "GROUND") {
    const up = dir === "up";
    return { x: end[0], y: end[1] + (up ? -10 : 10), rot: up ? 180 : 0 };
  }
  if (defId === "POWER") {
    const down = dir === "down";
    return { x: end[0], y: end[1] + (down ? 10 : -10), rot: down ? 180 : 0 };
  }
  const rot = ROT_FOR[dir];
  const [ox, oy] = rotatePoint(-10, 0, rot);
  return { x: end[0] - ox, y: end[1] - oy, rot };
}

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
    if (isGnd) term = { ref: nextRef(p, "GND"), defId: "GROUND", ...terminalPose("GROUND", end, tip.dir), props: {} };
    else if (rail) term = { ref: nextRef(p, "PWR"), defId: "POWER", ...terminalPose("POWER", end, tip.dir), props: { NET: name, VOLTAGE: volts } };
    else term = { ref: nextRef(p, "LBL"), defId: "NETLABEL", ...terminalPose("NETLABEL", end, tip.dir), props: { NAME: name } };
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

type Pt = [number, number];
const ptKey = ([x, y]: Pt) => `${x},${y}`;

/** Drop repeated points and the middle of straight axis-aligned runs. */
function tidy(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    const prev = out[out.length - 2];
    if (prev && ((prev[0] === last[0] && last[0] === p[0]) || (prev[1] === last[1] && last[1] === p[1]))) out.pop();
    out.push(p);
  }
  return out.length > 1 ? out : [out[0], out[0]];
}

/**
 * Move a wire's first point to `to`, keeping it orthogonal. When the first
 * segment turns into a free corner, that corner slides along with the end
 * (rubber banding); otherwise a dog-leg is added so existing geometry, and
 * any junctions on it, stay put.
 */
function dragStart(
  pts: Pt[], to: Pt,
  g: { isFixed: (p: Pt) => boolean; isNewTip: (p: Pt) => boolean; taken: (p: Pt) => boolean; touched: (a: Pt, b: Pt) => boolean; avoid: Pt[] },
): Pt[] {
  // A new route must not run through anything it would join by accident,
  // nor put a corner where another wire or pin already is.
  const clear = (path: Pt[]) => path.slice(1, -1).every((c) => !g.taken(c)) && path.slice(1).every((q, i) => g.avoid.every(([x, y]) => {
    const p = path[i];
    if ((x === path[0][0] && y === path[0][1]) || (x === path[path.length - 1][0] && y === path[path.length - 1][1])) return true;
    return !onSegment(x, y, p, q);
  }));
  const [a, b, c] = pts;
  const horiz = a[1] === b[1], vert = a[0] === b[0];
  if (c && (horiz || vert) && !g.isFixed(b) && !g.touched(a, b) && !g.touched(b, c)) {
    const slid: Pt = horiz ? [b[0], to[1]] : [to[0], b[1]];
    const turns = horiz ? b[0] === c[0] : b[1] === c[1];
    if (turns && clear([to, slid, c])) return tidy([to, slid, ...pts.slice(2)]);
  }
  // Keep the old geometry and add a dog-leg to it, skipping old vertices a
  // pin now sits on (pins swapping places under a rotate or mirror).
  let rest = pts;
  while (rest.length > 1 && g.isNewTip(rest[0])) rest = rest.slice(1);
  const q = rest[0];
  const legs: Pt[][] = [];
  if (to[0] === q[0] || to[1] === q[1]) {
    legs.push([to, q]);
    for (const d of [20, -20, 40, -40, 60, -60]) {
      const [ox, oy] = to[0] === q[0] ? [d, 0] : [0, d];
      legs.push([to, [to[0] + ox, to[1] + oy], [q[0] + ox, q[1] + oy], q]);
    }
  } else {
    const across: Pt = [to[0], q[1]], down: Pt = [q[0], to[1]];
    legs.push(...(vert ? [[to, down, q], [to, across, q]] : [[to, across, q], [to, down, q]]));
  }
  return tidy([...(legs.find(clear) ?? legs[0]), ...rest.slice(1)]);
}

/**
 * Move, rotate or mirror a part, dragging the ends of wires attached to its
 * pins along so connections survive the edit. A pin's stub out to a net
 * label, power or ground terminal travels with the part as one piece.
 */
export function transformPart(
  project: Project, defs: Defs, ref: string, patch: Partial<Pick<PartInstance, "x" | "y" | "rot" | "mirror">>,
): Project {
  const part = getPart(project, ref);
  const moved = { ...part, ...patch };
  let parts = project.parts.map((q) => (q === part ? moved : q));
  const def = defs.get(part.defId);
  if (!def) return { ...project, parts };

  const tipsOf = (ps: PartInstance[]): Pt[] => ps
    .filter((q) => q.ref !== ref && defs.has(q.defId))
    .flatMap((q) => pinPositions(q, defs.get(q.defId)!).map((t) => [t.x, t.y] as Pt));
  const oldTips = tipsOf(project.parts);
  const shared = new Set(oldTips.map(ptKey));
  // Old pin tip -> new pin tip. A tip that another part's pin also sits on
  // belongs to that pin too, so wires there stay where they are.
  const dest = new Map<string, Pt>();
  const pinIndex = new Map<string, number>();
  const after = pinPositions(moved, def);
  pinPositions(part, def).forEach((t, i) => {
    const k = ptKey([t.x, t.y]);
    if (!shared.has(k)) {
      dest.set(k, [after[i].x, after[i].y]);
      pinIndex.set(k, i);
    }
  });
  const ends = (w: { points: Pt[] }) => [dest.get(ptKey(w.points[0])), dest.get(ptKey(w.points[w.points.length - 1]))];
  if (!project.wires.some((w) => w.points.length > 1 && ends(w).some(Boolean))) return { ...project, parts };

  const dx = moved.x - part.x, dy = moved.y - part.y;
  const pureMove = moved.rot === part.rot && !!moved.mirror === !!part.mirror;
  const wires = project.wires.map((w) => ({ ...w, points: w.points.map((p) => [p[0], p[1]] as Pt) }));

  // Stubs leading only to a terminal, touching nothing else, are carried
  // rather than rerouted: a reroute across a dense sheet would cross things.
  const carry = new Map<number, PartInstance>();
  wires.forEach((w, wi) => {
    if (w.points.length < 2) return;
    const [s, e] = ends(w);
    if (!!s === !!e) return;
    const far = s ? w.points[w.points.length - 1] : w.points[0];
    const at = (t: Pt) => t[0] === far[0] && t[1] === far[1];
    const term = project.parts.find((q) => q.ref !== ref && isTerminal(q.defId) && defs.has(q.defId)
      && pinPositions(q, defs.get(q.defId)!).some((t) => t.x === far[0] && t.y === far[1]));
    if (!term || oldTips.filter(at).length !== 1) return;
    const touches = wires.some((o, oi) => oi !== wi && (
      o.points.some((p) => w.points.some((q) => p[0] === q[0] && p[1] === q[1]))
      || endsOn(o.points, w.points) || endsOn(w.points, o.points)));
    const crossesPin = oldTips.some((t) => !at(t) && w.points.slice(1).some((q, i) => onSegment(t[0], t[1], w.points[i], q)));
    if (!touches && !crossesPin) carry.set(wi, term);
  });
  const carried = new Set<number>();
  carry.forEach((term, wi) => {
    const w = wires[wi];
    const [s, e] = ends(w);
    const tip = s ? w.points[0] : w.points[w.points.length - 1];
    const far = s ? w.points[w.points.length - 1] : w.points[0];
    let pose: Pick<PartInstance, "x" | "y" | "rot">;
    if (pureMove) {
      w.points = w.points.map(([x, y]) => [x + dx, y + dy] as Pt);
      pose = { x: term.x + dx, y: term.y + dy, rot: term.rot };
    } else {
      // Rotated or mirrored: re-lay a straight stub off the pin's new side.
      const len = Math.abs(far[0] - tip[0]) + Math.abs(far[1] - tip[1]);
      if (w.points.length !== 2 || (far[0] !== tip[0] && far[1] !== tip[1]) || len === 0) return;
      const dir = rotateDir(symbolFor(def).pins[pinIndex.get(ptKey(tip))!].dir, moved.rot, moved.mirror);
      const to = (s ?? e)!;
      const end: Pt = [to[0] + DIRV[dir][0] * len, to[1] + DIRV[dir][1] * len];
      w.points = s ? [to, end] : [end, to];
      pose = terminalPose(term.defId, end, dir);
    }
    const { mirror: _, ...upright } = term;
    parts = parts.map((q) => (q === term ? { ...upright, ...pose } : q));
    carried.add(wi);
  });

  const newTips = new Set(after.map((t) => ptKey([t.x, t.y])));
  const tips = tipsOf(parts);
  wires.forEach((w, wi) => {
    if (w.points.length < 2 || carried.has(wi)) return;
    const [s, e] = ends(w);
    if (!s && !e) return;
    if (s && e && pureMove) {
      w.points = w.points.map(([x, y]) => [x + dx, y + dy] as Pt);
      return;
    }
    // Points other wires or parts connect through must not move.
    const others = wires.filter((o) => o !== w);
    const fixed = new Set([...shared, ...others.flatMap((o) => o.points.map(ptKey))]);
    const taken = new Set([...fixed, ...tips.map(ptKey)]);
    const foreign: Pt[] = [...oldTips, ...tips, ...others.flatMap((o) => o.points.length ? [o.points[0], o.points[o.points.length - 1]] : [])];
    const g = {
      isFixed: (p: Pt) => fixed.has(ptKey(p)),
      isNewTip: (p: Pt) => newTips.has(ptKey(p)),
      taken: (p: Pt) => taken.has(ptKey(p)),
      // Something joins this segment partway along (a T-junction).
      touched: (a: Pt, b: Pt) => foreign.some(([x, y]) => onSegment(x, y, a, b) && !(x === a[0] && y === a[1]) && !(x === b[0] && y === b[1])),
      avoid: [...foreign, ...after.map((t) => [t.x, t.y] as Pt)],
    };
    if (s) w.points = dragStart(w.points, s, g);
    if (e) w.points = dragStart([...w.points].reverse(), e, g).reverse();
  });
  return { ...project, parts, wires };
}

/** Does either end of wire `a` land on one of wire `b`'s segments? */
function endsOn(a: Pt[], b: Pt[]): boolean {
  if (!a.length) return false;
  return [a[0], a[a.length - 1]].some(([x, y]) => b.slice(1).some((q, i) => onSegment(x, y, b[i], q)));
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
