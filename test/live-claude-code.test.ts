// Live tests against the locally installed Claude Code CLI (uses your plan).
// Skipped unless LIVE_CLAUDE_CODE=1.

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { ComponentDef, Netlist } from "../src/shared/component";
import { emptyProject, Project } from "../src/shared/project";
import { runHeadless } from "../src/sim/headless";
import { assemble } from "../src/sim/mcu/avr/asm";
import { M328P_SYMBOLS } from "../src/sim/mcu/avr/variants";
import { toIntelHex } from "../src/sim/mcu/hex";
import { Assistant, AssistantEvent } from "../src/main/assistant";
import { importDatasheetViaClaudeCode } from "../src/main/datasheet-claude-code";
import { ExecContext, executeTool } from "../src/renderer/src/assistant/executor";
import { DEFS } from "./example-builder";

const LIVE = !!process.env.LIVE_CLAUDE_CODE;
const work = join(tmpdir(), "daedalus-live");
mkdirSync(work, { recursive: true });

async function fakeDatasheet(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const lines = [
    "DX1G00 - Single 2-input NAND gate (fictional test part)",
    "",
    "Description: The DX1G00 provides one 2-input NAND function, Y = NOT(A AND B).",
    "Supply voltage range 2.0 V to 5.5 V. Package: SOT-23-5.",
    "",
    "Pin configuration (SOT-23-5):",
    "  Pin 1  A    Data input",
    "  Pin 2  B    Data input",
    "  Pin 3  GND  Ground",
    "  Pin 4  Y    Data output",
    "  Pin 5  VCC  Supply voltage",
    "",
    "DC characteristics at VCC = 5.0 V:",
    "  VIH (min) 3.5 V   VIL (max) 1.5 V",
    "  VOH (min) 4.4 V at IOH = -4 mA   VOL (max) 0.1 V",
    "  Typical propagation delay tpd = 6 ns",
    "Absolute maximum: VCC 7 V, any input 7 V, output current +/-50 mA.",
  ];
  lines.forEach((l, i) => page.drawText(l, { x: 50, y: 740 - i * 18, size: 11, font }));
  writeFileSync(path, await doc.save());
}

function session() {
  let project: Project = emptyProject();
  const defs = new Map<string, ComponentDef>(DEFS);
  const ctx: ExecContext = {
    getProject: () => project,
    setProject: (p) => { project = p; },
    defs: () => defs,
    resolveFiles: async (netlist: Netlist, proj: Project) => ({
      netlist: {
        ...netlist,
        instances: netlist.instances.map((i) => {
          const prog = i.props.PROGRAM;
          if (!prog?.startsWith("src:")) return i;
          return { ...i, files: { PROGRAM: toIntelHex(assemble(proj.sources![prog.slice(4)], M328P_SYMBOLS).bytes) } };
        }),
      },
      problems: [],
    }),
    simulate: async (netlist, opts) => runHeadless(netlist, opts),
    askApproval: async () => true,
    askFile: async () => null,
    libraryChanged: async () => {},
    savePart: async (def) => { defs.set(def.id, def); },
  };
  return { ctx, project: () => project, defs };
}

describe.skipIf(!LIVE)("live Claude Code", () => {
  it("imports a datasheet through the local CLI", async () => {
    const pdf = join(work, "dx1g00.pdf");
    await fakeDatasheet(pdf);
    const progress: string[] = [];
    const out = await importDatasheetViaClaudeCode({ path: pdf }, (p) => progress.push(p.message), { workDir: work });
    console.log("progress:", progress.join(" | "));
    console.log("component:", JSON.stringify(out.result.component.pins), out.result.component.model);
    expect(out.errors).toEqual([]);
    const c = out.result.component;
    expect(c.pins.map((p) => p.number).sort()).toEqual(["1", "2", "3", "4", "5"]);
    expect(c.model.kind).toBe("logic");
  }, 600_000);

  it("runs the design assistant with tools over MCP", async () => {
    const { ctx, project } = session();
    const events: AssistantEvent[] = [];
    const assistant = new Assistant({
      emit: (ev) => { events.push(ev); if (ev.type !== "text") console.log("event", JSON.stringify(ev).slice(0, 200)); },
      exec: (name, input) => executeTool(name, input, ctx),
      apiKey: async () => undefined,
      provider: async () => "claude-code",
      claudeCode: () => ({ workDir: work }),
      downloadsDir: () => work,
      saveComponent: async () => {},
      importDatasheet: async () => { throw new Error("not used"); },
      estimateImport: async () => ({ costUsd: 0, pages: 0, subscription: true }),
    });
    await assistant.send(
      "Go ahead without asking: build an ATmega328P circuit where PB5 drives a red LED through a 330 ohm resistor to ground, " +
      "write firmware that blinks it at about 2 Hz, then run_simulation for 1.5 seconds watching the LED drive net and confirm it toggles. Use only library parts; no web search needed.",
    );
    const text = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    console.log("assistant said:", text.slice(-1500));
    const err = events.find((e) => e.type === "error");
    expect(err).toBeUndefined();
    const tools = events.filter((e) => e.type === "tool-start").map((e) => (e as { name: string }).name);
    expect(tools).toContain("place_part");
    expect(tools).toContain("connect");
    expect(tools).toContain("write_firmware");
    expect(tools).toContain("run_simulation");
    const p = project();
    expect(p.parts.some((x) => x.defId === "ATMEGA328P")).toBe(true);
    expect(p.parts.some((x) => x.defId.startsWith("LED"))).toBe(true);
  }, 900_000);
});
