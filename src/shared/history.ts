// Undo/redo history as stored inside a .dad file.
//
// Snapshots share almost everything with their neighbours (one step usually
// moves or adds a single part), so each distinct value -- a part, a wire, the
// firmware sources, the name -- is written once into `pool`, and every snapshot
// is just indices into it: an array field becomes a list of indices, any other
// field a single index.

import type { Project } from "./project";

type Snapshot = Record<string, number | number[]>;

export interface SavedHistory {
  version: 1;
  pool: unknown[];
  past: Snapshot[];
  future: Snapshot[];
}

/** A project without its embedded history (what the editor works on). */
export function stripHistory(p: Project): Project {
  if (!p.history) return p;
  const { history: _, ...rest } = p;
  return rest;
}

export function encodeHistory(past: Project[], future: Project[]): SavedHistory | undefined {
  if (!past.length && !future.length) return undefined;
  const pool: unknown[] = [];
  const index = new Map<string, number>();
  const intern = (v: unknown) => {
    const key = JSON.stringify(v);
    let i = index.get(key);
    if (i === undefined) {
      i = pool.length;
      pool.push(v);
      index.set(key, i);
    }
    return i;
  };
  const snap = (p: Project): Snapshot => {
    const out: Snapshot = {};
    for (const [k, v] of Object.entries(stripHistory(p))) {
      if (v === undefined) continue;
      out[k] = Array.isArray(v) ? v.map(intern) : intern(v);
    }
    return out;
  };
  return { version: 1, pool, past: past.map(snap), future: future.map(snap) };
}

/** Rebuild the snapshots; returns empty stacks for a missing or unreadable history. */
export function decodeHistory(h: SavedHistory | undefined): { past: Project[]; future: Project[] } {
  if (!h || h.version !== 1 || !Array.isArray(h.pool)) return { past: [], future: [] };
  const value = (i: number) => {
    if (!(i in h.pool)) throw new Error(`history index ${i} out of range`);
    return h.pool[i];
  };
  const thaw = (s: Snapshot): Project => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) out[k] = Array.isArray(v) ? v.map(value) : value(v);
    return out as unknown as Project;
  };
  try {
    return { past: (h.past ?? []).map(thaw), future: (h.future ?? []).map(thaw) };
  } catch {
    return { past: [], future: [] };
  }
}
