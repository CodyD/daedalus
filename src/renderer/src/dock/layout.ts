// Tool-window layout in the style of Visual Studio: the main window is a tree
// of splits whose leaves are tab groups and the document (schematic), plus
// floating windows. Pure data and functions so it can be persisted and
// unit-tested.

export const PANELS = ["parts", "properties", "assistant", "emulator", "output", "terminal", "scope", "cpu", "firmware"] as const;
export type PanelId = (typeof PANELS)[number];

export const PANEL_TITLES: Record<PanelId, string> = {
  parts: "Parts",
  properties: "Properties",
  assistant: "AI Assistant",
  emulator: "Sensor Emulator",
  output: "Output",
  terminal: "Virtual Terminal",
  scope: "Oscilloscope",
  cpu: "CPU Registers",
  firmware: "Firmware",
};

export type Side = "left" | "right" | "top" | "bottom";
export const SIDES: Side[] = ["left", "right", "top", "bottom"];

export interface Group {
  kind: "group";
  id: string;
  panels: PanelId[];
  active: PanelId;
  /** Collapsed to a tab on the nearest window edge (VS "auto hide"); keeps its place in the tree. */
  autoHide?: boolean;
}

export interface Doc {
  kind: "doc";
  id: "doc";
}

export interface Split {
  kind: "split";
  id: string;
  /** row: children side by side; col: children stacked. */
  dir: "row" | "col";
  children: Node[];
  /**
   * One per child. In a split that contains the document these are pixel
   * sizes and the document's branch takes the remaining space; otherwise
   * they are relative weights.
   */
  sizes: number[];
}

export type Node = Group | Doc | Split;

export interface Float {
  id: string;
  panels: PanelId[];
  active: PanelId;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  v: 2;
  root: Node;
  floats: Float[];
  /** Closed tool windows. They keep their place so reopening restores it. */
  hidden: PanelId[];
}

export type DropTarget =
  /** Outer guide: a new full-length pane along the main window edge. */
  | { kind: "edge"; side: Side }
  /** Compass arrow: split the document or a tool window and dock beside it. */
  | { kind: "beside"; nodeId: string; side: Side }
  /** Compass centre (or anywhere over a window): add as a tab. */
  | { kind: "tab"; groupId: string }
  | { kind: "float"; x: number; y: number; w: number; h: number };

/** Default pixel size of a newly docked pane across its dock direction. */
export const NEW_PANE = { row: 280, col: 220 };

let seq = 0;
export const newId = (): string => `g${Date.now().toString(36)}${(seq++).toString(36)}`;

const group = (id: string, panels: PanelId[]): Group => ({ kind: "group", id, panels, active: panels[0] });
const DOC: Doc = { kind: "doc", id: "doc" };

export function defaultLayout(): Layout {
  return {
    v: 2,
    root: {
      kind: "split", id: "main", dir: "row",
      children: [
        group("left", ["parts"]),
        {
          kind: "split", id: "center", dir: "col",
          children: [DOC, group("bottom", ["output", "terminal", "scope", "cpu", "firmware"])],
          sizes: [1, 240],
        },
        group("right", ["properties", "assistant", "emulator"]),
      ],
      sizes: [240, 1, 320],
    },
    floats: [],
    hidden: [],
  };
}

const STORE_KEY = "daedalus.layout";

export function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch { /* storage unavailable or corrupt */ }
  return defaultLayout();
}

export function saveLayout(l: Layout): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(l));
  } catch { /* storage unavailable */ }
}

// --- tree helpers --------------------------------------------------------------

export const hasDoc = (n: Node): boolean => n.kind === "doc" || (n.kind === "split" && n.children.some(hasDoc));

export function* groups(n: Node): Generator<Group> {
  if (n.kind === "group") yield n;
  else if (n.kind === "split") for (const c of n.children) yield* groups(c);
}

/** Path of nodes from the root down to the node with this id. */
function pathTo(n: Node, id: string): Node[] | null {
  if (n.id === id) return [n];
  if (n.kind !== "split") return null;
  for (const c of n.children) {
    const p = pathTo(c, id);
    if (p) return [n, ...p];
  }
  return null;
}

export function findNode(l: Layout, id: string): Node | undefined {
  return pathTo(l.root, id)?.at(-1);
}

function mapTree(n: Node, fn: (n: Node) => Node): Node {
  const m = n.kind === "split" ? { ...n, children: n.children.map((c) => mapTree(c, fn)) } : n;
  return fn(m);
}

/**
 * Removes empty groups and collapses splits with one child or with a child
 * split in the same direction, keeping sizes consistent.
 */
function tidy(n: Node): Node | null {
  if (n.kind === "group") return n.panels.length ? n : null;
  if (n.kind === "doc") return n;
  const children: Node[] = [];
  const sizes: number[] = [];
  n.children.forEach((c0, i) => {
    const c = tidy(c0);
    if (!c) return;
    if (c.kind === "split" && c.dir === n.dir) {
      // Merge. A doc-free child holds weights; convert them to this split's units.
      const sum = c.sizes.reduce((a, b) => a + b, 0) || 1;
      const scale = hasDoc(c) ? null : n.sizes[i] / sum;
      c.children.forEach((cc, j) => {
        children.push(cc);
        sizes.push(scale === null ? c.sizes[j] : c.sizes[j] * scale);
      });
      return;
    }
    children.push(c);
    sizes.push(n.sizes[i]);
  });
  if (!children.length) return null;
  if (children.length === 1) return children[0];
  return { ...n, children, sizes };
}

// --- persistence ---------------------------------------------------------------

/** Repairs a stored layout: drops unknown or duplicate panels, re-adds missing ones where the default puts them. */
export function normalize(input: unknown): Layout {
  const l = input as Layout;
  if (!l || l.v !== 2 || !l.root) return defaultLayout();
  const seen = new Set<PanelId>();
  const ids = new Set<string>();
  let docs = 0;
  const clean = (panels: unknown): PanelId[] => (Array.isArray(panels) ? panels : []).filter((p): p is PanelId => {
    if (!PANELS.includes(p) || seen.has(p)) return false;
    seen.add(p);
    return true;
  });
  const walk = (n: Node): Node | null => {
    if (!n || typeof n !== "object" || typeof n.id !== "string" || ids.has(n.id)) return null;
    ids.add(n.id);
    if (n.kind === "doc") { docs++; return DOC; }
    if (n.kind === "group") {
      const panels = clean(n.panels);
      return { kind: "group", id: n.id, panels, active: panels.includes(n.active) ? n.active : panels[0], autoHide: n.autoHide || undefined };
    }
    if (n.kind === "split" && (n.dir === "row" || n.dir === "col") && Array.isArray(n.children)) {
      const kept: Node[] = [];
      const sizes: number[] = [];
      n.children.forEach((c, i) => {
        const w = walk(c);
        if (!w) return;
        kept.push(w);
        const s = n.sizes?.[i];
        sizes.push(Number.isFinite(s) && s > 0 ? s : 1);
      });
      return { kind: "split", id: n.id, dir: n.dir, children: kept, sizes };
    }
    return null;
  };
  const root = walk(l.root);
  const tidied = root && tidy(root);
  if (!tidied || docs !== 1) return defaultLayout();
  let out: Layout = {
    v: 2,
    root: tidied,
    floats: (Array.isArray(l.floats) ? l.floats : []).map((f) => ({ ...f, panels: clean(f.panels) })).filter((f) => f.panels.length)
      .map((f) => ({ ...f, active: f.panels.includes(f.active) ? f.active : f.panels[0] })),
    hidden: (Array.isArray(l.hidden) ? l.hidden : []).filter((p) => PANELS.includes(p)),
  };
  // Panels added in a newer version (or lost): put them back beside their default neighbours.
  const def = defaultLayout();
  for (const p of PANELS) {
    if (seen.has(p)) continue;
    const home = [...groups(def.root)].find((g) => g.panels.includes(p))!;
    const host = [...groups(out.root)].find((g) => g.panels.some((q) => home.panels.includes(q)));
    out = dock(out, [p], p, host ? { kind: "tab", groupId: host.id } : { kind: "edge", side: home.id as Side });
  }
  return out;
}

// --- queries -------------------------------------------------------------------

/** Where a panel currently lives. */
export function locate(l: Layout, id: PanelId): { group: Group } | { float: Float } | null {
  const g = [...groups(l.root)].find((x) => x.panels.includes(id));
  if (g) return { group: g };
  const f = l.floats.find((x) => x.panels.includes(id));
  return f ? { float: f } : null;
}

export function findGroup(l: Layout, id: string): Group | Float | undefined {
  return [...groups(l.root)].find((x) => x.id === id) ?? l.floats.find((f) => f.id === id);
}

export const isVisible = (l: Layout, id: PanelId): boolean => !l.hidden.includes(id);
export const visiblePanels = (l: Layout, panels: PanelId[]): PanelId[] => panels.filter((p) => isVisible(l, p));

/** Active panel to show for a group, skipping closed ones. */
export function shownActive(l: Layout, g: { panels: PanelId[]; active: PanelId }): PanelId | undefined {
  return isVisible(l, g.active) ? g.active : visiblePanels(l, g.panels)[0];
}

/** Which window edge an auto-hidden group collapses to: the side of the document it sits on. */
export function edgeOf(l: Layout, groupId: string): Side {
  const a = pathTo(l.root, groupId) ?? [];
  const b = pathTo(l.root, "doc") ?? [];
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const split = a[i - 1];
  if (split?.kind !== "split") return "left";
  const before = split.children.indexOf(a[i]) < split.children.indexOf(b[i]);
  return split.dir === "row" ? (before ? "left" : "right") : (before ? "top" : "bottom");
}

/** Pixel size of a docked node across its parent's direction, if its parent sizes in pixels. */
export function pixelSize(l: Layout, nodeId: string): number | null {
  const p = pathTo(l.root, nodeId);
  const parent = p?.at(-2);
  if (!p || parent?.kind !== "split" || !hasDoc(parent)) return null;
  const node = p.at(-1)!;
  return hasDoc(node) ? null : parent.sizes[parent.children.indexOf(node)];
}

// --- edits ---------------------------------------------------------------------

/** Takes panels out of wherever they are, dropping groups, splits and floats left empty. */
export function remove(l: Layout, ids: PanelId[]): Layout {
  const strip = <T extends { panels: PanelId[]; active: PanelId }>(g: T): T => {
    const panels = g.panels.filter((p) => !ids.includes(p));
    return { ...g, panels, active: panels.includes(g.active) ? g.active : panels[0] };
  };
  const root = tidy(mapTree(l.root, (n) => (n.kind === "group" ? strip(n) : n)))!;
  return { ...l, root, floats: l.floats.map(strip).filter((f) => f.panels.length) };
}

/** Docks node g beside the node with targetId (or the whole root), on the given side. */
function insertBeside(root: Node, targetId: string | null, side: Side, g: Group): Node {
  const dir = side === "left" || side === "right" ? "row" : "col";
  const before = side === "left" || side === "top";
  const target = targetId ? pathTo(root, targetId) : [root];
  if (!target) return root;
  const t = target.at(-1)!;
  const parent = target.at(-2) as Split | undefined;
  const tDoc = hasDoc(t);

  // Into the parent split when it already runs the right way (or the target is a same-direction root).
  const host = parent && parent.dir === dir ? parent : !parent && t.kind === "split" && t.dir === dir ? t : null;
  if (host) {
    const children = [...host.children];
    const sizes = [...host.sizes];
    let at: number;
    let size: number;
    if (host === t) {
      at = before ? 0 : children.length;
      size = NEW_PANE[dir];
    } else {
      const i = children.indexOf(t);
      at = before ? i : i + 1;
      if (tDoc) size = NEW_PANE[dir];
      else {
        size = sizes[i] / 2;
        sizes[i] = size;
      }
    }
    children.splice(at, 0, g);
    sizes.splice(at, 0, size);
    const next: Split = { ...host, children, sizes };
    return host === root ? next : mapTree(root, (n) => (n.id === host.id ? next : n));
  }

  // Otherwise wrap the target in a new split.
  const wrap: Split = {
    kind: "split", id: newId(), dir,
    children: before ? [g, t] : [t, g],
    sizes: tDoc ? (before ? [NEW_PANE[dir], 1] : [1, NEW_PANE[dir]]) : [1, 1],
  };
  return t === root ? wrap : mapTree(root, (n) => (n.id === t.id ? wrap : n));
}

/** Moves panels (one tab, or a whole group) to a drop target. */
export function dock(l: Layout, ids: PanelId[], active: PanelId, target: DropTarget): Layout {
  // Dropping a window onto itself is a no-op.
  if (target.kind === "tab" || target.kind === "beside") {
    const id = target.kind === "tab" ? target.groupId : target.nodeId;
    const g = findGroup(l, id);
    if (target.kind === "tab" && !g) return l;
    if (g && g.panels.every((p) => ids.includes(p))) return l;
  }
  const base = remove(l, ids);
  const g: Group = { kind: "group", id: newId(), panels: ids, active };
  switch (target.kind) {
    case "edge":
      return { ...base, root: insertBeside(base.root, null, target.side, g) };
    case "beside":
      return { ...base, root: insertBeside(base.root, target.nodeId, target.side, g) };
    case "tab":
      return mapGroups(base, target.groupId, (x) => ({ ...x, panels: [...x.panels, ...ids], active }));
    case "float": {
      const { x, y, w, h } = target;
      return { ...base, floats: [...base.floats, { id: newId(), panels: ids, active, x, y, w, h }] };
    }
  }
}

/** Applies fn to the docked group or float with this id. */
export function mapGroups(l: Layout, id: string, fn: <T extends Group | Float>(g: T) => T): Layout {
  return {
    ...l,
    root: mapTree(l.root, (n) => (n.kind === "group" && n.id === id ? fn(n) : n)),
    floats: l.floats.map((f) => (f.id === id ? fn(f) : f)),
  };
}

export function setHidden(l: Layout, id: PanelId, hidden: boolean): Layout {
  const rest = l.hidden.filter((p) => p !== id);
  return { ...l, hidden: hidden ? [...rest, id] : rest };
}

/** Opens a panel (if closed) and brings it to the front of its group. */
export function activate(l: Layout, id: PanelId): Layout {
  const shown = setHidden(l, id, false);
  const at = locate(shown, id);
  if (!at) return shown;
  const gid = "float" in at ? at.float.id : at.group.id;
  return mapGroups(shown, gid, (g) => ({ ...g, active: id }));
}

export function setSizes(l: Layout, splitId: string, sizes: number[]): Layout {
  return { ...l, root: mapTree(l.root, (n) => (n.kind === "split" && n.id === splitId ? { ...n, sizes } : n)) };
}
