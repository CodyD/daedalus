// Simulation runs off the UI thread. The worker paces simulated time against
// wall-clock time (like Proteus's real-time mode) and streams indicator
// state back at ~30 fps.

import type { Netlist } from "../../shared/component";
import { Simulator } from "../../sim/engine";
import { createModel } from "../../sim/models";

export type ToWorker =
  | { type: "start"; netlist: Netlist }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "step"; dt: number }
  | { type: "speed"; value: number }
  | { type: "actuate"; ref: string; action: Record<string, unknown> };

export interface Frame {
  type: "frame";
  time: number;
  running: boolean;
  /** Simulated seconds per wall second over the last frame. */
  rate: number;
  /** Fraction of the frame budget spent simulating (1 = can't keep up). */
  load: number;
  indicate: Record<string, unknown>;
  nets: Record<string, { v?: number; level?: number }>;
  logs: { time: number; level: string; source: string; message: string }[];
  failed: string | null;
}

export type FromWorker = Frame | { type: "error"; message: string };

let sim: Simulator | null = null;
let running = false;
let speed = 1;
let lastWall = 0;
let logCursor = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastRate = 0;
let lastLoad = 0;

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

function frame(): void {
  if (!sim) return;
  const logs = sim.logs.slice(logCursor);
  logCursor = sim.logs.length;
  post({
    type: "frame",
    time: sim.time,
    running,
    rate: lastRate,
    load: lastLoad,
    indicate: sim.indicateAll(),
    nets: sim.netStates(),
    logs,
    failed: sim.failed,
  });
}

function tick(): void {
  timer = null;
  if (!sim || !running) return;
  const now = performance.now();
  const wall = Math.min((now - lastWall) / 1000, 0.1);
  lastWall = now;
  const budgetMs = 14;
  const start = performance.now();
  const target = sim.time + wall * speed;
  const t0 = sim.time;
  try {
    // Advance in small chunks so a slow circuit can't freeze the worker.
    while (sim.time < target && performance.now() - start < budgetMs && !sim.failed) {
      sim.runUntil(Math.min(target, sim.time + Math.max((target - t0) / 8, 1e-5)));
    }
  } catch (e) {
    post({ type: "error", message: (e as Error).stack ?? String(e) });
    running = false;
  }
  const spent = performance.now() - start;
  lastLoad = Math.min(1, spent / budgetMs);
  lastRate = wall > 0 ? (sim.time - t0) / wall : 0;
  if (sim.failed) running = false;
  frame();
  timer = setTimeout(tick, Math.max(0, 33 - spent));
}

function schedule(): void {
  if (timer === null) {
    lastWall = performance.now();
    timer = setTimeout(tick, 0);
  }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case "start":
        sim = new Simulator(m.netlist, createModel);
        logCursor = 0;
        running = true;
        frame();
        schedule();
        break;
      case "pause":
        running = false;
        frame();
        break;
      case "resume":
        if (sim && !sim.failed) {
          running = true;
          schedule();
        }
        break;
      case "stop":
        running = false;
        sim = null;
        break;
      case "step":
        if (sim) {
          running = false;
          sim.runUntil(sim.time + m.dt);
          frame();
        }
        break;
      case "speed":
        speed = m.value;
        break;
      case "actuate":
        sim?.actuate(m.ref, m.action);
        if (!running) frame();
        break;
    }
  } catch (err) {
    post({ type: "error", message: (err as Error).stack ?? String(err) });
  }
};
