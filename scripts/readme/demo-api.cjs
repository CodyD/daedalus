// Preload for the README screenshots of the AI features. It stands in for the
// real preload (src/preload) with a scripted `window.daedalus`: the assistant
// replays a recorded build (the tool calls from test/assistant.test.ts) and the
// datasheet import streams canned progress. Tool calls still run through the
// renderer's real executor, so the schematic, firmware and simulation report
// in the screenshot are genuine. Nothing here calls Claude.

const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = process.argv.find((a) => a.startsWith("--readme-root="))?.slice("--readme-root=".length) ?? process.cwd();
const example = JSON.parse(readFileSync(join(root, "examples", "07-assistant-built-button-led.dad"), "utf8"));
const firmware = example.sources["main.asm"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const desktopOnly = () => Promise.reject(new Error("Not available in the README demo."));

const eventFns = new Set();
const execFns = new Set();
const progressFns = new Set();
const pending = new Map();
let seq = 0;

const emit = (ev) => eventFns.forEach((f) => f(ev));
const say = (text) => emit({ type: "text", delta: text });

async function tool(name, input) {
  const id = `demo${++seq}`;
  emit({ type: "tool-start", id, name, input });
  const result = await new Promise((resolve) => {
    pending.set(id, resolve);
    execFns.forEach((f) => f({ id, name, input }));
  });
  emit({ type: "tool-end", id, ok: !result?.error, summary: result?.summary ?? result?.error ?? "" });
  await sleep(60);
  return result;
}

async function interview() {
  await sleep(200);
  say([
    "Got it: an LED that stays lit while a push-button is held down.",
    "",
    "- **MCU:** ATmega328P at 16 MHz (already in the library)",
    "- **LED:** red, 330 Ω series resistor, driven from `PB5`",
    "- **Button:** momentary, `PD2` to ground, using the internal pull-up",
    "",
    "Spec complete. Press **Build** and I'll wire it, write the firmware and check it in simulation.",
  ].join("\n"));
  emit({ type: "done", costUsd: 0.018, stopReason: "end_turn", subscription: true });
}

async function build() {
  emit({ type: "status", message: "Planning the schematic…" });
  await tool("search_library", { query: "ATmega328P" });
  await tool("place_part", { def_id: "ATMEGA328P" });
  await tool("place_part", { def_id: "RES", props: { R: "330" } });
  await tool("place_part", { def_id: "LED-RED" });
  await tool("place_part", { def_id: "BUTTON" });
  await tool("connect", { net: "LED_DRIVE", pins: ["U1.PB5", "R1.A"] });
  await tool("connect", { net: "LED_A", pins: ["R1.B", "D1.A"] });
  await tool("connect", { net: "GND", pins: ["D1.K", "SW1.B", "U1.GND"] });
  await tool("connect", { net: "VCC", pins: ["U1.VCC"], rail_voltage: 5 });
  await tool("connect", { net: "BTN", pins: ["U1.PD2", "SW1.A"] });
  await tool("write_firmware", { mcu_ref: "U1", filename: "main.asm", source: firmware });
  const report = await tool("run_simulation", {
    seconds: 0.03,
    actions: [{ at: 0.01, ref: "SW1", action: { pressed: true } }, { at: 0.02, ref: "SW1", action: { pressed: false } }],
    watch: ["LED_DRIVE"],
  });
  const transitions = report?.watched?.LED_DRIVE?.transitions ?? 2;
  say([
    "Built and verified. In a 30 ms simulation I held **SW1** from 10 ms to 20 ms:",
    "",
    `- \`LED_DRIVE\` switched ${transitions} times (on at the press, off at the release)`,
    "- **D1** is dark at the end, with the button released",
    "",
    "Press **Start** and click the button to try it.",
  ].join("\n"));
  emit({ type: "done", costUsd: 0.142, stopReason: "end_turn", subscription: true });
}

async function importProgress() {
  const steps = [
    ["reading", "sn74hc165.pdf: 38 pages, 71,400 input tokens (cached for repairs)"],
    ["thinking", "Pinout table on page 3: 16 pins, SH/LD active low, CLK INH gates the clock."],
    ["thinking", "Function table: parallel load is asynchronous; shifting happens on the rising CLK edge."],
    ["thinking", "DC characteristics at VCC = 5 V: VIH 3.15 V, VIL 1.35 V, VOH 4.4 V. Propagation delay 13 ns typical."],
    ["writing", "Behavioural logic model, 9 lines, 16 pins"],
    ["validating", "Schema OK · logic program parsed · pins cross-checked · dry run OK"],
  ];
  for (const [phase, message] of steps) {
    await sleep(120);
    progressFns.forEach((f) => f({ phase, message }));
  }
}

const sub = (set) => (fn) => { set.add(fn); return () => set.delete(fn); };

window.daedalus = {
  listLibrary: async () => [],
  savePart: async () => true,
  deletePart: async () => true,
  revealLibrary: desktopOnly,
  openDatasheet: desktopOnly,
  openProject: desktopOnly,
  openProjectPath: desktopOnly,
  recentProjects: async () => [],
  saveProject: desktopOnly,
  pickFile: desktopOnly,
  readFile: async () => null,
  listExamples: async () => [],
  pickDatasheet: async () => ({ path: "C:\\datasheets\\sn74hc165.pdf", name: "sn74hc165.pdf", pages: 38, bytes: 1_642_118 }),
  estimateImport: async () => ({ inputTokens: 71_400, costUsd: 0.36, pages: 38, subscription: false }),
  importDatasheet: () => { importProgress(); return new Promise(() => {}); },
  cancelImport: async () => true,
  onImportProgress: sub(progressFns),
  assistantSend: async (_text, phase) => { (phase === "build" ? build() : interview()); return true; },
  assistantCancel: async () => {},
  assistantReset: async () => {},
  assistantResult: async (id, result) => { pending.get(id)?.(result); pending.delete(id); },
  onAssistantEvent: sub(eventFns),
  onAssistantExec: sub(execFns),
  getSettings: async () => ({
    keySource: "settings", encryption: true, provider: "claude-code", providerSetting: "auto", claudeCode: { path: "claude", version: null },
  }),
  setProvider: async () => true,
  setApiKey: async () => true,
  setTheme: async () => {},
  setZoom: (f) => { document.documentElement.style.setProperty("zoom", String(f)); },
};
