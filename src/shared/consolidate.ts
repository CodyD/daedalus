// Consolidate: replace many basic parts with fewer multi-unit packages.
//
// Same-value resistors become resistor arrays (bussed networks when they
// share a net, e.g. pull-ups), same-value ceramic capacitors become capacitor
// arrays, 1N4148s pair into dual diodes of the matching topology, small
// transistors pair into duals, and single op-amps on the same supplies share
// a dual or quad.
//
// Applying a proposal removes the member parts, places the package part near
// where they were, and reconnects every pin: stubs to ground / power / net
// labels move to the package pin, other wires are extended or rerouted to it.
// Each connection is checked against the original netlist (nothing split,
// nothing shorted); where no clean route exists, a pair of net labels joins
// the pin to where the old one was.

import type { ComponentDef } from "./component";
import { valueKey } from "./bom";
import { EditError, connect, stubAt } from "./edit";
import { PackKind, packageDef, unitPins } from "./packages";
import { Mount, PartInstance, Project, Wire, buildNetlist, nextRef, onSegment, pinPositions } from "./project";
import { Dir, rotatePoint, symbolFor } from "./symbols";
import { formatValue, parseValue } from "../sim/units";

type Defs = Map<string, ComponentDef>;
type Pt = [number, number];

export interface Proposal {
  kind: PackKind;
  members: string[];
  size: number;
  mount: Mount;
  /** Human-readable summary, e.g. "R1, R2, R3, R4 (10kΩ) share VCC". */
  detail: string;
}

/** Package sizes per kind and mount; an empty list means no such package. */
const SIZES: Record<PackKind, Record<Mount, number[]>> = {
  "res-iso": { tht: [2, 3, 4], smd: [2, 4] },
  "res-bus": { tht: [3, 4, 5, 6, 7, 8], smd: [4, 8] },
  "cap-iso": { tht: [], smd: [2, 4] },
  "diode-cc": { tht: [], smd: [2] },
  "diode-ca": { tht: [], smd: [2] },
  "diode-series": { tht: [], smd: [2] },
  "diode-iso": { tht: [], smd: [2] },
  dual: { tht: [], smd: [2] },
  opamp: { tht: [2, 4], smd: [2, 4] },
};

const DUAL_IDS = ["2N2222", "2N3906", "2N7000"];
const refOrder = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** Split refs into packages: largest size first, then the smallest that holds the rest. */
function chunk(refs: string[], sizes: number[], minMembers = 2): { packs: { members: string[]; size: number }[]; rest: string[] } {
  const packs: { members: string[]; size: number }[] = [];
  if (!sizes.length) return { packs, rest: refs };
  const max = sizes[sizes.length - 1];
  let i = 0;
  while (refs.length - i >= minMembers) {
    const left = refs.length - i;
    const size = left >= max ? max : sizes.find((s) => s >= left)!;
    const take = Math.min(size, left);
    packs.push({ members: refs.slice(i, i + take), size });
    i += take;
  }
  return { packs, rest: refs.slice(i) };
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    m.set(k, [...(m.get(k) ?? []), it]);
  }
  return m;
}

function displayValue(part: PartInstance, def: ComponentDef, key: string, unit: string): string {
  const raw = part.props[key] ?? def.properties.find((p) => p.key === key)?.default ?? "";
  const v = parseValue(raw);
  return isFinite(v) ? formatValue(v, unit) : raw;
}

type DiodeKind = Extract<PackKind, `diode-${string}`>;

/** How two diodes are wired together, which picks the dual-diode package. */
function diodeTopology(a: string, b: string, net: (pin: string) => string | undefined): DiodeKind {
  if (net(`${a}.K`) === net(`${b}.K`)) return "diode-cc";
  if (net(`${a}.A`) === net(`${b}.A`)) return "diode-ca";
  if (net(`${a}.A`) === net(`${b}.K`) || net(`${a}.K`) === net(`${b}.A`)) return "diode-series";
  return "diode-iso";
}

/** Suggest packages for the basic parts on the schematic. */
export function findConsolidations(project: Project, defs: Defs, mount: Mount): Proposal[] {
  const { pinNets } = buildNetlist(project, defs);
  const net = (pin: string) => pinNets.get(pin);
  const free = (id: string) => project.parts.filter((p) => p.defId === id && defs.has(p.defId)).sort((a, b) => refOrder(a.ref, b.ref));
  const out: Proposal[] = [];
  const add = (kind: PackKind, members: string[], size: number, detail: string) => out.push({ kind, members, size, mount, detail });
  const list = (refs: string[]) => refs.join(", ");

  // Resistors: bussed networks on a shared net first, the rest as isolated arrays.
  for (const group of groupBy(free("RES"), (p) => valueKey(p, defs.get("RES")!)).values()) {
    const v = displayValue(group[0], defs.get("RES")!, "R", "Ω");
    const left = new Set(group.map((p) => p.ref));
    const onNet = new Map<string, string[]>();
    for (const p of group) {
      const a = net(`${p.ref}.A`), b = net(`${p.ref}.B`);
      if (!a || !b || a === b) continue;
      for (const n of [a, b]) onNet.set(n, [...(onNet.get(n) ?? []), p.ref]);
    }
    for (const [n, refs] of [...onNet].sort((x, y) => y[1].length - x[1].length)) {
      const { packs } = chunk(refs.filter((r) => left.has(r)), SIZES["res-bus"][mount], 3);
      for (const k of packs) {
        k.members.forEach((r) => left.delete(r));
        add("res-bus", k.members, k.size, `${list(k.members)} (${v}) share ${n}`);
      }
    }
    for (const k of chunk([...left].sort(refOrder), SIZES["res-iso"][mount]).packs) add("res-iso", k.members, k.size, `${list(k.members)} (${v})`);
  }

  for (const group of groupBy(free("CAP"), (p) => valueKey(p, defs.get("CAP")!)).values()) {
    const v = displayValue(group[0], defs.get("CAP")!, "C", "F");
    for (const k of chunk(group.map((p) => p.ref), SIZES["cap-iso"][mount]).packs) add("cap-iso", k.members, k.size, `${list(k.members)} (${v})`);
  }

  // Diodes pair by topology: shared cathode, shared anode, in series, else isolated.
  if (SIZES["diode-cc"][mount].length) {
    const left = free("1N4148").map((p) => p.ref);
    const take = (match: (a: string, b: string) => boolean, kind: DiodeKind) => {
      for (let i = 0; i < left.length; i++) {
        const j = left.findIndex((b, k) => k > i && match(left[i], b));
        if (j < 0) continue;
        const pair = [left[i], left[j]];
        left.splice(j, 1);
        left.splice(i, 1);
        i--;
        add(kind, pair, 2, list(pair));
      }
    };
    for (const kind of ["diode-cc", "diode-ca", "diode-series"] as const) take((a, b) => diodeTopology(a, b, net) === kind, kind);
    take(() => true, "diode-iso");
  }

  for (const id of DUAL_IDS) {
    for (const k of chunk(free(id).map((p) => p.ref), SIZES.dual[mount]).packs) add("dual", k.members, k.size, `${list(k.members)} (${id})`);
  }

  // Op-amps can only share a package when they run from the same supplies.
  for (const [supplies, group] of groupBy(free("OPAMP"), (p) => `${net(`${p.ref}.VP`)} / ${net(`${p.ref}.VN`)}`)) {
    for (const k of chunk(group.map((p) => p.ref), SIZES.opamp[mount]).packs) {
      add("opamp", k.members, k.size, `${list(k.members)} on ${supplies}`);
    }
  }
  return out;
}

// --- applying ------------------------------------------------------------------

export interface Consolidated {
  ref: string;
  defId: string;
  members: string[];
  /** Pins joined with net labels because no clean wire route was found. */
  labelled: string[];
}

export interface ConsolidateResult {
  project: Project;
  done: Consolidated[];
  /** Proposals skipped (members gone or changed since they were found). */
  skipped: string[];
}

const DIRV: Record<Dir, Pt> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
const ptKey = ([x, y]: Pt) => `${x},${y}`;
const same = (a: Pt, b: Pt) => a[0] === b[0] && a[1] === b[1];
let seq = 0;
const wireId = () => `cn${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Drop repeated points and the middle of straight runs. */
function tidy(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && same(last, p)) continue;
    const prev = out[out.length - 2];
    if (prev && ((prev[0] === last[0] && last[0] === p[0]) || (prev[1] === last[1] && last[1] === p[1]))) out.pop();
    out.push(p);
  }
  return out;
}

type Rect = [number, number, number, number];

/** Body rectangle (without pins) in schematic coordinates. */
function bodyRect(part: PartInstance, def: ComponentDef): Rect {
  const g = symbolFor(def);
  const a = rotatePoint(-g.w / 2, -g.h / 2, part.rot, part.mirror), b = rotatePoint(g.w / 2, g.h / 2, part.rot, part.mirror);
  return [part.x + Math.min(a[0], b[0]), part.y + Math.min(a[1], b[1]), part.x + Math.max(a[0], b[0]), part.y + Math.max(a[1], b[1])];
}

/** Body plus pins. */
function fullRect(part: PartInstance, def: ComponentDef): Rect {
  const [x0, y0, x1, y1] = bodyRect(part, def);
  const tips = pinPositions(part, def);
  return [Math.min(x0, ...tips.map((t) => t.x)), Math.min(y0, ...tips.map((t) => t.y)), Math.max(x1, ...tips.map((t) => t.x)), Math.max(y1, ...tips.map((t) => t.y))];
}

const overlaps = (a: Rect, b: Rect) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/** Whether an orthogonal segment passes through the inside of a rectangle. */
function crosses(a: Pt, b: Pt, r: Rect): boolean {
  const [lx, hx] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
  const [ly, hy] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  if (lx === hx) return lx > r[0] && lx < r[2] && hy > r[1] && ly < r[3];
  if (ly === hy) return ly > r[1] && ly < r[3] && hx > r[0] && lx < r[2];
  return overlaps([lx, ly, hx, hy], r);
}

/** Candidate orthogonal routes from S to pin tip P, leaving the pin outwards first. */
function routes(S: Pt, P: Pt, dir: Dir): Pt[][] {
  const [dx, dy] = DIRV[dir];
  const out: Pt[][] = [];
  for (const k of [0, 20, 40, 60, 80]) {
    const E: Pt = [P[0] + dx * k, P[1] + dy * k];
    out.push([S, [S[0], E[1]], E, P], [S, [E[0], S[1]], E, P]);
  }
  // Dog-legs: out of the pin, across in a free channel, then to S.
  for (const k of [20, 40]) {
    const E: Pt = [P[0] + dx * k, P[1] + dy * k];
    for (const off of [40, -40, 80, -80, 120, -120]) {
      if (dx) out.push([S, [S[0], E[1] + off], [E[0], E[1] + off], E, P]);
      else out.push([S, [E[0] + off, S[1]], [E[0] + off, E[1]], E, P]);
    }
  }
  const seen = new Set<string>();
  return out.map(tidy).filter((r) => r.length > 1 && !seen.has(r.map(ptKey).join()) && !!seen.add(r.map(ptKey).join()));
}

function namedNet(name: string): boolean {
  return !/^N\d{3,}$/.test(name);
}

function replace(project: Project, defs: Defs, pr: Proposal): { project: Project; done: Consolidated } | null {
  const members = pr.members.map((r) => project.parts.find((q) => q.ref === r));
  if (members.some((m) => !m)) return null;
  const parts = members as PartInstance[];
  const base = defs.get(parts[0].defId);
  if (!base || parts.some((m) => m.defId !== base.id)) return null;
  const pkg = packageDef(pr.kind, pr.size, base);
  defs.set(pkg.id, pkg);

  const before = buildNetlist(project, defs);
  const net = (pin: string) => before.pinNets.get(pin)!;
  const order = [...parts];
  if (pr.kind === "diode-series" && net(`${order[0].ref}.K`) !== net(`${order[1].ref}.A`)) order.reverse();
  const units = unitPins(pr.kind, pr.size, base);
  let common: string | undefined;
  if (pr.kind === "res-bus") {
    const sets = order.map((m) => [net(`${m.ref}.A`), net(`${m.ref}.B`)]);
    common = sets[0].find((n) => sets.every((s) => s.includes(n)));
  }

  // Every member pin: where it was, which package pin takes over, its net.
  interface Old { key: string; tip: Pt; pin: string; net: string }
  const olds: Old[] = [];
  order.forEach((m, i) => {
    let map = units[i];
    // Resistors are symmetric: put whichever end is on the common net on COM.
    if (pr.kind === "res-bus" && net(`${m.ref}.B`) === common) map = { A: map.B, B: map.A };
    for (const t of pinPositions(m, base)) olds.push({ key: `${m.ref}.${t.id}`, tip: [t.x, t.y], pin: map[t.id], net: net(`${m.ref}.${t.id}`) });
  });
  const memberRefs = new Set(pr.members);
  const netPins = new Map<string, string[]>();
  for (const [k, n] of before.pinNets) netPins.set(n, [...(netPins.get(n) ?? []), k]);
  // A pin needs reconnecting when its net reaches anything besides pins that land on the same package pin.
  const relevant = olds.filter((o) => (netPins.get(o.net) ?? []).some((k) => !olds.some((x) => x.key === k && x.pin === o.pin)));

  let p: Project = { ...project, parts: project.parts.filter((q) => !memberRefs.has(q.ref)) };

  // Stubs ending in a ground, power or label terminal move with the pin.
  const terminals = new Map<Old, { name: string; volts?: number }>();
  const removedRefs = new Set<string>();
  for (const o of relevant) {
    const s = stubAt(p, defs, { x: o.tip[0], y: o.tip[1] });
    if (!s?.terminal) continue;
    const w = s.wire.points;
    const touching = p.wires.filter((x) => x.points.some((q) => same(q, o.tip))).length;
    if (!(same(w[0], o.tip) || same(w[w.length - 1], o.tip)) || touching !== 1) continue;
    const t = s.terminal;
    // Only a private stub: the terminal must not also feed other wires or pins.
    const [tp] = pinPositions(t, defs.get(t.defId)!);
    const tPt: Pt = [tp.x, tp.y];
    const shared = p.wires.some((x) => x !== s.wire && x.points.some((q, i) => same(q, tPt) || (i > 0 && onSegment(tPt[0], tPt[1], x.points[i - 1], q))))
      || p.parts.some((q) => q !== t && defs.has(q.defId) && pinPositions(q, defs.get(q.defId)!).some((u) => u.x === tPt[0] && u.y === tPt[1]));
    if (shared) continue;
    terminals.set(o, t.defId === "GROUND" ? { name: "GND" } : t.defId === "POWER"
      ? { name: t.props.NET || "VCC", volts: Number(t.props.VOLTAGE ?? 5) } : { name: t.props.NAME || "NET" });
    removedRefs.add(t.ref);
    p = { ...p, wires: p.wires.filter((x) => x !== s.wire), parts: p.parts.filter((x) => x !== t) };
  }

  // --- place the package near the members it replaces ---
  const ref = nextRef(p, pkg.refPrefix);
  const props = Object.fromEntries(pkg.properties.flatMap((d) => (parts[0].props[d.key] !== undefined ? [[d.key, parts[0].props[d.key]]] : [])));
  const snap = (v: number) => Math.round(v / 20) * 20;
  const cx = snap(parts.reduce((s, m) => s + m.x, 0) / parts.length), cy = snap(parts.reduce((s, m) => s + m.y, 0) / parts.length);
  const others = p.parts.filter((q) => defs.has(q.defId));
  const otherRects = others.map((q) => fullRect(q, defs.get(q.defId)!));
  const otherTips = new Set(others.flatMap((q) => pinPositions(q, defs.get(q.defId)!).map((t) => `${t.x},${t.y}`)));
  const segsOf = (ws: Wire[]) => ws.flatMap((w) => w.points.slice(1).map((b, i) => [w.points[i], b] as [Pt, Pt]));
  const segs = segsOf(p.wires);
  // Wires into the old pins get rerouted, so the package may sit over them.
  const staying = segsOf(p.wires.filter((w) => !w.points.some((q) => olds.some((o) => same(o.tip, q)))));
  const offsets: Pt[] = [];
  for (let dx = -600; dx <= 600; dx += 20) for (let dy = -600; dy <= 600; dy += 20) offsets.push([dx, dy]);
  offsets.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
  const fits = (inst: PartInstance, strict: boolean) => {
    const r = fullRect(inst, pkg);
    const padded: Rect = [r[0] - 20, r[1] - 30, r[2] + 20, r[3] + 20];
    if (otherRects.some((o) => overlaps(padded, o))) return false;
    for (const t of pinPositions(inst, pkg)) {
      if (otherTips.has(`${t.x},${t.y}`) || segs.some(([a, b]) => onSegment(t.x, t.y, a, b))) return false;
    }
    if (!strict) return true;
    return !staying.some(([a, b]) => crosses(a, b, r));
  };
  let inst: PartInstance | undefined;
  for (const strict of [true, false]) {
    for (const [dx, dy] of offsets) {
      const at: PartInstance = { ref, defId: pkg.id, x: cx + dx, y: cy + dy, rot: 0, props };
      if (fits(at, strict)) { inst = at; break; }
    }
    if (inst) break;
  }
  inst ??= { ref, defId: pkg.id, x: cx, y: cy - 200, rot: 0, props };
  p = {
    ...p,
    parts: [...p.parts, inst],
    embeddedParts: [...(p.embeddedParts ?? []).filter((d) => d.id !== pkg.id), pkg],
  };

  // --- reconnect ---
  const sym = new Map(symbolFor(pkg).pins.map((s) => [s.id, s]));
  const tipOf = (pin: string): { P: Pt; dir: Dir } => {
    const s = sym.get(pin)!;
    return { P: [inst!.x + s.x, inst!.y + s.y], dir: s.dir };
  };
  /** Pins whose original net must be kept: everything still on the sheet, plus the package's pins. */
  const expected = new Map<string, string>();
  for (const [k, n] of before.pinNets) if (!memberRefs.has(k.split(".")[0]) && !removedRefs.has(k.split(".")[0])) expected.set(k, n);
  for (const o of relevant) expected.set(`${ref}.${o.pin}`, o.net);
  const pkgBody = bodyRect(inst, pkg);

  const shorted = (trial: Project) => {
    const nets = buildNetlist(trial, defs).pinNets;
    const seen = new Map<string, string>();
    for (const [k, orig] of expected) {
      const t = nets.get(k);
      if (!t) continue;
      const prev = seen.get(t);
      if (prev !== undefined && prev !== orig) return true;
      seen.set(t, orig);
    }
    return false;
  };
  const splitNets = (trial: Project) => {
    const nets = buildNetlist(trial, defs).pinNets;
    const by = new Map<string, Set<string>>();
    for (const [k, orig] of expected) {
      const t = nets.get(k);
      if (t) by.set(orig, (by.get(orig) ?? new Set()).add(t));
    }
    return new Set([...by].filter(([, s]) => s.size > 1).map(([n]) => n));
  };
  /** Something at the old pin location to connect to: a wire or another part's pin. */
  const anchorAt = (proj: Project, T: Pt): { wire?: string; pin?: string } | null => {
    const w = proj.wires.find((x) => x.points.some((q, i) => same(q, T) || (i > 0 && onSegment(T[0], T[1], x.points[i - 1], q))));
    if (w) return { wire: w.id };
    for (const q of proj.parts) {
      const d = defs.get(q.defId);
      const t = d && pinPositions(q, d).find((t) => t.x === T[0] && t.y === T[1]);
      if (t) return { pin: `${q.ref}.${t.id}` };
    }
    return null;
  };
  const joined = (proj: Project, pinKey: string, a: { wire?: string; pin?: string }) => {
    const nl = buildNetlist(proj, defs);
    const there = a.wire ? nl.wireNets.get(a.wire) : nl.pinNets.get(a.pin!);
    return there !== undefined && there === nl.pinNets.get(pinKey);
  };

  const labelled: string[] = [];
  const label = (o: Old) => {
    const pinKey = `${ref}.${o.pin}`;
    const name = namedNet(o.net) ? o.net : `${ref}_${o.pin}`;
    try { p = connect(p, defs, name, [pinKey]).project; } catch (e) { if (!(e instanceof EditError)) throw e; }
    const a = anchorAt(p, o.tip);
    if (a && !joined(p, pinKey, a)) {
      const lbl: PartInstance = { ref: nextRef(p, "LBL"), defId: "NETLABEL", x: o.tip[0] + 10, y: o.tip[1], rot: 0, props: { NAME: name } };
      p = { ...p, parts: [...p.parts, lbl] };
    }
    if (!labelled.includes(o.pin)) labelled.push(o.pin);
  };

  for (const [o, t] of terminals) {
    try { p = connect(p, defs, t.name, [`${ref}.${o.pin}`], t.volts).project; }
    catch (e) { if (!(e instanceof EditError)) throw e; }
  }

  const bodies = () => p.parts.filter((q) => defs.has(q.defId)).map((q) => bodyRect(q, defs.get(q.defId)!));
  for (const o of relevant) {
    if (terminals.has(o)) continue;
    const pinKey = `${ref}.${o.pin}`;
    const a = anchorAt(p, o.tip);
    if (!a) continue; // nothing left there; another pin of this net carries the connection
    if (joined(p, pinKey, a)) continue;
    const { P, dir } = tipOf(o.pin);
    // A lone wire ending here is extended (or pulled back and rerouted) rather than joined by a new one.
    const atT = p.wires.filter((w) => w.points.some((q) => same(q, o.tip)));
    const lone = atT.length === 1 && (same(atT[0].points[0], o.tip) || same(atT[0].points[atT[0].points.length - 1], o.tip))
      && !p.parts.some((q) => defs.has(q.defId) && pinPositions(q, defs.get(q.defId)!).some((t) => t.x === o.tip[0] && t.y === o.tip[1]))
      && !p.wires.some((w) => w !== atT[0] && w.points.some((q, i) => i > 0 && onSegment(o.tip[0], o.tip[1], w.points[i - 1], q)))
      ? atT[0] : null;
    const tries: { wires: Wire[]; cost: number }[] = [];
    const cost = (pts: Pt[]) => {
      let len = 0;
      for (let i = 1; i < pts.length; i++) len += Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
      // Arriving along the pin, from outside the part, reads as a proper connection.
      const prev = pts[pts.length - 2];
      const [ux, uy] = DIRV[dir];
      const along = prev && Math.sign(prev[0] - P[0]) === ux && Math.sign(prev[1] - P[1]) === uy;
      return len + 30 * (pts.length - 2) + (along ? 0 : 200);
    };
    if (lone) {
      const pts = same(lone.points[lone.points.length - 1], o.tip) ? lone.points : [...lone.points].reverse();
      for (const back of [2, 1, 0]) {
        if (pts.length - back < 1) continue;
        const keep = pts.slice(0, pts.length - back) as Pt[];
        for (const r of routes(keep[keep.length - 1], P, dir)) {
          const pts = tidy([...keep, ...r.slice(1)]);
          tries.push({ wires: p.wires.map((w) => (w === lone ? { ...w, points: pts } : w)), cost: cost(r) });
        }
      }
    }
    // A separate wire from the old pin spot costs a little more than reusing the one already there.
    for (const r of routes(o.tip, P, dir)) tries.push({ wires: [...p.wires, { id: wireId(), points: r }], cost: cost(r) + 40 });
    tries.sort((a, b) => a.cost - b.cost);

    const all = bodies();
    const clear = (ws: Wire[], strict: boolean) => ws.every((w) => p.wires.includes(w) || w.points.slice(1).every((q, i) => {
      const a0 = w.points[i] as Pt;
      return !crosses(a0, q as Pt, pkgBody) && (!strict || all.every((r) => !crosses(a0, q as Pt, r)));
    }));
    let ok = false;
    for (const strict of [true, false]) {
      for (const { wires: ws } of tries) {
        if (!clear(ws, strict)) continue;
        const trial = { ...p, wires: ws };
        if (shorted(trial)) continue;
        // The lone wire may have been rerouted away from T; its own id is the anchor then.
        if (!joined(trial, pinKey, lone ? { wire: lone.id } : a)) continue;
        p = trial;
        ok = true;
        break;
      }
      if (ok) break;
    }
    if (!ok) label(o);
  }

  // Wires that now end in mid-air at an old pin location are leftovers; drop them unless something needs them.
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const w of [...p.wires]) {
      const ends = [w.points[0], w.points[w.points.length - 1]] as Pt[];
      const dead = ends.some((e) => olds.some((o) => same(o.tip, e)) && !anchorAt({ ...p, wires: p.wires.filter((x) => x !== w) }, e));
      if (!dead) continue;
      const trial = { ...p, wires: p.wires.filter((x) => x !== w) };
      if (splitNets(trial).size || shorted(trial)) continue;
      p = trial;
      changed = true;
    }
    if (!changed) break;
  }

  // Last check: any net still split gets labels.
  for (const n of splitNets(p)) for (const o of relevant.filter((x) => x.net === n)) label(o);

  return { project: p, done: { ref, defId: pkg.id, members: pr.members, labelled } };
}

/** Replace each proposal's parts with its package part and reconnect the wiring. */
export function consolidate(project: Project, defs: Defs, proposals: Proposal[]): ConsolidateResult {
  const all = new Map(defs);
  let p = project;
  const done: Consolidated[] = [];
  const skipped: string[] = [];
  for (const pr of proposals) {
    const r = replace(p, all, pr);
    if (!r) { skipped.push(pr.members.join(", ")); continue; }
    p = r.project;
    done.push(r.done);
  }
  return { project: p, done, skipped };
}

