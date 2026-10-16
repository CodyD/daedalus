import { describe, expect, it } from "vitest";
import { decodeHistory, encodeHistory, stripHistory } from "../src/shared/history";
import { Project, emptyProject } from "../src/shared/project";

const withPart = (p: Project, ref: string, x: number): Project =>
  ({ ...p, parts: [...p.parts, { ref, defId: "RES", x, y: 0, rot: 0, props: { R: "1k" } }] });

describe("saved undo history", () => {
  it("round-trips past and future snapshots exactly", () => {
    const a = emptyProject();
    const b = withPart(a, "R1", 0);
    const c = withPart(b, "R2", 40);
    const d = { ...c, sources: { "main.asm": "nop" } };
    const h = encodeHistory([a, b, c], [d])!;
    const back = decodeHistory(JSON.parse(JSON.stringify(h)));
    expect(back.past).toEqual([a, b, c]);
    expect(back.future).toEqual([d]);
  });

  it("stores each distinct part once", () => {
    let p = emptyProject();
    const past: Project[] = [];
    for (let i = 0; i < 50; i++) { past.push(p); p = withPart(p, `R${i}`, i * 40); }
    const h = encodeHistory(past, [])!;
    const parts = h.pool.filter((v) => typeof v === "object" && v !== null && "ref" in v);
    expect(parts).toHaveLength(49);
  });

  it("is empty when there is nothing to undo or redo", () => {
    expect(encodeHistory([], [])).toBeUndefined();
    expect(decodeHistory(undefined)).toEqual({ past: [], future: [] });
  });

  it("drops a corrupt history instead of throwing", () => {
    expect(decodeHistory({ version: 1, pool: [], past: [{ name: 5 }], future: [] })).toEqual({ past: [], future: [] });
  });

  it("never nests history inside snapshots", () => {
    const a = emptyProject();
    const withHist = { ...a, history: encodeHistory([a], [])! };
    expect(stripHistory(withHist)).toEqual(a);
    expect(decodeHistory(encodeHistory([withHist], [])).past[0].history).toBeUndefined();
  });
});
