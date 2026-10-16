import { Fragment, ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  DropTarget, Float, Group, Layout, NEW_PANE, Node, PANEL_TITLES, PanelId, SIDES, Side, Split,
  dock, edgeOf, findGroup, groups, hasDoc, locate, mapGroups, pixelSize, setHidden, setSizes, shownActive, visiblePanels,
} from "./layout";

interface Props {
  layout: Layout;
  onLayout: (l: Layout) => void;
  render: (id: PanelId) => ReactNode;
  /** Extra content after a tab's title, e.g. a warning count. */
  badge?: (id: PanelId) => ReactNode;
  /** The document well (schematic). */
  children: ReactNode;
  /** Bump to bring a panel into view, sliding out its auto-hide group if needed. */
  reveal?: { id: PanelId; n: number };
}

interface Drag {
  ids: PanelId[];
  active: PanelId;
  /** Set when a floating window is being moved by its title bar. */
  floatId?: string;
  /** Pointer position relative to the dock root. */
  x: number;
  y: number;
  target: DropTarget | null;
  /** Group id, or "doc", under the pointer. */
  hover: string | null;
  /** Over the whole group being dragged: no guides there, and dropping does nothing. */
  self: boolean;
}

interface Rect { x: number; y: number; w: number; h: number }

const vertical = (s: Side) => s === "left" || s === "right";
const FLOAT_W = 340, FLOAT_H = 300;
const FLYOUT = { row: 300, col: 240 };

export function DockHost({ layout, onLayout, render, badge, children, reveal }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [flyout, setFlyout] = useState<{ side: Side; groupId: string } | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useEffect(() => {
    if (!reveal) return;
    const at = locate(layoutRef.current, reveal.id);
    if (at && "group" in at && at.group.autoHide) setFlyout({ side: edgeOf(layoutRef.current, at.group.id), groupId: at.group.id });
  }, [reveal]);

  // Close the auto-hide flyout when clicking anywhere outside it or its tab strip, or on Escape.
  useEffect(() => {
    if (!flyout) return;
    const onDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest?.(".dock-flyout, .dock-strip")) setFlyout(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !(e.target as HTMLElement)?.closest?.(".dock-flyout")) return;
      const tab = root.current?.querySelector<HTMLElement>(`.dock-strip-tab[aria-controls="${flyoutId}"]`);
      setFlyout(null);
      tab?.focus();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [flyout]);

  // F6 / Shift+F6 cycle keyboard focus between the document and the open tool windows.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F6" || e.ctrlKey || e.altKey) return;
      const panes = [...(root.current?.querySelectorAll<HTMLElement>("[data-pane]") ?? [])];
      if (!panes.length) return;
      e.preventDefault();
      const at = panes.findIndex((x) => x.contains(document.activeElement));
      const next = panes[(at + (e.shiftKey ? -1 : 1) + panes.length) % panes.length];
      const target = next.querySelector<HTMLElement>("[data-pane-focus]") ?? next.querySelector<HTMLElement>(
        '.tw-body button, .tw-body input, .tw-body select, .tw-body textarea, .tw-body [tabindex="0"], svg[tabindex="0"]',
      ) ?? next;
      target.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const rel = (e: { clientX: number; clientY: number }) => {
    const r = root.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** Pointer-down on a title bar or tab: becomes a drag once the pointer moves a few px. */
  const beginDrag = (e: React.PointerEvent, ids: PanelId[], active: PanelId, floatId?: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button.dock-btn")) return;
    const start = { x: e.clientX, y: e.clientY };
    const float = floatId ? layoutRef.current.floats.find((f) => f.id === floatId) : undefined;
    const grab = float ? { dx: rel(e).x - float.x, dy: rel(e).y - float.y } : null;
    let live: Drag | null = null;
    const move = (ev: PointerEvent) => {
      if (!live && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
      const p = rel(ev);
      const hits = document.elementsFromPoint(ev.clientX, ev.clientY) as HTMLElement[];
      const dropEl = hits.find((h) => h.dataset?.drop);
      const hoverEl = hits.find((h) => (h.dataset?.groupId && h.dataset.groupId !== floatId) || h.dataset?.doc);
      const hover = hoverEl ? hoverEl.dataset.groupId ?? "doc" : null;
      const self = !!hover && !!findGroup(layoutRef.current, hover)?.panels.every((q) => ids.includes(q));
      // Off the guides, anywhere over another tool window tabs into it.
      const target = dropEl ? parseDrop(dropEl.dataset.drop!)
        : hover && hover !== "doc" && !self ? { kind: "tab" as const, groupId: hover } : null;
      live = { ids, active, floatId, x: p.x, y: p.y, target, hover, self };
      setDrag(live);
      setFlyout(null);
      if (grab && floatId) {
        onLayout(mapGroups(layoutRef.current, floatId, (f) => ({ ...f, x: p.x - grab.dx, y: Math.max(0, p.y - grab.dy) })));
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const d = live;
      setDrag(null);
      if (!d) return;
      if (d.target) onLayout(dock(layoutRef.current, ids, active, d.target));
      else if (!floatId && !d.self) {
        onLayout(dock(layoutRef.current, ids, active, { kind: "float", x: Math.max(0, d.x - 40), y: Math.max(0, d.y - 12), w: FLOAT_W, h: FLOAT_H }));
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const setActive = (gid: string, id: PanelId) => onLayout(mapGroups(layout, gid, (g) => ({ ...g, active: id })));
  const close = (id: PanelId) => onLayout(setHidden(layout, id, true));
  const setAutoHide = (gid: string, on: boolean) => {
    onLayout(mapGroups(layout, gid, (g) => ({ ...g, autoHide: on || undefined })));
    setFlyout(null);
  };

  const pane = (g: Group | Float, opts: { docked?: boolean; floating?: boolean; flyout?: boolean }) => {
    const shown = visiblePanels(layout, g.panels);
    const active = shownActive(layout, g);
    if (!active) return null;
    const isFocused = focused === g.id;
    const title = PANEL_TITLES[active];
    const tabbed = shown.length > 1;
    const uid = `tw-${opts.flyout ? "fly-" : ""}${g.id}`;
    return (
      <div
        className={`tw${isFocused ? " focused" : ""}`}
        data-group-id={g.id}
        data-pane="1"
        tabIndex={-1}
        role="region"
        aria-labelledby={`${uid}-name`}
        onPointerDownCapture={() => setFocused(g.id)}
      >
        <div className="tw-title" onPointerDown={(e) => beginDrag(e, g.panels, active, opts.floating ? g.id : undefined)}>
          <span className="tw-name" id={`${uid}-name`}>{title}</span>
          <span className="tw-grip" aria-hidden />
          {opts.docked && (
            <button className="dock-btn" title={opts.flyout ? "Dock" : "Auto Hide"}
              aria-label={opts.flyout ? `Dock ${title}` : `Auto hide ${title}`} onClick={() => setAutoHide(g.id, !opts.flyout)}>
              <PinIcon pinned={!opts.flyout} />
            </button>
          )}
          <button className="dock-btn" title="Close" aria-label={`Close ${title}`} onClick={() => close(active)}><CloseIcon /></button>
        </div>
        <div className="tw-body" id={`${uid}-body`} role={tabbed ? "tabpanel" : undefined}
          aria-labelledby={tabbed ? `${uid}-tab-${active}` : undefined}>
          {render(active)}
        </div>
        {tabbed && (
          <div className="tw-tabs" role="tablist" aria-label={`${title} group`}
            onKeyDown={(e) => {
              const i = shown.indexOf(active);
              const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
              const to = e.key === "Home" ? shown[0] : e.key === "End" ? shown[shown.length - 1] : d ? shown[(i + d + shown.length) % shown.length] : null;
              if (!to) return;
              e.preventDefault();
              setActive(g.id, to);
              requestAnimationFrame(() => document.getElementById(`${uid}-tab-${to}`)?.focus());
            }}>
            {shown.map((id) => (
              <button
                key={id}
                id={`${uid}-tab-${id}`}
                role="tab"
                aria-selected={id === active}
                aria-controls={`${uid}-body`}
                tabIndex={id === active ? 0 : -1}
                className={`tw-tab${id === active ? " active" : ""}`}
                onPointerDown={(e) => beginDrag(e, [id], id)}
                onClick={() => setActive(g.id, id)}
              >
                {PANEL_TITLES[id]}{badge?.(id)}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  const shows = (n: Node): boolean =>
    n.kind === "doc" || (n.kind === "group" ? !n.autoHide && visiblePanels(layout, n.panels).length > 0 : n.children.some(shows));

  const renderNode = (n: Node): ReactNode => {
    if (n.kind === "doc") {
      return (
        <div className={`dock-doc${focused === "doc" ? " focused" : ""}`} data-doc="1" data-pane="1" tabIndex={-1} role="region" aria-label="Schematic document"
          onPointerDownCapture={() => setFocused("doc")}>
          {children}
        </div>
      );
    }
    if (n.kind === "group") return pane(n, { docked: true });
    const kids = n.children.map((c, i) => ({ c, i })).filter(({ c }) => shows(c));
    if (kids.length === 1) return renderNode(kids[0].c);
    const px = hasDoc(n);
    return (
      <div className={`dock-split ${n.dir}`}>
        {kids.map(({ c, i }, k) => (
          <Fragment key={c.id}>
            {k > 0 && <Splitter axis={n.dir === "row" ? "x" : "y"} onDrag={(d, el) => resize(n, kids[k - 1].i, i, d, el)}
              label={`Resize ${paneName(kids[k - 1].c)} and ${paneName(c)}`} />}
            <div className="dock-slot" style={{ flex: px ? (hasDoc(c) ? "1 1 0" : `0 0 ${n.sizes[i]}px`) : `${n.sizes[i]} 1 0` }}>
              {renderNode(c)}
            </div>
          </Fragment>
        ))}
      </div>
    );
  };

  /** Moves the splitter between children a and b of a split by d px from where the drag started. */
  const resize = (n: Split, a: number, b: number, d: number, el: HTMLElement) => {
    const sizes = [...n.sizes];
    const len = n.dir === "row" ? el.parentElement!.clientWidth : el.parentElement!.clientHeight;
    const min = 60, max = len - 120;
    if (hasDoc(n)) {
      // Pixel sizes; the document's branch takes whatever is left.
      if (hasDoc(n.children[a])) sizes[b] = Math.min(max, Math.max(min, n.sizes[b] - d));
      else if (hasDoc(n.children[b])) sizes[a] = Math.min(max, Math.max(min, n.sizes[a] + d));
      else {
        const dd = Math.min(n.sizes[b] - min, Math.max(min - n.sizes[a], d));
        sizes[a] = n.sizes[a] + dd;
        sizes[b] = n.sizes[b] - dd;
      }
    } else {
      // Weights: convert the pixel travel using the share of the visible children.
      const total = n.children.reduce((s, c, i) => s + (shows(c) ? n.sizes[i] : 0), 0);
      const dw = (d / len) * total, mw = total * 0.08;
      const dd = Math.min(n.sizes[b] - mw, Math.max(mw - n.sizes[a], dw));
      sizes[a] = n.sizes[a] + dd;
      sizes[b] = n.sizes[b] - dd;
    }
    onLayout(setSizes(layoutRef.current, n.id, sizes));
  };

  /** A readable name for a dock node, for splitter labels: its visible windows, e.g. "Schematic, Output". */
  const paneName = (n: Node): string => {
    if (n.kind === "doc") return "Schematic";
    if (n.kind === "group") { const a = shownActive(layout, n); return a ? PANEL_TITLES[a] : "pane"; }
    return n.children.filter(shows).map(paneName).join(", ");
  };

  const flyoutId = "dock-flyout";
  const autoHidden = [...groups(layout.root)].filter((g) => g.autoHide && visiblePanels(layout, g.panels).length);
  const strip = (side: Side) => {
    const gs = autoHidden.filter((g) => edgeOf(layout, g.id) === side);
    if (!gs.length) return null;
    return (
      <div className={`dock-strip ${side}`} role="toolbar" aria-label={`Auto-hidden tool windows, ${side}`}
        aria-orientation={vertical(side) ? "vertical" : "horizontal"}>
        {gs.map((g) => (
          <div key={g.id} className="dock-strip-group">
            {visiblePanels(layout, g.panels).map((id) => (
              <button
                key={id}
                className={`dock-strip-tab${flyout?.groupId === g.id && shownActive(layout, g) === id ? " active" : ""}`}
                aria-expanded={flyout?.groupId === g.id && shownActive(layout, g) === id}
                aria-controls={flyoutId}
                onClick={() => {
                  setActive(g.id, id);
                  setFlyout(flyout?.groupId === g.id && g.active === id ? null : { side, groupId: g.id });
                }}
              >
                {PANEL_TITLES[id]}
              </button>
            ))}
          </div>
        ))}
      </div>
    );
  };

  const fly = flyout ? findGroup(layout, flyout.groupId) : undefined;
  const flyEl = flyout && fly && "kind" in fly && fly.autoHide && (() => {
    const size = pixelSize(layout, fly.id) ?? FLYOUT[vertical(flyout.side) ? "row" : "col"];
    return (
      <div className={`dock-flyout ${flyout.side}`} id={flyoutId} style={vertical(flyout.side) ? { width: size } : { height: size }}>
        {pane(fly, { docked: true, flyout: true })}
      </div>
    );
  })();

  return (
    <div className={`dock-root${drag ? " dragging" : ""}`} ref={root} role="main" aria-label="Workspace">
      {strip("top")}
      <div className="dock-middle">
        {strip("left")}
        <div className="dock-tree">{renderNode(layout.root)}</div>
        {strip("right")}
      </div>
      {strip("bottom")}
      {flyEl}
      {layout.floats.map((f, i) => (
        <FloatWindow
          key={f.id}
          f={f}
          z={i}
          onRaise={() => i < layout.floats.length - 1 && onLayout({ ...layout, floats: [...layout.floats.filter((x) => x !== f), f] })}
          onResize={(w, h) => onLayout(mapGroups(layoutRef.current, f.id, (x) => ({ ...x, w, h })))}
        >
          {pane(f, { floating: true })}
        </FloatWindow>
      ))}
      {drag && <div aria-hidden><Guides drag={drag} root={root.current} /></div>}
    </div>
  );
}

/** onDrag receives the total pointer travel since the drag started. Arrow keys move it 10 px (Shift: 50). */
function Splitter({ axis, onDrag, label }: { axis: "x" | "y"; onDrag: (delta: number, el: HTMLElement) => void; label: string }) {
  // Position for assistive tech: the share of the split taken by the pane before the splitter.
  const ref = useRef<HTMLDivElement>(null);
  const [pct, setPct] = useState(50);
  useLayoutEffect(() => {
    const el = ref.current, prev = el?.previousElementSibling as HTMLElement | null, parent = el?.parentElement;
    if (!prev || !parent) return;
    const len = axis === "x" ? parent.clientWidth : parent.clientHeight;
    const v = len ? Math.round(((axis === "x" ? prev.offsetWidth : prev.offsetHeight) / len) * 100) : 50;
    if (v !== pct) setPct(v);
  });
  return (
    <div
      ref={ref}
      className={`dock-splitter ${axis}`}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${pct}%`}
      tabIndex={0}
      onKeyDown={(e) => {
        const back = axis === "x" ? "ArrowLeft" : "ArrowUp", fwd = axis === "x" ? "ArrowRight" : "ArrowDown";
        if (e.key !== back && e.key !== fwd) return;
        e.preventDefault();
        const step = e.shiftKey ? 50 : 10;
        onDrag(e.key === fwd ? step : -step, e.currentTarget);
      }}
      onPointerDown={(e) => {
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const start = axis === "x" ? e.clientX : e.clientY;
        const move = (ev: PointerEvent) => onDrag((axis === "x" ? ev.clientX : ev.clientY) - start, el);
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
      }}
    />
  );
}

function FloatWindow({ f, z, onRaise, onResize, children }: {
  f: Float; z: number; onRaise: () => void; onResize: (w: number, h: number) => void; children: ReactNode;
}) {
  return (
    <div className="dock-float" style={{ left: f.x, top: f.y, width: f.w, height: f.h, zIndex: 20 + z }} onPointerDown={onRaise}>
      {children}
      <div
        className="dock-float-grip"
        aria-hidden
        onPointerDown={(e) => {
          e.stopPropagation();
          const el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          const sx = e.clientX, sy = e.clientY, w0 = f.w, h0 = f.h;
          const move = (ev: PointerEvent) => onResize(Math.max(180, w0 + ev.clientX - sx), Math.max(120, h0 + ev.clientY - sy));
          const up = () => {
            el.removeEventListener("pointermove", move);
            el.removeEventListener("pointerup", up);
          };
          el.addEventListener("pointermove", move);
          el.addEventListener("pointerup", up);
        }}
      />
    </div>
  );
}

function parseDrop(s: string): DropTarget | null {
  const [kind, a, b] = s.split(":");
  if (kind === "edge") return { kind: "edge", side: a as Side };
  if (kind === "beside") return { kind: "beside", nodeId: a, side: b as Side };
  if (kind === "tab") return { kind: "tab", groupId: a };
  return null;
}

/**
 * VS-style docking guides: four outer guides at the window edges, and a
 * compass over the window under the pointer. Its arrows split that window, the
 * centre tabs into it. The document has arrows only; a floating window has the
 * centre only.
 */
function Guides({ drag, root }: { drag: Drag; root: HTMLDivElement | null }) {
  const [rootRect, setRootRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => setRootRect(root?.getBoundingClientRect() ?? null), [root]);
  if (!rootRect) return null;
  const W = rootRect.width, H = rootRect.height;

  let hoverRect: Rect | null = null;
  let floating = false;
  if (drag.hover && !drag.self) {
    const el = root!.querySelector<HTMLElement>(drag.hover === "doc" ? "[data-doc]" : `[data-group-id="${drag.hover}"]`);
    if (el) {
      const r = el.getBoundingClientRect();
      hoverRect = { x: r.left - rootRect.left, y: r.top - rootRect.top, w: r.width, h: r.height };
      floating = !!el.closest(".dock-float");
    }
  }

  const across = (s: Side) => (vertical(s) ? "row" : "col");
  const t = drag.target;
  let preview: Rect | null = null;
  if (t?.kind === "edge") {
    const size = Math.min(NEW_PANE[across(t.side)], (vertical(t.side) ? W : H) / 3);
    preview = t.side === "left" ? { x: 0, y: 0, w: size, h: H } : t.side === "right" ? { x: W - size, y: 0, w: size, h: H }
      : t.side === "top" ? { x: 0, y: 0, w: W, h: size } : { x: 0, y: H - size, w: W, h: size };
  } else if (t?.kind === "beside" && hoverRect) {
    const r = hoverRect;
    const len = vertical(t.side) ? r.w : r.h;
    // Beside the document a pane gets its default size; a tool window is split in half.
    const size = t.nodeId === "doc" ? Math.min(NEW_PANE[across(t.side)], len / 2) : len / 2;
    preview = t.side === "left" ? { ...r, w: size } : t.side === "right" ? { ...r, x: r.x + r.w - size, w: size }
      : t.side === "top" ? { ...r, h: size } : { ...r, y: r.y + r.h - size, h: size };
  } else if (t?.kind === "tab" && hoverRect) {
    preview = hoverRect;
  } else if (!t && !drag.floatId && !drag.self) {
    preview = { x: drag.x - 40, y: drag.y - 12, w: FLOAT_W, h: FLOAT_H };
  }

  const edge = (side: Side, x: number, y: number) => (
    <div key={side} className="guide edge" data-drop={`edge:${side}`} style={{ left: x - 17, top: y - 17 }}>
      <GuideIcon dir={side} />
    </div>
  );
  const h = drag.hover;

  return (
    <div className="dock-guides">
      {preview && <div className="dock-preview" style={{ left: preview.x, top: preview.y, width: preview.w, height: preview.h }} />}
      {edge("left", 24, H / 2)}
      {edge("right", W - 24, H / 2)}
      {edge("top", W / 2, 24)}
      {edge("bottom", W / 2, H - 24)}
      {hoverRect && h && (
        <div className="compass" style={{ left: hoverRect.x + hoverRect.w / 2 - 54, top: hoverRect.y + hoverRect.h / 2 - 54 }}>
          {!floating && SIDES.map((sd) => (
            <div key={sd} className={`guide c-${sd}`} data-drop={`beside:${h}:${sd}`}><GuideIcon dir={sd} /></div>
          ))}
          {h !== "doc" && <div className="guide c-center" data-drop={`tab:${h}`}><GuideIcon dir="center" /></div>}
        </div>
      )}
    </div>
  );
}

function GuideIcon({ dir }: { dir: Side | "center" }) {
  // A window outline with the docked part filled, like the VS guide glyphs.
  const fill = dir === "left" ? { x: 5, y: 7, w: 8, h: 18 } : dir === "right" ? { x: 19, y: 7, w: 8, h: 18 }
    : dir === "top" ? { x: 5, y: 7, w: 22, h: 7 } : dir === "bottom" ? { x: 5, y: 18, w: 22, h: 7 } : { x: 5, y: 7, w: 22, h: 18 };
  return (
    <svg viewBox="0 0 32 32" width={28} height={28}>
      <rect x={4.5} y={4.5} width={23} height={22} className="g-frame" />
      <rect x={4.5} y={4.5} width={23} height={3} className="g-bar" />
      <rect {...{ x: fill.x, y: fill.y + 1, width: fill.w, height: fill.h - 1 }} className="g-fill" />
    </svg>
  );
}

function PinIcon({ pinned }: { pinned: boolean }) {
  return pinned ? (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden><path d="M5 2h6v1H10v5l2 2v1H8.5v4h-1v-4H4v-1l2-2V3H5z" fill="currentColor" /></svg>
  ) : (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden><path d="M14 5v6h-1V10H8l-2 2H5V8.5H1v-1h4V4h1l2 2h5V5z" fill="currentColor" /></svg>
  );
}

function CloseIcon() {
  return <svg viewBox="0 0 16 16" width={10} height={10} aria-hidden><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth={1.6} /></svg>;
}
