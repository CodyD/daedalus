import { describe, expect, it } from "vitest";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ImportResult } from "../src/main/datasheet";
import { IMPORT_SYSTEM_PROMPT } from "../src/main/import-prompt";

describe("datasheet import request", () => {
  it("produces a structured-output schema without unsupported keywords", () => {
    const fmt = betaZodOutputFormat(ImportResult) as unknown as { schema: unknown };
    const text = JSON.stringify(fmt.schema);
    for (const bad of ["minimum", "maximum", "minLength", "maxLength", "multipleOf", "patternProperties"]) {
      expect(text.includes(`"${bad}"`), bad).toBe(false);
    }
    // every object must forbid extra properties
    const walk = (n: unknown): void => {
      if (!n || typeof n !== "object") return;
      const o = n as Record<string, unknown>;
      if (o.type === "object") expect(o.additionalProperties).toBe(false);
      Object.values(o).forEach(walk);
    };
    walk(fmt.schema);
  });

  it("keeps the system prompt byte-stable for caching", () => {
    expect(IMPORT_SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(IMPORT_SYSTEM_PROMPT).toContain("hd44780");
  });
});
