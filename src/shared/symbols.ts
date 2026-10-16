// Symbol geometry: where each pin's connection point sits relative to the
// part origin. Built-in symbols are hand-placed; everything else (including
// every datasheet-imported part) gets an auto-generated box from pin sides.

import type { ComponentDef, PinDef } from "./component";

export const GRID = 10;
export type Dir = "left" | "right" | "up" | "down";

export interface SymPin {
  id: string;
  /** Connection point (pin tip). */
  x: number;
  y: number;
  /** Direction the pin points away from the body. */
  dir: Dir;
  len: number;
  name: string;
  number: string;
}

export interface SymbolGeom {
  kind: string;
  /** Body rectangle (centered on origin). */
  w: number;
  h: number;
  pins: SymPin[];
}

type Spec = { w: number; h: number; pins: Record<string, [number, number, Dir]> };

const TWO_H: Spec = { w: 60, h: 20, pins: { A: [-40, 0, "left"], B: [40, 0, "right"] } };
const TWO_V: Spec = { w: 40, h: 40, pins: { P: [0, -40, "up"], N: [0, 40, "down"] } };
const METER: Spec = { w: 50, h: 50, pins: { P: [-40, 0, "left"], N: [40, 0, "right"] } };

const BUILTIN: Record<string, Spec> = {
  resistor: TWO_H,
  capacitor: { ...TWO_H, w: 20 },
  "capacitor-polar": { ...TWO_H, w: 20 },
  inductor: TWO_H,
  diode: { w: 30, h: 20, pins: { A: [-30, 0, "left"], K: [30, 0, "right"] } },
  zener: { w: 30, h: 20, pins: { A: [-30, 0, "left"], K: [30, 0, "right"] } },
  led: { w: 30, h: 30, pins: { A: [-30, 0, "left"], K: [30, 0, "right"] } },
  button: { w: 40, h: 20, pins: { A: [-40, 0, "left"], B: [40, 0, "right"] } },
  switch: { w: 40, h: 20, pins: { A: [-40, 0, "left"], B: [40, 0, "right"] } },
  pot: { w: 60, h: 20, pins: { A: [-40, 0, "left"], B: [40, 0, "right"], W: [0, -30, "up"] } },
  battery: TWO_V,
  vsource: TWO_V,
  ground: { w: 30, h: 20, pins: { GND: [0, -10, "up"] } },
  power: { w: 30, h: 20, pins: { P: [0, 10, "down"] } },
  label: { w: 60, h: 16, pins: { N: [-10, 0, "left"] } },
  npn: { w: 40, h: 50, pins: { C: [10, -30, "up"], B: [-30, 0, "left"], E: [10, 30, "down"] } },
  pnp: { w: 40, h: 50, pins: { E: [10, -30, "up"], B: [-30, 0, "left"], C: [10, 30, "down"] } },
  nmos: { w: 40, h: 50, pins: { D: [10, -30, "up"], G: [-30, 0, "left"], S: [10, 30, "down"] } },
  opamp: {
    w: 60, h: 60,
    pins: { INN: [-40, -10, "left"], INP: [-40, 10, "left"], OUT: [40, 0, "right"], VP: [0, -30, "up"], VN: [0, 30, "down"] },
  },
  clock: { w: 40, h: 30, pins: { Q: [30, 0, "right"] } },
  logicstate: { w: 30, h: 30, pins: { Q: [30, 0, "right"] } },
  logicprobe: { w: 30, h: 30, pins: { D: [-30, 0, "left"] } },
  vterm: { w: 80, h: 60, pins: { RXD: [-50, -10, "left"], TXD: [-50, 10, "left"] } },
  voltmeter: METER,
  ammeter: METER,
  scope: {
    w: 80, h: 100,
    pins: { A: [-50, -30, "left"], B: [-50, -10, "left"], C: [-50, 10, "left"], D: [-50, 30, "left"] },
  },
};

function lcdSpec(def: ComponentDef): Spec {
  const pins: Record<string, [number, number, Dir]> = {};
  def.pins.forEach((p, i) => { pins[p.id] = [-70 + i * 10, 60, "down"]; });
  return { w: 180, h: 100, pins };
}

function sevenSegSpec(): Spec {
  const pins: Record<string, [number, number, Dir]> = {};
  ["A", "B", "C", "D", "E", "F", "G", "DP"].forEach((s, i) => { pins[s] = [-40 + i * 10, 60, "down"]; });
  pins.COM = [0, -60, "up"];
  return { w: 90, h: 100, pins };
}

const PIN_LEN = 20;
const PITCH = 20;

function boxSymbol(def: ComponentDef): SymbolGeom {
  const sides: Record<PinDef["side"], PinDef[]> = { left: [], right: [], top: [], bottom: [] };
  for (const p of def.pins) sides[p.side].push(p);
  const longest = (ps: PinDef[]) => Math.max(0, ...ps.map((p) => p.name.length));
  const vCount = Math.max(sides.left.length, sides.right.length, 1);
  const hCount = Math.max(sides.top.length, sides.bottom.length, 1);
  const h = Math.max(vCount * PITCH + PITCH, 40, (longest(sides.top) + longest(sides.bottom)) * 6 + 20);
  const labelW = (longest(sides.left) + longest(sides.right)) * 6 + 30;
  let w = Math.max(hCount * PITCH + PITCH, labelW, 60);
  w = Math.ceil(w / (2 * GRID)) * 2 * GRID;
  const hh = Math.ceil(h / (2 * GRID)) * 2 * GRID;
  const pins: SymPin[] = [];
  const place = (ps: PinDef[], fn: (i: number, n: number) => [number, number], dir: Dir) => {
    ps.forEach((p, i) => {
      const [x, y] = fn(i, ps.length);
      pins.push({ id: p.id, x, y, dir, len: PIN_LEN, name: p.name, number: p.number });
    });
  };
  // Pins are centred along each side on the 20-unit pitch.
  const start = (n: number) => -((n - 1) * PITCH) / 2;
  place(sides.left, (i, n) => [-w / 2 - PIN_LEN, snap(start(n) + i * PITCH)], "left");
  place(sides.right, (i, n) => [w / 2 + PIN_LEN, snap(start(n) + i * PITCH)], "right");
  place(sides.top, (i, n) => [snap(start(n) + i * PITCH), -hh / 2 - PIN_LEN], "up");
  place(sides.bottom, (i, n) => [snap(start(n) + i * PITCH), hh / 2 + PIN_LEN], "down");
  return { kind: "box", w, h: hh, pins };
}

function snap(v: number): number {
  return Math.round(v / GRID) * GRID;
}

const cache = new WeakMap<ComponentDef, SymbolGeom>();

export function symbolFor(def: ComponentDef): SymbolGeom {
  const hit = cache.get(def);
  if (hit) return hit;
  let geom: SymbolGeom;
  const key = def.symbol.kind === "builtin" ? def.symbol.builtin ?? "" : "";
  const spec = key === "lcd" ? lcdSpec(def) : key === "sevenseg" ? sevenSegSpec() : BUILTIN[key];
  if (spec) {
    geom = {
      kind: key,
      w: spec.w,
      h: spec.h,
      pins: def.pins.filter((p) => spec.pins[p.id]).map((p) => {
        const [x, y, dir] = spec.pins[p.id];
        return { id: p.id, x, y, dir, len: 10, name: p.name, number: p.number };
      }),
    };
  } else geom = boxSymbol(def);
  cache.set(def, geom);
  return geom;
}

export type Rotation = 0 | 90 | 180 | 270;

export function rotatePoint(x: number, y: number, rot: Rotation, mirror = false): [number, number] {
  if (mirror) x = -x;
  switch (rot) {
    case 0: return [x, y];
    case 90: return [-y, x];
    case 180: return [-x, -y];
    case 270: return [y, -x];
  }
}

export function rotateDir(d: Dir, rot: Rotation, mirror = false): Dir {
  const order: Dir[] = ["right", "down", "left", "up"];
  let i = order.indexOf(d);
  if (mirror && (d === "left" || d === "right")) i = (i + 2) % 4;
  return order[(i + rot / 90) % 4];
}
