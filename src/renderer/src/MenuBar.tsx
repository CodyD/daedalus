import { ReactNode, useEffect, useRef, useState } from "react";

export type MenuItem =
  | { sep: true }
  | { label: string; shortcut?: string; onClick?: () => void; disabled?: boolean; checked?: boolean; title?: string; submenu?: MenuItem[] };

export interface Menu {
  label: string;
  items: MenuItem[];
  /** Called as the menu opens, e.g. to load the recent-files list. */
  onOpen?: () => void;
}

type Entry = "first" | "last" | null;

/**
 * Visual Studio style menu bar: click to open, then hover to move between menus.
 * Keyboard follows the WAI-ARIA menubar pattern: Alt or F10 moves focus to it,
 * Alt+letter opens a menu, arrows move, Enter/Space activate, Escape backs out.
 */
export function MenuBar({ menus, children }: { menus: Menu[]; children?: ReactNode }) {
  const [open, setOpen] = useState<number | null>(null);
  const [entry, setEntry] = useState<Entry>(null);
  const [current, setCurrent] = useState(0);
  const bar = useRef<HTMLDivElement>(null);
  /** Where focus was before the menu bar took it; it goes back there afterwards. */
  const back = useRef<HTMLElement | null>(null);
  const tops = () => [...(bar.current?.querySelectorAll<HTMLElement>("[role=menubar] > .menu-anchor > .menubar-item") ?? [])];

  const show = (i: number, e: Entry = null) => {
    if (open !== i) menus[i].onOpen?.();
    setOpen(i);
    setCurrent(i);
    setEntry(e);
  };
  const leave = () => {
    setOpen(null);
    const to = back.current;
    back.current = null;
    if (to && document.contains(to)) to.focus();
    else (document.activeElement as HTMLElement | null)?.blur?.();
  };
  const focusTop = (i: number) => {
    setCurrent(i);
    tops()[i]?.focus();
  };
  const move = (i: number, d: number) => (i + d + menus.length) % menus.length;

  useEffect(() => {
    // Alt alone (released without another key) or F10 focuses the menu bar; Alt+letter opens that menu.
    let altAlone = false;
    const down = (e: KeyboardEvent) => {
      if (e.key === "Alt") { altAlone = true; return; }
      altAlone = false;
      if (e.key === "F10" && !e.shiftKey && !e.ctrlKey) {
        e.preventDefault();
        focusTop(open ?? 0);
        return;
      }
      if (e.altKey && !e.ctrlKey && e.key.length === 1) {
        const i = menus.findIndex((m) => m.label[0].toLowerCase() === e.key.toLowerCase());
        if (i >= 0) {
          e.preventDefault();
          if (!bar.current?.contains(document.activeElement)) back.current = document.activeElement as HTMLElement;
          show(i, "first");
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Alt" && altAlone) {
        altAlone = false;
        e.preventDefault();
        if (bar.current?.contains(document.activeElement)) leave();
        else focusTop(0);
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  });

  const onTopKey = (e: React.KeyboardEvent, i: number) => {
    switch (e.key) {
      case "ArrowRight": case "ArrowLeft": {
        e.preventDefault();
        const j = move(i, e.key === "ArrowRight" ? 1 : -1);
        if (open !== null) show(j, "first");
        focusTop(j);
        break;
      }
      case "ArrowDown": case "Enter": case " ":
        e.preventDefault();
        show(i, "first");
        break;
      case "ArrowUp":
        e.preventDefault();
        show(i, "last");
        break;
      case "Home": e.preventDefault(); focusTop(0); break;
      case "End": e.preventDefault(); focusTop(menus.length - 1); break;
      case "Escape":
        e.preventDefault();
        if (open !== null) setOpen(null);
        else leave();
        break;
    }
  };

  return (
    <div
      className="menubar"
      ref={bar}
      onFocus={(e) => {
        if (!back.current && !bar.current?.contains(e.relatedTarget as Node)) back.current = e.relatedTarget as HTMLElement | null;
      }}
      onBlur={(e) => {
        if (e.relatedTarget && !bar.current?.contains(e.relatedTarget as Node)) { back.current = null; setOpen(null); }
      }}
    >
      {open !== null && <div className="menu-backdrop" onPointerDown={() => setOpen(null)} />}
      <div role="menubar" aria-label="Main menu" style={{ display: "contents" }}>
        {menus.map((m, i) => (
          <div key={m.label} className="menu-anchor">
            <button
              id={`menubar-${i}`}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open === i}
              aria-keyshortcuts={`Alt+${m.label[0]}`}
              tabIndex={i === current ? 0 : -1}
              className={`menubar-item${open === i ? " open" : ""}`}
              onClick={() => (open === i ? setOpen(null) : show(i))}
              onPointerEnter={() => open !== null && open !== i && show(i)}
              onKeyDown={(e) => onTopKey(e, i)}
            >
              <span className="access-key">{m.label[0]}</span>{m.label.slice(1)}
            </button>
            {open === i && (
              <MenuList
                items={m.items}
                labelledBy={`menubar-${i}`}
                entry={entry}
                close={leave}
                closeSelf={() => { setOpen(null); focusTop(i); }}
                onSide={(d) => { const j = move(i, d); show(j, "first"); setCurrent(j); }}
              />
            )}
          </div>
        ))}
      </div>
      {children}
    </div>
  );
}

function MenuList({ items, labelledBy, entry, close, closeSelf, onSide, sub }: {
  items: MenuItem[];
  labelledBy: string;
  entry: Entry;
  /** Close the whole menu tree (after an item runs). */
  close: () => void;
  /** Close just this list and give focus back to whatever opened it. */
  closeSelf: () => void;
  /** Left/Right on a top-level list: move to the neighbouring menu. */
  onSide?: (dir: -1 | 1) => void;
  sub?: boolean;
}) {
  const [hot, setHot] = useState<number | null>(null);
  const [subEntry, setSubEntry] = useState<Entry>(null);
  const list = useRef<HTMLDivElement>(null);
  const rows = () => [...(list.current?.querySelectorAll<HTMLElement>(":scope > .menu-anchor > .menu-row") ?? [])];

  useEffect(() => {
    const r = rows();
    if (entry === "first") r[0]?.focus();
    else if (entry === "last") r[r.length - 1]?.focus();
    else list.current?.focus();
  }, [entry]);

  const onKey = (e: React.KeyboardEvent) => {
    const r = rows();
    const i = r.indexOf(document.activeElement as HTMLElement);
    if (i < 0 && e.target !== list.current) return; // a key inside an open submenu
    const it = items.filter((x) => !("sep" in x))[i] as Exclude<MenuItem, { sep: true }> | undefined;
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); r[(i + 1) % r.length]?.focus(); break;
      case "ArrowUp": e.preventDefault(); r[(i - 1 + r.length) % r.length]?.focus(); break;
      case "Home": e.preventDefault(); r[0]?.focus(); break;
      case "End": e.preventDefault(); r[r.length - 1]?.focus(); break;
      case "ArrowRight":
        e.preventDefault();
        if (it?.submenu && !it.disabled) { setHot(items.indexOf(it)); setSubEntry("first"); }
        else onSide?.(1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (sub) closeSelf();
        else onSide?.(-1);
        break;
      case "Escape": e.preventDefault(); e.stopPropagation(); closeSelf(); break;
      case "Tab": e.preventDefault(); close(); break;
      default:
        // Type-ahead: jump to the next item starting with that letter.
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
          const labels = items.filter((x) => !("sep" in x)).map((x) => (x as { label: string }).label.toLowerCase());
          for (let k = 1; k <= labels.length; k++) {
            const j = (i + k) % labels.length;
            if (labels[j].startsWith(e.key.toLowerCase())) { r[j]?.focus(); break; }
          }
        }
    }
  };

  return (
    <div ref={list} className={`menu${sub ? " sub" : ""}`} role="menu" aria-labelledby={labelledBy} tabIndex={-1} onKeyDown={onKey}>
      {items.map((it, i) => {
        if ("sep" in it) return <div key={i} className="menu-sep" role="separator" />;
        const id = `${labelledBy}-${i}`;
        const run = () => {
          if (it.disabled) return;
          if (it.submenu) { setHot(i); setSubEntry("first"); return; }
          close();
          it.onClick?.();
        };
        return (
          <div key={i} className="menu-anchor" onPointerEnter={() => { setHot(i); setSubEntry(null); }}>
            <button
              id={id}
              role={it.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
              aria-checked={it.checked !== undefined ? it.checked : undefined}
              aria-haspopup={it.submenu ? "menu" : undefined}
              aria-expanded={it.submenu ? hot === i : undefined}
              aria-disabled={it.disabled || undefined}
              aria-keyshortcuts={it.shortcut?.replace(/Ctrl/g, "Control")}
              aria-description={it.title}
              tabIndex={-1}
              className={`menu-row${hot === i && it.submenu ? " hot" : ""}`}
              title={it.title}
              onClick={run}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); run(); } }}
            >
              <span className="menu-check" aria-hidden>{it.checked ? "✓" : ""}</span>
              <span className="menu-label">{it.label}</span>
              <span className="menu-key" aria-hidden>{it.shortcut ?? (it.submenu ? "▸" : "")}</span>
            </button>
            {it.submenu && hot === i && !it.disabled && (
              <MenuList items={it.submenu} labelledBy={id} entry={subEntry} close={close} sub
                closeSelf={() => { setHot(null); document.getElementById(id)?.focus(); }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

const svg = (children: ReactNode) => <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden>{children}</svg>;

/** 16px toolbar glyphs drawn in the flat Visual Studio 2019 icon style. */
export const Icon = {
  new: svg(<><path d="M3.5 1.5h6l3 3v10h-9z" className="i-fill i-line" /><path d="M9.5 1.5v3h3" className="i-line" /><path d="M12 9v6M9 12h6" className="i-add" /></>),
  open: svg(<><path d="M1.5 3.5h4l1 1h6v2" className="i-line" /><path d="M1.5 3.5v10h10l3-7h-10l-3 7" className="i-folder" /></>),
  save: svg(<><path d="M2.5 2.5h9l2 2v9h-11z" className="i-blue" /><rect x={5} y={3} width={5} height={3} className="i-paper" /><rect x={4.5} y={9} width={7} height={4} className="i-paper" /></>),
  undo: svg(<path d="M5 3L2 6l3 3M2 6h7a4 4 0 0 1 0 8H6" className="i-arrow" />),
  redo: svg(<path d="M11 3l3 3-3 3M14 6H7a4 4 0 0 0 0 8h3" className="i-arrow" />),
  select: svg(<path d="M4 2v11l3-3 2 5 2-1-2-5h4z" className="i-fill i-line" />),
  wire: svg(<><path d="M2 12h5V4h7" className="i-wire" /><circle cx={2} cy={12} r={1.5} className="i-dot" /><circle cx={14} cy={4} r={1.5} className="i-dot" /></>),
  datasheet: svg(<><path d="M2.5 1.5h6l3 3v10h-9z" className="i-fill i-line" /><path d="M4.5 7h5M4.5 9h5M4.5 11h3" className="i-line" /><path d="M13 7v7M10.5 11.5L13 14l2.5-2.5" className="i-arrow" /></>),
  assistant: svg(<><path d="M2.5 3.5h11v7h-6l-3 3v-3h-2z" className="i-fill i-line" /><path d="M8 5l.7 1.6 1.6.4-1.6.4L8 9l-.7-1.6-1.6-.4 1.6-.4z" className="i-spark" /></>),
  options: svg(<><circle cx={8} cy={8} r={2} className="i-line" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" className="i-line" /><circle cx={8} cy={8} r={4.5} className="i-line" /></>),
  run: svg(<path d="M4 2.5l9 5.5-9 5.5z" className="i-run" />),
  step: svg(<><path d="M3 3l6 5-6 5z" className="i-blue-fill" /><path d="M11.5 3v10" className="i-blue-line" /></>),
  pause: svg(<><rect x={4} y={3} width={3} height={10} className="i-blue-fill" /><rect x={9} y={3} width={3} height={10} className="i-blue-fill" /></>),
  stop: svg(<rect x={3.5} y={3.5} width={9} height={9} className="i-stop" />),
};
