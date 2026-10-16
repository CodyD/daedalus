// Digital state model. Mirrors the strength-based states of event-driven
// logic simulators (VSM uses SLO/SHI/WLO/WHI/FLT and friends): every driver on
// a net contributes a drive, and the net resolves to the strongest one.

/** What a pin drives onto its net. */
export const enum Drive {
  Z = 0, // released / high impedance
  WL = 1, // weak low (pull-down)
  WH = 2, // weak high (pull-up)
  SL = 3, // strong low
  SH = 4, // strong high
}

/** What a net (or a thresholded analog input) reads as. */
export const enum Level {
  L = 0,
  H = 1,
  Z = 2,
  X = 3,
}

export function strength(d: Drive): number {
  return d === Drive.Z ? 0 : d <= Drive.WH ? 1 : 2;
}

export function driveLevel(d: Drive): Level {
  switch (d) {
    case Drive.Z: return Level.Z;
    case Drive.WL: case Drive.SL: return Level.L;
    default: return Level.H;
  }
}

/** Resolve all drivers on a net. Conflicting drives of equal strength give X. */
export function resolve(drives: Iterable<Drive>): Level {
  let best = 0;
  let level: Level = Level.Z;
  for (const d of drives) {
    const s = strength(d);
    if (s === 0) continue;
    const l = driveLevel(d);
    if (s > best) {
      best = s;
      level = l;
    } else if (s === best && l !== level) {
      level = Level.X;
    }
  }
  return level;
}

export function levelChar(l: Level): string {
  return ["0", "1", "Z", "X"][l];
}

export function isHigh(l: Level): boolean {
  return l === Level.H;
}
