import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ComponentDef } from "../src/shared/component";
import { BUILTIN_LIBRARY } from "../src/shared/library";
import { buildBom } from "../src/shared/bom";
import { DEFAULT_PROFILE_ID, InventoryItem, describeInventory, mergeInventory, newProfile, normValue, onHand, profileIdFor } from "../src/shared/inventory";
import { emptyProject, Project } from "../src/shared/project";
import { profileStore } from "../src/main/profiles";
import { INTERVIEW_TOOLS } from "../src/main/assistant-prompt";

const defs = new Map<string, ComponentDef>(BUILTIN_LIBRARY.map((d) => [d.id, d]));
const item = (defId: string | undefined, name: string, qty: number, value?: string): InventoryItem => ({ id: name, defId, name, qty, value });

describe("inventory matching", () => {
  it("normalises values like the parts list", () => {
    expect(normValue("10k")).toBe(normValue("10000"));
    expect(normValue("10kΩ")).toBe(normValue("10K"));
    expect(normValue("4k7")).toBe(normValue("4.7k"));
    expect(normValue("")).toBe("");
    expect(normValue(undefined)).toBe("");
  });

  it("counts parts on hand per parts-list line by library part and value", () => {
    const p: Project = {
      ...emptyProject(),
      parts: [
        { ref: "R1", defId: "RES", x: 0, y: 0, rot: 0, props: { R: "10k" } },
        { ref: "R2", defId: "RES", x: 0, y: 0, rot: 0, props: { R: "330" } },
        { ref: "U1", defId: "NE555", x: 0, y: 0, rot: 0, props: {} },
      ],
    };
    const inv = [
      item("RES", "10k bag", 20, "10000"),
      item("RES", "10k loose", 3, "10k"),
      item("RES", "1k", 50, "1k"),
      item("NE555", "NE555P", 2),
      item(undefined, "BC547", 10),
    ];
    const lines = buildBom(p, defs);
    const have = Object.fromEntries(lines.map((l) => [l.refs.join(","), onHand(l, inv)]));
    expect(have).toEqual({ R1: 23, R2: 0, U1: 2 });
  });

  it("ignores empty bins", () => {
    const p: Project = { ...emptyProject(), parts: [{ ref: "U1", defId: "NE555", x: 0, y: 0, rot: 0, props: {} }] };
    expect(onHand(buildBom(p, defs)[0], [item("NE555", "NE555P", 0)])).toBe(0);
  });

  it("describes the inventory for the assistant with placeable library ids", () => {
    const prof = { ...newProfile("default", "Default"), inventory: [item("NE555", "NE555P", 2), item(undefined, "BC547", 10), item("RES", "gone", 0, "1k")] };
    const d = describeInventory(prof, defs);
    expect(d.items).toHaveLength(2);
    expect(d.items[0]).toMatchObject({ name: "NE555P", library_id: "NE555", qty: 2 });
    expect(d.items[1]).toMatchObject({ name: "BC547", library_id: null });
    expect(INTERVIEW_TOOLS.has("get_inventory")).toBe(true);
  });

  it("makes unique profile ids", () => {
    expect(profileIdFor("Cody's Bench!", new Set())).toBe("cody-s-bench");
    expect(profileIdFor("Default", new Set(["default"]))).toBe("default-2");
    expect(profileIdFor("***", new Set())).toBe("profile");
  });
});

describe("profile store", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("creates the default profile and round-trips inventories", async () => {
    dir = mkdtempSync(join(tmpdir(), "daedalus-profiles-"));
    const store = profileStore(join(dir, "profiles"));
    expect((await store.list()).map((p) => p.id)).toEqual([DEFAULT_PROFILE_ID]);

    await store.setInventory(DEFAULT_PROFILE_ID, [item("RES", "10k", 5, "10k")]);
    expect((await store.get(DEFAULT_PROFILE_ID)).inventory).toHaveLength(1);

    const lab = await store.create("Lab");
    await store.rename(lab.id, "Lab bench");
    expect((await store.list()).map((p) => p.name)).toEqual(["Default", "Lab bench"]);
    await expect(store.setInventory(lab.id, [{ id: "x", name: "bad", qty: -1 }])).rejects.toThrow();

    await store.remove(lab.id);
    expect((await store.get(lab.id)).id).toBe(DEFAULT_PROFILE_ID);
    await expect(store.remove(DEFAULT_PROFILE_ID)).rejects.toThrow();
  });
});

describe("mergeInventory", () => {
  const base = [item("NE555", "a", 2), item("RES", "b", 10, "10k")];

  it("keeps items and quantity changes made elsewhere since loading", () => {
    const mine = [{ ...base[0], location: "drawer 1" }, { ...base[1], qty: 8 }];
    const theirs = [{ ...base[0], qty: 5 }, base[1], item(undefined, "phone-added", 3)];
    expect(mergeInventory(base, mine, theirs)).toEqual([
      { ...base[0], location: "drawer 1", qty: 5 },
      { ...base[1], qty: 8 },
      item(undefined, "phone-added", 3),
    ]);
  });

  it("keeps local deletions and additions", () => {
    const mine = [base[1], item(undefined, "new-here", 1)];
    expect(mergeInventory(base, mine, base)).toEqual(mine);
  });
});
