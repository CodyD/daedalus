import { describe, expect, it } from "vitest";
import { BUILTIN_LIBRARY } from "../src/shared/library";
import { validateComponent } from "../src/sim/validate";

describe("built-in library", () => {
  it.each(BUILTIN_LIBRARY.map((d) => [d.id, d] as const))("%s validates", (_id, def) => {
    const r = validateComponent(def);
    expect(r.errors).toEqual([]);
  });

  it("rejects a logic model that writes an input pin", () => {
    const bad = { ...BUILTIN_LIBRARY.find((d) => d.id === "74HC00")!, model: { kind: "logic", logic: "always { A1 = 1 }" } };
    expect(validateComponent(bad).errors.join()).toMatch(/declared as input/);
  });

  it("rejects unknown identifiers", () => {
    const bad = { ...BUILTIN_LIBRARY.find((d) => d.id === "74HC00")!, model: { kind: "logic", logic: "always { Y1 = FOO }" } };
    expect(validateComponent(bad).errors.join()).toMatch(/FOO/);
  });
});
