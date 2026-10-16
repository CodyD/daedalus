import { RefObject, useEffect, useRef } from "react";

/** Per-machine accessibility preferences (kept in localStorage). */
export interface A11yOptions {
  /** Whole-window zoom factor, 1 = 100%. */
  zoom: number;
  /** Stop pulsing / animated indicators even when the OS doesn't ask for it. */
  reduceMotion: boolean;
  /** Okabe-Ito colours for wires, logic levels and scope traces. */
  colorSafe: boolean;
  /** Speak selection and simulation changes through the screen reader. */
  announce: boolean;
}

export const ZOOMS = [1, 1.25, 1.5, 1.75, 2];
const KEY = "daedalus.a11y";
const DEFAULTS: A11yOptions = { zoom: 1, reduceMotion: false, colorSafe: false, announce: true };

export function loadA11y(): A11yOptions {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<A11yOptions>;
    return {
      zoom: typeof v.zoom === "number" && v.zoom >= 0.5 && v.zoom <= 3 ? v.zoom : DEFAULTS.zoom,
      reduceMotion: v.reduceMotion === true,
      colorSafe: v.colorSafe === true,
      announce: v.announce !== false,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveA11y(o: A11yOptions): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch { /* storage unavailable */ }
}

let announceOn = true;

/** Applies the options to the page: zoom, and data attributes the stylesheet keys off. */
export function applyA11y(o: A11yOptions, setZoom: (f: number) => void): void {
  const d = document.documentElement.dataset;
  if (o.reduceMotion) d.reduceMotion = "1"; else delete d.reduceMotion;
  if (o.colorSafe) d.palette = "safe"; else delete d.palette;
  announceOn = o.announce;
  setZoom(o.zoom);
}

/** Steps the zoom one notch through ZOOMS (dir 0 resets). */
export function stepZoom(z: number, dir: -1 | 0 | 1): number {
  if (dir === 0) return 1;
  const i = ZOOMS.findIndex((v) => v >= z - 0.001);
  const at = i < 0 ? ZOOMS.length - 1 : i;
  return ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, ZOOMS[at] === z ? at + dir : dir > 0 ? at : at - 1))];
}

// --- screen reader announcements ----------------------------------------------
// Two polite live regions used alternately, so repeating the same message is
// still spoken.

let flip = false;

export function announce(msg: string, assertive = false): void {
  if (!announceOn || !msg) return;
  const id = assertive ? "sr-alert" : flip ? "sr-polite-a" : "sr-polite-b";
  const other = assertive ? null : flip ? "sr-polite-b" : "sr-polite-a";
  flip = !flip;
  const el = document.getElementById(id);
  if (other) { const o = document.getElementById(other); if (o) o.textContent = ""; }
  if (!el) return;
  el.textContent = "";
  // A fresh text node after a tick is what makes readers pick up the change.
  setTimeout(() => { el.textContent = msg; }, 30);
}

// --- dialogs ---------------------------------------------------------------------

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

export const focusables = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);

/**
 * Modal behaviour for a dialog element: moves focus into it, keeps Tab inside,
 * closes on Escape, and gives focus back to whatever had it on close.
 */
export function useModal(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    const first = el.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(el)[0] ?? el;
    first.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); closeRef.current(); return; }
      if (e.key !== "Tab") return;
      const f = focusables(el);
      if (!f.length) { e.preventDefault(); return; }
      const i = f.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    };
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [ref]);
}

/** Arrow-key movement between the items of a toolbar, tab list or similar (roving focus). */
export function arrowNav(e: React.KeyboardEvent, selector: string, axis: "x" | "y" | "both" = "x"): void {
  const keys = axis === "x" ? ["ArrowLeft", "ArrowRight"] : axis === "y" ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
  if (![...keys, "Home", "End"].includes(e.key)) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(selector)].filter((x) => !(x as HTMLButtonElement).disabled);
  if (!items.length) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  const back = e.key === "ArrowLeft" || e.key === "ArrowUp";
  const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + (back ? -1 : 1) + items.length) % items.length;
  e.preventDefault();
  items[next].focus();
}
