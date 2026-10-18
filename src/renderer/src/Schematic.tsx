import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentDef } from "../../shared/component";
import { PartInstance, Project, Wire, pinPositions } from "../../shared/project";
import { GRID, Rotation, symbolFor } from "../../shared/symbols";
import { formatValue } from "../../sim/units";
import type { Frame } from "./sim.worker";
import { PartView, valueLabel } from "./PartView";
import { announce } from "./a11y";
import { isTerminal, transformPart } from "../../shared/edit";
import { Pt, hopPath, lRoute, manhattanTree, segmentsOf } from "./wiring";

export type Selection = { kind: "part"; ref: string } | { kind: "wire"; id: string } | null;
export type Mode = { kind: "select" } | { kind: "place"; defId: string; rot: Rotation } | { kind: "wire" };

interface Props {
  project: Project;
  defs: Map<string, ComponentDef>;
  mode: Mode;
  setMode: (m: Mode) => void;
  selection: Selection;
  setSelection: (s: Selection) => void;
  /** Edit the project; edits sharing a `group` collapse into one undo step. */
  onChange: (fn: (p: Project) => Project, group?: string) => void;
  onPlace: (defId: string, x: number, y: number, rot: Rotation) => void;
  frame: Frame | null;
  wireNets: Map<string, string>;
  pinNets: Map<string, string>;
  onActuate: (ref: string, action: Record<string, unknown>) => void;
  /** Open the sensor emulator for an emulated part. */
  onEmulator?: (ref: string) => void;
  /** View settings: draw net labels, and (with labels shown) routed lines between same-named ones. */
  showLabels: boolean;
  showLinks: boolean;
}

const snap = (v: number) => Math.round(v / GRID) * GRID;
const key = (x: number, y: number) => `${x},${y}`;
const LEVEL = ["low", "high", "floating", "conflict"];

/** What a net is doing right now, in words (for the screen reader). */
function netState(frame: Frame | null, net: string | undefined): string {
  const st = net ? frame?.nets[net] : undefined;
  if (!st) return "";
  if (st.v !== undefined) return formatValue(st.v, "V");
  return LEVEL[st.level ?? 2] ?? "";
}

/** Keys the schematic handles while it has focus, for the screen reader and the hint line. */
const KEY_HELP = "Keys: N or Shift+N select the next or previous part. Arrows move the selected part, or pan with nothing selected. " +
  "R rotate, M mirror, Delete remove, I describe the selection, plus and minus zoom. While simulating, Enter or Space operates the selected button or switch. " +
  "With a part picked from the library, arrows move it and Enter places it. Escape cancels.";

function lPath(from: [number, number], to: [number, number]): [number, number][] {
  if (from[0] === to[0] || from[1] === to[1]) return [to];
  return [[to[0], from[1]], to];
}

export function Schematic(p: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ x: -400, y: -300, scale: 1.2 });
  const [cursor, setCursor] = useState<[number, number]>([0, 0]);
  const [drawing, setDrawing] = useState<[number, number][] | null>(null);
  // `base` is the sheet as it was when the drag began: each step re-applies the
  // whole move to it, so rerouted wires never pile up corners along the way.
  const [drag, setDrag] = useState<{ id: number; ref: string; dx: number; dy: number; moved: boolean; base: Project } | null>(null);
  const [pan, setPan] = useState<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [hoverTerm, setHoverTerm] = useState<string | null>(null);
  /** The sheet has keyboard focus: show keyboard hints and the placement ghost at the keyboard cursor. */
  const [kbd, setKbd] = useState(false);
  const simulating = !!p.frame;

  const pins = useMemo(() => {
    const out: { ref: string; id: string; x: number; y: number }[] = [];
    for (const part of p.project.parts) {
      const def = p.defs.get(part.defId);
      if (def) for (const pp of pinPositions(part, def)) out.push({ ref: part.ref, ...pp });
    }
    return out;
  }, [p.project.parts, p.defs]);

  // Ground, power and net-label terminals: joined by name, not by a drawn wire.
  const terminals = useMemo(() => {
    const out: { ref: string; net: string; at: Pt }[] = [];
    for (const part of p.project.parts) {
      const def = p.defs.get(part.defId);
      if (!def || !isTerminal(part.defId)) continue;
      const tip = pinPositions(part, def)[0];
      const net = tip && p.pinNets.get(`${part.ref}.${tip.id}`);
      if (net) out.push({ ref: part.ref, net, at: [tip.x, tip.y] });
    }
    return out;
  }, [p.project.parts, p.defs, p.pinNets]);

  // Labels hidden: drop each label and the stub wire from its pin, and route the
  // label's net directly between those pins instead.
  const direct = useMemo(() => {
    if (p.showLabels) return null;
    const defOf = (ref: string) => p.project.parts.find((q) => q.ref === ref)?.defId ?? "";
    const compPins = pins.filter((q) => !isTerminal(defOf(q.ref)));
    const hidden = new Set<string>();
    const ends = new Map<string, Pt[]>();
    for (const l of terminals) {
      if (defOf(l.ref) !== "NETLABEL") continue;
      let end: Pt = l.at;
      for (const w of p.project.wires) {
        const a = w.points[0], b = w.points[w.points.length - 1];
        if (!a || !b) continue;
        const other = a[0] === l.at[0] && a[1] === l.at[1] ? b : b[0] === l.at[0] && b[1] === l.at[1] ? a : null;
        if (other && compPins.some((q) => q.x === other[0] && q.y === other[1])) {
          hidden.add(w.id);
          end = other;
          break;
        }
      }
      ends.set(l.net, [...(ends.get(l.net) ?? []), end]);
    }
    const routes: { net: string; points: Pt[] }[] = [];
    for (const [net, pts] of ends) {
      for (const [a, b] of manhattanTree(pts)) {
        if (pts[a][0] !== pts[b][0] || pts[a][1] !== pts[b][1]) routes.push({ net, points: lRoute(pts[a], pts[b]) });
      }
    }
    return { hidden, routes };
  }, [p.showLabels, p.project.parts, p.project.wires, pins, terminals]);

  // Routed stand-ins for name-joined connections (a spanning tree per net).
  const links = useMemo(() => {
    if (!p.showLinks || !p.showLabels) return [];
    const byNet = new Map<string, Pt[]>();
    for (const t of terminals) byNet.set(t.net, [...(byNet.get(t.net) ?? []), t.at]);
    const out: { net: string; points: Pt[] }[] = [];
    for (const [net, pts] of byNet) {
      for (const [a, b] of manhattanTree(pts)) {
        if (pts[a][0] !== pts[b][0] || pts[a][1] !== pts[b][1]) out.push({ net, points: lRoute(pts[a], pts[b]) });
      }
    }
    return out;
  }, [p.showLinks, p.showLabels, terminals]);

  // Vertical runs that horizontal runs hop over where they cross.
  const verticals = useMemo(() => [
    ...p.project.wires.flatMap((w) => segmentsOf(w.points)),
    ...links.flatMap((l) => segmentsOf(l.points)),
    ...(direct?.routes ?? []).flatMap((r) => segmentsOf(r.points)),
  ].filter(([a, b]) => a[0] === b[0] && a[1] !== b[1]), [p.project.wires, links, direct]);

  const pinAt = useCallback((x: number, y: number) => pins.find((q) => q.x === x && q.y === y), [pins]);

  const onWire = useCallback((x: number, y: number) => {
    for (const w of p.project.wires) {
      for (let i = 1; i < w.points.length; i++) {
        const [a, b] = [w.points[i - 1], w.points[i]];
        if (a[0] === b[0] && x === a[0] && y >= Math.min(a[1], b[1]) && y <= Math.max(a[1], b[1])) return w;
        if (a[1] === b[1] && y === a[1] && x >= Math.min(a[0], b[0]) && x <= Math.max(a[0], b[0])) return w;
      }
    }
    return undefined;
  }, [p.project.wires]);

  // Wires reachable from the start points (through shared points, T-junctions and
  // same-named net labels), stopping at component pins.
  const traceFrom = useCallback((start: Pt[]) => {
    const onSeg = (w: Wire, [x, y]: [number, number]) => w.points.some(([px, py], i) => {
      if (px === x && py === y) return true;
      if (i === 0) return false;
      const [ax, ay] = w.points[i - 1];
      return (ax === px && x === ax && y >= Math.min(ay, py) && y <= Math.max(ay, py)) ||
        (ay === py && y === ay && x >= Math.min(ax, px) && x <= Math.max(ax, px));
    });
    // Net labels are layout jumps, not components: hop to every same-named label.
    const labels = terminals.filter((t) => p.project.parts.find((q) => q.ref === t.ref)?.defId === "NETLABEL");
    const jumped = new Set<string>();
    const found = new Set<Wire>();
    const queue: Pt[] = [...start];
    while (queue.length) {
      const pt = queue.pop()!;
      for (const l of labels) {
        if (jumped.has(l.net) || l.at[0] !== pt[0] || l.at[1] !== pt[1]) continue;
        jumped.add(l.net);
        queue.push(...labels.filter((o) => o.net === l.net).map((o) => [o.at[0], o.at[1]] as [number, number]));
      }
      for (const w of p.project.wires) {
        if (found.has(w)) continue;
        if (onSeg(w, pt) || found.size && [w.points[0], w.points[w.points.length - 1]].some((e) => e && [...found].some((f) => onSeg(f, e)))) {
          found.add(w);
          queue.push(...w.points);
        }
      }
    }
    // Routed jumpers between the same-named labels, so the trace reads unbroken.
    const jumps: Pt[][] = [];
    for (const net of jumped) {
      const pts = labels.filter((l) => l.net === net).map((l) => l.at);
      for (const [a, b] of manhattanTree(pts)) jumps.push(lRoute(pts[a], pts[b]));
    }
    return { wires: [...found], jumps, nets: jumped };
  }, [p.project.wires, p.project.parts, terminals]);

  const noTrace = { wires: [] as Wire[], jumps: [] as Pt[][], nets: new Set<string>() };
  // With labels hidden, a trace's label hops are drawn along the direct routes instead.
  const shown = (t: typeof noTrace) => ({
    wires: direct ? t.wires.filter((w) => !direct.hidden.has(w.id)) : t.wires,
    jumps: direct ? direct.routes.filter((r) => t.nets.has(r.net)).map((r) => r.points) : t.jumps,
  });

  const partTrace = useMemo(() => {
    const sel = p.selection;
    if (sel?.kind !== "part") return noTrace;
    return traceFrom(pins.filter((q) => q.ref === sel.ref).map((q) => [q.x, q.y] as Pt));
  }, [p.selection, pins, traceFrom]);
  const { wires: partWires, jumps: partJumps } = shown(partTrace);

  // Hovered wire (id, "d:<i>" for a direct route, "j:<i>" for a selection's label jumper):
  // its whole component-to-component run, drawn bold.
  const [hoverWire, setHoverWire] = useState<string | null>(null);
  const hoverTrace = useMemo(() => {
    if (!hoverWire || drag || drawing) return noTrace;
    const pts = hoverWire.startsWith("d:") ? direct?.routes[Number(hoverWire.slice(2))]?.points
      : hoverWire.startsWith("j:") ? partJumps[Number(hoverWire.slice(2))]
      : p.project.wires.find((q) => q.id === hoverWire)?.points;
    return pts ? traceFrom(pts) : noTrace;
  }, [hoverWire, drag, drawing, p.project.wires, traceFrom, direct, partJumps]);
  const hoverShown = shown(hoverTrace);

  const toWorld = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / view.scale + view.x, (e.clientY - r.top) / view.scale + view.y];
  };

  // Junction dots: points where three or more conductors meet.
  const junctions = useMemo(() => {
    const deg = new Map<string, number>();
    const bump = (x: number, y: number, n = 1) => deg.set(key(x, y), (deg.get(key(x, y)) ?? 0) + n);
    for (const w of p.project.wires) {
      const pts = w.points;
      pts.forEach(([x, y], i) => bump(x, y, i === 0 || i === pts.length - 1 ? 1 : 2));
    }
    for (const q of pins) if (deg.has(key(q.x, q.y))) bump(q.x, q.y);
    // T-junctions onto the middle of a segment.
    for (const w of p.project.wires) {
      for (const end of [w.points[0], w.points[w.points.length - 1]]) {
        if (!end) continue;
        const other = p.project.wires.find((o) => o !== w && o.points.slice(1).some((b, i) => {
          const a = o.points[i];
          const mid = !(a[0] === end[0] && a[1] === end[1]) && !(b[0] === end[0] && b[1] === end[1]);
          return mid && ((a[0] === b[0] && end[0] === a[0] && end[1] > Math.min(a[1], b[1]) && end[1] < Math.max(a[1], b[1])) ||
            (a[1] === b[1] && end[1] === a[1] && end[0] > Math.min(a[0], b[0]) && end[0] < Math.max(a[0], b[0])));
        }));
        if (other) bump(end[0], end[1], 2);
      }
    }
    return [...deg.entries()].filter(([, n]) => n >= 3).map(([k]) => k.split(",").map(Number) as [number, number]);
  }, [p.project.wires, pins]);

  const finishWire = (pts: [number, number][]) => {
    const clean = pts.filter((pt, i) => i === 0 || pt[0] !== pts[i - 1][0] || pt[1] !== pts[i - 1][1]);
    if (clean.length >= 2) {
      const w: Wire = { id: `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, points: clean };
      p.onChange((proj) => ({ ...proj, wires: [...proj.wires, w] }));
    }
    setDrawing(null);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const [wx, wy] = toWorld(e);
    const sx = snap(wx), sy = snap(wy);
    if (e.button === 1 || e.button === 2) {
      if (drawing && e.button === 2) { finishWire(drawing); return; }
      setPan({ sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y });
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    if (p.mode.kind === "place") {
      p.onPlace(p.mode.defId, sx, sy, p.mode.rot);
      if (!e.shiftKey) p.setMode({ kind: "select" });
      return;
    }
    if (simulating) return;
    const hitPin = pinAt(sx, sy);
    if (drawing) {
      const next = [...drawing, ...lPath(drawing[drawing.length - 1], [sx, sy])];
      if (hitPin || (onWire(sx, sy) && drawing.length > 0) || e.detail >= 2) finishWire(next);
      else setDrawing(next);
      return;
    }
    if (p.mode.kind === "wire" || hitPin) {
      setDrawing([[sx, sy]]);
      return;
    }
    p.setSelection(null);
    setPan({ sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const [wx, wy] = toWorld(e);
    setCursor([snap(wx), snap(wy)]);
    if (pan) {
      setView((v) => ({ ...v, x: pan.vx - (e.clientX - pan.sx) / v.scale, y: pan.vy - (e.clientY - pan.sy) / v.scale }));
      return;
    }
    if (drag) {
      const nx = snap(wx - drag.dx), ny = snap(wy - drag.dy);
      const at = p.project.parts.find((q) => q.ref === drag.ref);
      // Only real moves become edits, so a plain click doesn't add an undo step.
      if (at && (at.x !== nx || at.y !== ny)) p.onChange(() => transformPart(drag.base, p.defs, drag.ref, { x: nx, y: ny }), `drag:${drag.id}`);
      if (!drag.moved) setDrag({ ...drag, moved: true });
    }
    if (simulating) {
      const w = onWire(snap(wx), snap(wy));
      setHover(w ? p.wireNets.get(w.id) ?? null : null);
    }
  };

  const onPointerUp = () => {
    setDrag(null);
    setPan(null);
  };

  const onWheel = (e: React.WheelEvent) => {
    const [wx, wy] = toWorld(e);
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setView((v) => {
      const scale = Math.min(6, Math.max(0.25, v.scale * f));
      return { scale, x: wx - (wx - v.x) * (v.scale / scale), y: wy - (wy - v.y) * (v.scale / scale) };
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select, [role=menu], [role=menubar], [role=dialog], [role=listbox], [role=tablist], [role=separator]")) return;
      if (e.key === "Escape") {
        setDrawing(null);
        p.setMode({ kind: "select" });
      }
      if ((e.key === "r" || e.key === "R") && !e.ctrlKey) {
        if (p.mode.kind === "place") {
          const rot = ((p.mode.rot + 90) % 360) as Rotation;
          p.setMode({ ...p.mode, rot });
          announce(`Rotation ${rot} degrees`);
        } else if (p.selection?.kind === "part" && !simulating) {
          const ref = p.selection.ref;
          const at = p.project.parts.find((q) => q.ref === ref);
          if (at) p.onChange((proj) => transformPart(proj, p.defs, ref, { rot: ((at.rot + 90) % 360) as Rotation }));
          if (at) announce(`${ref} rotated to ${(at.rot + 90) % 360} degrees`);
        }
      }
      if ((e.key === "m" || e.key === "M") && p.selection?.kind === "part" && !simulating) {
        const ref = p.selection.ref;
        const at = p.project.parts.find((q) => q.ref === ref);
        if (at) p.onChange((proj) => transformPart(proj, p.defs, ref, { mirror: !at.mirror }));
        announce(`${ref} mirrored`);
      }
      if ((e.key === "Delete" || e.key === "Backspace") && p.selection && !simulating) {
        const s = p.selection;
        p.onChange((proj) => s.kind === "part"
          ? { ...proj, parts: proj.parts.filter((q) => q.ref !== s.ref) }
          : { ...proj, wires: proj.wires.filter((w) => w.id !== s.id) });
        p.setSelection(null);
        announce(s.kind === "part" ? `${s.ref} deleted` : "Wire deleted");
      }
      if (e.key === "w" && !e.ctrlKey && !simulating) p.setMode({ kind: "wire" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p, simulating]);

  // --- keyboard and screen reader ---------------------------------------------------

  /** Parts in reading order (top to bottom, then left to right), for N / Shift+N. */
  const ordered = useMemo(() => [...p.project.parts].sort((a, b) => a.y - b.y || a.x - b.x), [p.project.parts]);

  const describe = useCallback((ref: string, full: boolean): string => {
    const part = p.project.parts.find((q) => q.ref === ref);
    const def = part && p.defs.get(part.defId);
    if (!part || !def) return "";
    const val = valueLabel(part, def);
    const head = `${part.ref}, ${def.name}${val && val !== def.name.split(" ")[0] ? ` ${val}` : ""}`;
    const at = `at ${Math.round(part.x / GRID)}, ${Math.round(part.y / GRID)}${part.rot ? `, rotated ${part.rot} degrees` : ""}${part.mirror ? ", mirrored" : ""}`;
    const nets = def.pins.map((pin) => ({ pin, net: p.pinNets.get(`${part.ref}.${pin.id}`) }));
    const linked = nets.filter((n) => n.net && !/^N\d+$/.test(n.net!) || n.net && [...p.pinNets.values()].filter((v) => v === n.net).length > 1);
    if (!full) {
      const st = (p.frame?.indicate[part.ref] ?? {}) as Record<string, unknown>;
      const live = typeof st.closed === "boolean" ? (st.closed ? ", closed" : ", open")
        : typeof st.on === "boolean" ? (st.on ? ", on" : ", off")
        : typeof st.level === "number" ? `, ${LEVEL[st.level] ?? ""}` : "";
      return `${head}${live}, ${at}. ${linked.length} of ${def.pins.length} pins connected. Press I for details.`;
    }
    const pins = nets.map(({ pin, net }) => {
      const conn = net && linked.some((n) => n.pin === pin) ? `net ${net}` : "not connected";
      const live = net ? netState(p.frame, net) : "";
      return `pin ${pin.number} ${pin.name}: ${conn}${live ? `, ${live}` : ""}`;
    });
    return `${head}, ${at}. ${def.description.replace(/\.?\s*$/, ".")} ${pins.join("; ")}.`;
  }, [p.project.parts, p.defs, p.pinNets, p.frame]);

  // Tell the screen reader whenever the selection changes, however it was made.
  const selKey = p.selection ? `${p.selection.kind}:${p.selection.kind === "part" ? p.selection.ref : p.selection.id}` : "";
  useEffect(() => {
    const sel = p.selection;
    if (!sel) return;
    if (sel.kind === "part") announce(describe(sel.ref, false));
    else {
      const net = p.wireNets.get(sel.id);
      const live = netState(p.frame, net);
      announce(`Wire, net ${net ?? "unknown"}${live ? `, ${live}` : ""}.`);
    }
    // Only on a new selection; describe() changes with every simulation frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey]);

  const centre = (): [number, number] => [snap(view.x + vw / 2), snap(view.y + vh / 2)];
  const inView = ([x, y]: [number, number]) => x >= view.x && x <= view.x + vw && y >= view.y && y <= view.y + vh;
  const zoomBy = (f: number) => setView((v) => {
    const cx = v.x + vw / 2, cy = v.y + vh / 2;
    const scale = Math.min(6, Math.max(0.25, v.scale * f));
    const w = (vw * v.scale) / scale, h = (vh * v.scale) / scale;
    return { scale, x: cx - w / 2, y: cy - h / 2 };
  });
  /** Pans so a point is on screen, if it isn't. */
  const reveal = (x: number, y: number) => {
    if (inView([x, y])) return;
    setView((v) => ({ ...v, x: x - vw / 2, y: y - vh / 2 }));
  };
  const selPart = p.selection?.kind === "part" ? p.project.parts.find((q) => q.ref === (p.selection as { ref: string }).ref) : undefined;
  const pressed = useRef<string | null>(null);
  const kbMove = useRef<{ ref: string; base: Project; out?: Project } | null>(null);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const k = e.key;
    const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[k] as [number, number] | undefined;
    const stepN = e.shiftKey ? 5 : 1;

    if (k === "n" || k === "N") {
      if (!ordered.length) { announce("No parts on the schematic."); return; }
      e.preventDefault();
      const i = selPart ? ordered.indexOf(selPart) : -1;
      const next = ordered[(i + (e.shiftKey ? -1 : 1) + ordered.length) % ordered.length];
      p.setSelection({ kind: "part", ref: next.ref });
      reveal(next.x, next.y);
      return;
    }
    if (k === "i" || k === "I") {
      e.preventDefault();
      if (selPart) announce(describe(selPart.ref, true));
      else if (p.selection?.kind === "wire") {
        const net = p.wireNets.get(p.selection.id);
        announce(`Wire, net ${net}. ${netState(p.frame, net)}`);
      } else {
        announce(`${p.project.name}: ${p.project.parts.length} parts, ${p.project.wires.length} wires. ${simulating ? "Simulating." : ""} ${KEY_HELP}`);
      }
      return;
    }
    if (k === "+" || k === "=") { e.preventDefault(); zoomBy(1.25); return; }
    if (k === "-" || k === "_") { e.preventDefault(); zoomBy(1 / 1.25); return; }

    if (p.mode.kind === "place") {
      if (arrow) {
        e.preventDefault();
        const from = inView(cursor) ? cursor : centre();
        const to: [number, number] = [from[0] + arrow[0] * GRID * stepN, from[1] + arrow[1] * GRID * stepN];
        setCursor(to);
        reveal(to[0], to[1]);
        return;
      }
      if (k === "Enter" || k === " ") {
        e.preventDefault();
        const at = inView(cursor) ? cursor : centre();
        p.onPlace(p.mode.defId, at[0], at[1], p.mode.rot);
        const def = p.defs.get(p.mode.defId);
        announce(`Placed ${def?.name ?? "part"} at ${Math.round(at[0] / GRID)}, ${Math.round(at[1] / GRID)}.${e.shiftKey ? " Placing another." : ""}`);
        if (!e.shiftKey) p.setMode({ kind: "select" });
        return;
      }
      return;
    }

    if (arrow) {
      e.preventDefault();
      if (selPart && !simulating) {
        const ref = selPart.ref;
        const nx = selPart.x + arrow[0] * GRID * stepN, ny = selPart.y + arrow[1] * GRID * stepN;
        // A run of presses is one move from where the run began, like a drag.
        let km = kbMove.current;
        if (!km || km.ref !== ref || km.out !== p.project) km = kbMove.current = { ref, base: p.project };
        const run = km;
        p.onChange(() => (run.out = transformPart(run.base, p.defs, ref, { x: nx, y: ny })), `kbmove:${ref}`);
        reveal(nx, ny);
        announce(`${ref} at ${Math.round(nx / GRID)}, ${Math.round(ny / GRID)}`);
      } else {
        // An eighth of the view per press (Shift: half).
        const f = e.shiftKey ? 0.5 : 0.125;
        setView((v) => ({ ...v, x: v.x + arrow[0] * vw * f, y: v.y + arrow[1] * vh * f }));
      }
      return;
    }

    if ((k === "Enter" || k === " ") && selPart) {
      const def = p.defs.get(selPart.defId);
      if (!def) return;
      e.preventDefault();
      if (e.repeat) return;
      const kind = symbolFor(def).kind;
      if (simulating && kind === "button") {
        pressed.current = selPart.ref;
        p.onActuate(selPart.ref, { pressed: true });
        announce(`${selPart.ref} pressed`);
      } else if (simulating && (kind === "switch" || kind === "logicstate")) {
        p.onActuate(selPart.ref, {});
        announce(`${selPart.ref} toggled`);
      } else if (def.model.kind === "emulator" && p.onEmulator) {
        p.onEmulator(selPart.ref);
      } else {
        announce(simulating ? `${selPart.ref} has no control. Its settings are in the Properties window.` : `${selPart.ref}: edit its properties in the Properties window.`);
      }
    }
  };

  const onKeyUp = (e: React.KeyboardEvent) => {
    if ((e.key === "Enter" || e.key === " ") && pressed.current) {
      p.onActuate(pressed.current, { pressed: false });
      announce(`${pressed.current} released`);
      pressed.current = null;
    }
  };

  // Industrial wire-color convention by net role: +V red, 0 V black, digital yellow, analog blue.
  const netRoles = useMemo(() => {
    const roles = new Map<string, "power" | "ground" | "digital" | "analog">();
    const rank = { analog: 0, digital: 1, ground: 2, power: 3 };
    const bump = (net: string, r: keyof typeof rank) => {
      const cur = roles.get(net);
      if (!cur || rank[r] > rank[cur]) roles.set(net, r);
    };
    for (const part of p.project.parts) {
      const def = p.defs.get(part.defId);
      if (!def) continue;
      for (const pin of def.pins) {
        const net = p.pinNets.get(`${part.ref}.${pin.id}`);
        if (!net) continue;
        if (net === "GND" || pin.type === "ground" || part.defId === "GROUND") bump(net, "ground");
        else if (part.defId === "POWER" || pin.type === "power") bump(net, "power");
        else if (["input", "output", "bidir", "tristate", "opendrain"].includes(pin.type)) bump(net, "digital");
        else bump(net, "analog");
      }
    }
    return roles;
  }, [p.project.parts, p.defs, p.pinNets]);

  const roleColor = (net: string | undefined): string | undefined => {
    const r = net ? netRoles.get(net) : undefined;
    return r && `var(--wire-${r})`;
  };

  const netColor = (net: string | undefined): string | undefined => {
    if (!p.frame || !net) return undefined;
    const s = p.frame.nets[net];
    if (!s) return undefined;
    if (s.level !== undefined) return s.level === 1 ? "var(--high)" : s.level === 0 ? "var(--low)" : s.level === 3 ? "var(--conflict)" : "var(--float)";
    return undefined;
  };

  const r = svgRef.current?.getBoundingClientRect();
  const vw = (r?.width ?? 1200) / view.scale;
  const vh = (r?.height ?? 800) / view.scale;
  const ghostDef = p.mode.kind === "place" ? p.defs.get(p.mode.defId) : undefined;
  const preview = drawing ? [...drawing, ...lPath(drawing[drawing.length - 1], cursor)] : null;
  const hoverState = hover && p.frame?.nets[hover];
  const hoverFrom = hoverTerm ? terminals.find((t) => t.ref === hoverTerm) : undefined;
  const hoverLink = hoverFrom && { from: hoverFrom, others: terminals.filter((t) => t.net === hoverFrom.net && t.ref !== hoverFrom.ref) };

  return (
    <div className="canvas-wrap">
      <svg
        ref={svgRef}
        className={partWires.length || partJumps.length ? "trace-on" : undefined}
        viewBox={`${view.x} ${view.y} ${vw} ${vh}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
        tabIndex={0}
        role="application"
        aria-roledescription="schematic editor"
        aria-label={`Schematic ${p.project.name}, ${p.project.parts.length} parts, ${p.project.wires.length} wires${simulating ? ", simulating" : ""}`}
        aria-describedby="schematic-keys"
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onFocus={() => setKbd(true)}
        onBlur={() => setKbd(false)}
        style={{ cursor: p.mode.kind !== "select" || drawing ? "crosshair" : pan ? "grabbing" : "default" }}
      >
        <defs aria-hidden>
          <pattern id="grid" width={GRID} height={GRID} patternUnits="userSpaceOnUse">
            <circle cx={0} cy={0} r={0.7} fill="var(--sheet-grid)" />
          </pattern>
          <pattern id="grid5" width={GRID * 10} height={GRID * 10} patternUnits="userSpaceOnUse">
            <rect width={GRID * 10} height={GRID * 10} fill="url(#grid)" />
            <circle cx={0} cy={0} r={1.4} fill="var(--sheet-grid)" />
          </pattern>
        </defs>
        <rect x={view.x} y={view.y} width={vw} height={vh} fill="url(#grid5)" />

        {p.project.wires.map((w) => {
          if (direct?.hidden.has(w.id)) return null;
          const net = p.wireNets.get(w.id);
          const color = netColor(net) ?? roleColor(net);
          const sel = p.selection?.kind === "wire" && p.selection.id === w.id;
          const pts = w.points.map((q) => q.join(",")).join(" ");
          return (
            <g key={w.id}>
              <path className={`wire${sel ? " sel" : ""}`} d={hopPath(w.points, verticals)} style={color && !sel ? { stroke: color } : undefined} />
              <polyline className="wire-hit" points={pts}
                onPointerEnter={() => setHoverWire(w.id)}
                onPointerLeave={() => setHoverWire((h) => (h === w.id ? null : h))}
                onPointerDown={(e) => {
                if (simulating || drawing || p.mode.kind !== "select") return;
                const [wx, wy] = toWorld(e);
                if (pinAt(snap(wx), snap(wy))) return;
                e.stopPropagation();
                p.setSelection({ kind: "wire", id: w.id });
              }} />
            </g>
          );
        })}
        {direct?.routes.map((r, i) => (
          <g key={`d${i}`}>
            <path className="wire" d={hopPath(r.points, verticals)} style={{ stroke: netColor(r.net) ?? roleColor(r.net) }} />
            <polyline className="wire-hit" points={r.points.map((q) => q.join(",")).join(" ")}
              onPointerEnter={() => setHoverWire(`d:${i}`)}
              onPointerLeave={() => setHoverWire((h) => (h === `d:${i}` ? null : h))} />
          </g>
        ))}
        {links.map((l, i) => <path key={`l${i}`} className="link" d={hopPath(l.points, verticals)} style={{ stroke: roleColor(l.net) }} />)}
        {/* Under the parts so label jumpers don't strike through label text. */}
        {partJumps.map((pts, i) => (
          <g key={`pj${i}`}>
            <path className="wire part-wire part-jump" d={hopPath(pts, verticals)} />
            <polyline className="wire-hit" points={pts.map((q) => q.join(",")).join(" ")}
              onPointerEnter={() => setHoverWire(`j:${i}`)}
              onPointerLeave={() => setHoverWire((h) => (h === `j:${i}` ? null : h))} />
          </g>
        ))}
        {hoverShown.jumps.map((pts, i) => <path key={`hj${i}`} className="wire hover-trace" d={hopPath(pts, verticals)}
          style={{ stroke: hoverTrace.wires.length && hoverTrace.wires.every((w) => partTrace.wires.includes(w)) ? "#8a3ffc" : roleColor(hoverTrace.wires[0] ? p.wireNets.get(hoverTrace.wires[0].id) : [...hoverTrace.nets][0]) }} />)}
        {junctions.map(([x, y]) => <circle key={`j${x},${y}`} className="junction" cx={x} cy={y} r={3} />)}

        {p.project.parts.map((part) => {
          const def = p.defs.get(part.defId);
          if (!p.showLabels && part.defId === "NETLABEL") return null;
          if (!def) {
            return <text key={part.ref} x={part.x} y={part.y} fill="var(--err)">{part.ref}: missing part {part.defId}</text>;
          }
          return (
            <PartView
              key={part.ref}
              part={part}
              def={def}
              geom={symbolFor(def)}
              selected={p.selection?.kind === "part" && p.selection.ref === part.ref}
              indicate={p.frame?.indicate[part.ref]}
              simulating={simulating}
              onActuate={(a) => p.onActuate(part.ref, a)}
              onEmulator={p.onEmulator && (() => p.onEmulator!(part.ref))}
              onPointerEnter={isTerminal(part.defId) ? () => setHoverTerm(part.ref) : undefined}
              onPointerLeave={isTerminal(part.defId) ? () => setHoverTerm((h) => (h === part.ref ? null : h)) : undefined}
              onPointerDown={(e) => {
                if (e.button !== 0 || p.mode.kind === "place") return;
                const [wx, wy] = toWorld(e);
                if (pinAt(snap(wx), snap(wy)) && !simulating) return; // start a wire instead
                if (drawing) return;
                e.stopPropagation();
                p.setSelection({ kind: "part", ref: part.ref });
                if (!simulating) {
                  setDrag({ id: Date.now(), ref: part.ref, dx: wx - part.x, dy: wy - part.y, moved: false, base: p.project });
                  (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
                }
              }}
            />
          );
        })}

        {partWires.map((w) => <path key={`pw${w.id}`} className="wire part-wire" d={hopPath(w.points, verticals)} />)}
        {hoverShown.wires.map((w) => {
          const net = p.wireNets.get(w.id);
          const inPart = partWires.includes(w);
          return <path key={`hw${w.id}`} className={`wire hover-trace${inPart ? " part-wire" : ""}`} d={hopPath(w.points, verticals)}
            style={inPart ? undefined : { stroke: netColor(net) ?? roleColor(net) }} />;
        })}

        {p.frame && pins.map((q) => {
          const net = p.pinNets.get(`${q.ref}.${q.id}`);
          const c = netColor(net);
          const lvl = net ? p.frame?.nets[net]?.level : undefined;
          return c ? <rect key={`s${q.ref}.${q.id}`} className={`state-sq lvl-${lvl ?? "x"}`} x={q.x - 2.5} y={q.y - 2.5} width={5} height={5} fill={c} stroke={c} /> : null;
        })}

        {hoverLink && !drag && !drawing && <g className="link-hover" pointerEvents="none">
          {hoverLink.others.map((t) => <g key={t.ref}>
            <line x1={hoverLink.from.at[0]} y1={hoverLink.from.at[1]} x2={t.at[0]} y2={t.at[1]} />
            <circle cx={t.at[0]} cy={t.at[1]} r={5} />
          </g>)}
          <circle cx={hoverLink.from.at[0]} cy={hoverLink.from.at[1]} r={5} />
        </g>}

        {!simulating && (() => {
          const hp = pinAt(cursor[0], cursor[1]);
          return hp ? <circle className="pin-hot" cx={hp.x} cy={hp.y} r={5} /> : null;
        })()}
        {preview && <polyline className="wire" points={preview.map((q) => q.join(",")).join(" ")} strokeDasharray="4 3" />}
        {ghostDef && p.mode.kind === "place" && (
          <g opacity={0.55} pointerEvents="none">
            <PartView part={{ ref: "?", defId: ghostDef.id, x: cursor[0], y: cursor[1], rot: p.mode.rot, props: {} }}
              def={ghostDef} geom={symbolFor(ghostDef)} selected={false} simulating={false} />
          </g>
        )}
      </svg>
      <p id="schematic-keys" className="sr-only">{KEY_HELP}</p>
      <div className="canvas-hint" aria-hidden>
        {hoverLink && !drag && !drawing
          ? `${hoverLink.from.net}: joined by name to ${hoverLink.others.length ? hoverLink.others.map((t) => t.ref).join(", ") : "nothing else"}`
          : hoverState
          ? `${hover}: ${hoverState.v !== undefined ? formatValue(hoverState.v, "V") : ["LOW", "HIGH", "FLOAT", "CONFLICT"][hoverState.level ?? 2]}`
          : p.mode.kind === "place" ? (kbd ? "Arrows move · Enter place · Shift+Enter place several · R rotate · Esc cancel" : "Click to place · R rotate · Shift-click to place several · Esc cancel")
          : kbd && !drawing ? (simulating ? "N next part · Enter/Space operate button or switch · I describe · +/- zoom" : "N next part · arrows move (Shift: ×5) · R rotate · M mirror · Del delete · I describe · +/- zoom")
          : drawing ? "Click to add a corner · click a pin or wire to finish · double-click / right-click ends · Esc cancels"
          : simulating ? "Simulating: click buttons, switches and logic states · hover a wire for its voltage"
          : "Drag parts · click a pin to start a wire (W: wire mode) · R rotate · M mirror · Del delete · wheel zoom · right-drag pan"}
      </div>
    </div>
  );
}

export function partAt(project: Project, ref: string): PartInstance | undefined {
  return project.parts.find((q) => q.ref === ref);
}
