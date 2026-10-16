// SPICE-style engineering-notation parsing: 4k7, 10u, 2.2meg, 100n, 1e-6, 16MHz.

const SUFFIX: [string, number][] = [
  ["meg", 1e6],
  ["mil", 25.4e-6],
  ["t", 1e12],
  ["g", 1e9],
  ["k", 1e3],
  ["m", 1e-3],
  ["u", 1e-6],
  ["µ", 1e-6],
  ["n", 1e-9],
  ["p", 1e-12],
  ["f", 1e-15],
];

export function parseValue(input: string | number): number {
  if (typeof input === "number") return input;
  const s = input.trim().toLowerCase();
  // "4k7" style: suffix used as the decimal point.
  const rkm = /^(\d+)([kmgunpr])(\d+)$/.exec(s);
  if (rkm) {
    const mult = rkm[2] === "r" ? 1 : suffixMult(rkm[2]);
    return parseFloat(`${rkm[1]}.${rkm[3]}`) * mult;
  }
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([a-zµ]*)/.exec(s);
  if (!m) return NaN;
  const base = parseFloat(m[1]);
  const rest = m[2];
  if (!rest) return base;
  // Frequencies: "16MHz" means mega even though SPICE reads a lone "m" as milli.
  if (/^(meg|m)hz/.test(rest)) return base * 1e6;
  for (const [suf, mult] of SUFFIX) {
    if (rest.startsWith(suf)) return base * mult;
  }
  return base; // trailing unit letters only, e.g. "5v", "10hz"
}

function suffixMult(c: string): number {
  for (const [suf, mult] of SUFFIX) if (suf === c) return mult;
  return 1;
}

export function formatValue(v: number, unit = ""): string {
  if (!isFinite(v)) return String(v);
  const a = Math.abs(v);
  const table: [number, string][] = [
    [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"],
  ];
  if (a === 0) return `0${unit}`;
  for (const [m, s] of table) {
    if (a >= m) return `${+(v / m).toPrecision(4)}${s}${unit}`;
  }
  return `${v.toExponential(3)}${unit}`;
}
