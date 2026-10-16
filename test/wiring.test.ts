import { describe, expect, it } from "vitest";
import { hopPath, lRoute, manhattanTree } from "../src/renderer/src/wiring";

describe("wiring helpers", () => {
  it("hops a horizontal run over a crossing vertical", () => {
    const d = hopPath([[0, 0], [40, 0]], [[[20, -10], [20, 10]]]);
    expect(d).toBe("M0,0 L16,0 A4,4 0 0 1 24,0 L40,0");
  });

  it("hops right-to-left with the arc still on top", () => {
    const d = hopPath([[40, 0], [0, 0]], [[[20, -10], [20, 10]]]);
    expect(d).toBe("M40,0 L24,0 A4,4 0 0 0 16,0 L0,0");
  });

  it("does not hop at T-junctions or shared endpoints", () => {
    expect(hopPath([[0, 0], [40, 0]], [[[20, 0], [20, 10]]])).toBe("M0,0 L40,0");
    expect(hopPath([[0, 0], [40, 0]], [[[40, -10], [40, 10]]])).toBe("M0,0 L40,0");
  });

  it("routes L shapes and spans every point", () => {
    expect(lRoute([0, 0], [20, 30])).toEqual([[0, 0], [20, 0], [20, 30]]);
    expect(manhattanTree([[0, 0], [100, 0], [10, 0]])).toEqual([[0, 2], [2, 1]]);
  });
});
