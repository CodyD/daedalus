// Drawing helpers for wires: crossing hops and name-joined connection routes.

export type Pt = [number, number];
export type Seg = [Pt, Pt];

export const HOP_R = 4;

export function segmentsOf(points: Pt[]): Seg[] {
  const out: Seg[] = [];
  for (let i = 1; i < points.length; i++) out.push([points[i - 1], points[i]]);
  return out;
}

/**
 * SVG path for a polyline where every horizontal run hops (half circle) over
 * the vertical segments it crosses. Only strict crossings count: a point that
 * lies on an end of either segment is a connection, not a crossing.
 */
export function hopPath(points: Pt[], verticals: Seg[], r = HOP_R): string {
  if (!points.length) return "";
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    if (a[1] === b[1] && a[0] !== b[0]) {
      const y = a[1];
      const dir = Math.sign(b[0] - a[0]);
      const lo = Math.min(a[0], b[0]), hi = Math.max(a[0], b[0]);
      const xs = verticals
        .filter(([p, q]) => p[0] === q[0] && p[0] - r > lo && p[0] + r < hi && y > Math.min(p[1], q[1]) && y < Math.max(p[1], q[1]))
        .map(([p]) => p[0])
        .sort((m, n) => (m - n) * dir);
      let last = -Infinity;
      for (const x of xs) {
        if (Math.abs(x - last) < 2 * r) continue; // hops would overlap
        d += ` L${x - dir * r},${y} A${r},${r} 0 0 ${dir > 0 ? 1 : 0} ${x + dir * r},${y}`;
        last = x;
      }
    }
    d += ` L${b[0]},${b[1]}`;
  }
  return d;
}

/** Horizontal-then-vertical route between two points. */
export function lRoute(a: Pt, b: Pt): Pt[] {
  if (a[0] === b[0] || a[1] === b[1]) return [a, b];
  return [a, [b[0], a[1]], b];
}

/** Minimum spanning tree (Manhattan distance) over points, as index pairs. */
export function manhattanTree(pts: Pt[]): [number, number][] {
  const edges: [number, number][] = [];
  if (pts.length < 2) return edges;
  const inTree = new Set([0]);
  const best = pts.map((p) => Math.abs(p[0] - pts[0][0]) + Math.abs(p[1] - pts[0][1]));
  const from = pts.map(() => 0);
  while (inTree.size < pts.length) {
    let pick = -1;
    for (let i = 0; i < pts.length; i++) if (!inTree.has(i) && (pick < 0 || best[i] < best[pick])) pick = i;
    inTree.add(pick);
    edges.push([from[pick], pick]);
    for (let i = 0; i < pts.length; i++) {
      if (inTree.has(i)) continue;
      const dist = Math.abs(pts[i][0] - pts[pick][0]) + Math.abs(pts[i][1] - pts[pick][1]);
      if (dist < best[i]) { best[i] = dist; from[i] = pick; }
    }
  }
  return edges;
}
