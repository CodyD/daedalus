import { describe, expect, it } from "vitest";
import {
  Layout, Node, PANELS, Split, activate, defaultLayout, dock, edgeOf, findNode, groups, locate, normalize, remove, setHidden,
} from "../src/renderer/src/dock/layout";

const all = (l: Layout) => [...[...groups(l.root)].flatMap((g) => g.panels), ...l.floats.flatMap((f) => f.panels)].sort();
/** Compact picture of the tree: row[...] / col[...], groups as their panels joined by "+". */
const shape = (n: Node): string =>
  n.kind === "doc" ? "doc" : n.kind === "group" ? n.panels.join("+") : `${n.dir}[${n.children.map(shape).join(", ")}]`;

const BOTTOM = "output+terminal+scope+cpu+firmware";

describe("dock layout", () => {
  it("places every panel exactly once by default", () => {
    expect(all(defaultLayout())).toEqual([...PANELS].sort());
    expect(shape(defaultLayout().root)).toBe(`row[parts, col[doc, ${BOTTOM}], properties+assistant+emulator]`);
  });

  it("tabs a window into another group and drops the emptied group", () => {
    const l = dock(defaultLayout(), ["parts"], "parts", { kind: "tab", groupId: "right" });
    expect(shape(l.root)).toBe(`row[col[doc, ${BOTTOM}], properties+assistant+emulator+parts]`);
    const right = [...groups(l.root)].find((g) => g.id === "right")!;
    expect(right.active).toBe("parts");
    expect(all(l)).toEqual([...PANELS].sort());
  });

  it("outer guides add a full-length pane at the far edge, beside existing panes", () => {
    const l = dock(defaultLayout(), ["output"], "output", { kind: "edge", side: "right" });
    expect(shape(l.root)).toBe("row[parts, col[doc, terminal+scope+cpu+firmware], properties+assistant+emulator, output]");
    const t = dock(defaultLayout(), ["parts"], "parts", { kind: "edge", side: "top" });
    expect(shape(t.root)).toBe(`col[parts, row[col[doc, ${BOTTOM}], properties+assistant+emulator]]`);
  });

  it("compass arrows split a tool window, in either direction", () => {
    const below = dock(defaultLayout(), ["assistant"], "assistant", { kind: "beside", nodeId: "right", side: "bottom" });
    expect(shape(below.root)).toBe(`row[parts, col[doc, ${BOTTOM}], col[properties+emulator, assistant]]`);
    const split = findNode(below, (below.root as Split).children[2].id) as Split;
    expect(split.sizes).toEqual([1, 1]);

    const beside = dock(defaultLayout(), ["assistant"], "assistant", { kind: "beside", nodeId: "right", side: "left" });
    expect(shape(beside.root)).toBe(`row[parts, col[doc, ${BOTTOM}], assistant, properties+emulator]`);
    const root = beside.root as Split;
    expect(root.sizes[2] + root.sizes[3]).toBe(320);
  });

  it("compass arrows over the document dock next to it", () => {
    const l = dock(defaultLayout(), ["cpu"], "cpu", { kind: "beside", nodeId: "doc", side: "right" });
    expect(shape(l.root)).toBe("row[parts, col[row[doc, cpu], output+terminal+scope+firmware], properties+assistant+emulator]");
  });

  it("collapses splits left with one child", () => {
    let l = dock(defaultLayout(), ["assistant"], "assistant", { kind: "beside", nodeId: "right", side: "bottom" });
    l = remove(l, ["properties", "emulator"]);
    expect(shape(l.root)).toBe(`row[parts, col[doc, ${BOTTOM}], assistant]`);
    expect((l.root as Split).sizes).toEqual([240, 1, 320]);
  });

  it("floats and re-docks a window", () => {
    let l = dock(defaultLayout(), ["output"], "output", { kind: "float", x: 10, y: 20, w: 300, h: 200 });
    expect(l.floats).toHaveLength(1);
    expect(locate(l, "output")).toMatchObject({ float: { x: 10, y: 20 } });
    l = dock(l, ["output"], "output", { kind: "edge", side: "left" });
    expect(l.floats).toHaveLength(0);
    expect(shape(l.root)).toMatch(/^row\[output, parts,/);
  });

  it("ignores dropping a whole group onto itself", () => {
    const l = defaultLayout();
    expect(dock(l, ["parts"], "parts", { kind: "tab", groupId: "left" })).toBe(l);
    expect(dock(l, ["parts"], "parts", { kind: "beside", nodeId: "left", side: "top" })).toBe(l);
  });

  it("auto-hides to the side of the document a window is on", () => {
    const l = defaultLayout();
    expect(edgeOf(l, "left")).toBe("left");
    expect(edgeOf(l, "right")).toBe("right");
    expect(edgeOf(l, "bottom")).toBe("bottom");
  });

  it("keeps a closed window's place and restores it on activate", () => {
    let l = setHidden(defaultLayout(), "scope", true);
    expect(l.hidden).toContain("scope");
    l = activate(l, "scope");
    expect(l.hidden).not.toContain("scope");
    expect([...groups(l.root)].find((g) => g.id === "bottom")!.active).toBe("scope");
  });

  it("repairs stored layouts: duplicates, unknown and missing panels, old versions", () => {
    const stored = remove(defaultLayout(), ["firmware"]);
    [...groups(stored.root)].find((g) => g.id === "left")!.panels.push("parts", "bogus" as never);
    const l = normalize(JSON.parse(JSON.stringify(stored)));
    expect(all(l)).toEqual([...PANELS].sort());
    expect(normalize({ v: 1, zones: {} })).toEqual(defaultLayout());
  });
});
