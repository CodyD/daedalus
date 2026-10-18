// Design assistant: a Claude agent that takes the user from a concept to a
// part list, imports missing datasheets, and builds/verifies the schematic.
//
// Two interchangeable back ends run the same tools:
//   * Claude API: SDK tool runner in this process (needs an API key).
//   * Claude Code: the user's local `claude` CLI and login, with the tools
//     served to it over a localhost MCP server.
// Schematic tools execute in the renderer, which owns the project state; they
// are proxied over IPC via `host.exec`. Datasheet imports always ask first.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { mkdir, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import type { ComponentDef } from "../shared/component";
import { ASSISTANT_SYSTEM_PROMPT, AssistantPhase, INTERVIEW_TOOLS } from "./assistant-prompt";
import { runClaudeCode } from "./claude-code";
import { MODEL } from "./datasheet";
import type { ImportOutcome, ImportProgress, ImportRequest } from "./datasheet";
import { startToolServer } from "./mcp-server";

const PRICE_IN = 4;
const PRICE_OUT = 20;
const PRICE_CACHE_READ = 0.4;
const MAX_PDF_BYTES = 30 * 1024 * 1024;

export type AssistantEvent =
  | { type: "text"; delta: string }
  | { type: "tool-start"; id: string; name: string; input: unknown }
  | { type: "tool-end"; id: string; ok: boolean; summary: string }
  | { type: "web"; kind: "search" | "fetch"; detail: string }
  | { type: "status"; message: string }
  | { type: "done"; costUsd: number; stopReason: string | null; subscription?: boolean }
  | { type: "error"; message: string };

export type Provider = "api" | "claude-code";

export interface AssistantHost {
  emit(ev: AssistantEvent): void;
  /** Run a renderer-side tool or UI prompt and wait for its JSON result. */
  exec(name: string, input: unknown): Promise<unknown>;
  apiKey(): Promise<string | undefined>;
  provider(): Promise<Provider>;
  claudeCode(): { exe?: string; workDir: string };
  downloadsDir(): string;
  saveComponent(def: ComponentDef): Promise<void>;
  /** Provider-aware datasheet import (API or Claude Code). */
  importDatasheet(req: ImportRequest, onProgress: (p: ImportProgress) => void, signal: AbortSignal): Promise<ImportOutcome>;
  /** Cost estimate; `subscription` when the import runs on the user's Claude Code plan. */
  estimateImport(req: ImportRequest): Promise<{ costUsd: number; pages: number; subscription: boolean }>;
  /** Parts the active profile has on hand, as get_inventory reports them. */
  inventory(): Promise<{ summary: string } & Record<string, unknown>>;
}

/** A tool both back ends can expose: Claude API (tool runner) or Claude Code (MCP). */
export interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  run(input: any, id: string): Promise<string>;
}

const json = (v: unknown) => JSON.stringify(v);

/** Refuse loopback/private targets: the URL comes from model output. */
function checkPublicUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("only http(s) URLs can be downloaded");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const privateV4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/;
  if (host === "localhost" || host.endsWith(".local") || (isIP(host) === 4 && privateV4.test(host)) ||
    (isIP(host) === 6 && (/^(::1|fc|fd|fe80)/i.test(host)))) {
    throw new Error("refusing to download from a local or private address");
  }
  return url;
}

async function downloadPdf(rawUrl: string, dir: string, part: string, signal?: AbortSignal): Promise<string> {
  const url = checkPublicUrl(rawUrl);
  const res = await fetch(url, { signal, redirect: "follow", headers: { "User-Agent": "Daedalus datasheet fetcher" } });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  checkPublicUrl(res.url || url.href);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_PDF_BYTES) throw new Error(`PDF is ${(len / 1048576).toFixed(1)} MB; limit is 30 MB`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_PDF_BYTES) throw new Error("PDF exceeds 30 MB");
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new Error(`URL did not return a PDF (got ${res.headers.get("content-type") ?? "unknown content"}); find the direct .pdf link`);
  }
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${part.replace(/[^\w.-]+/g, "_")}-${Date.now()}.pdf`);
  await writeFile(file, buf);
  return file;
}

function summarizePart(def: ComponentDef) {
  return {
    id: def.id,
    name: def.name,
    model: def.model.kind + (def.model.mcu ? ` (${def.model.mcu.coreName}${def.model.mcu.core === "unsupported" ? ", wiring only" : ""})` : ""),
    pins: def.pins.map((p) => `${p.id}${p.port ? `=${p.port}` : ""}:${p.type}`).join(", "),
    properties: def.properties.map((p) => `${p.key}=${p.default}`),
  };
}

export class Assistant {
  private history: Anthropic.Beta.BetaMessageParam[] = [];
  private ccSession: string | null = null;
  private abort: AbortController | null = null;
  totalCostUsd = 0;

  constructor(private host: AssistantHost) {}

  reset(): void {
    this.cancel();
    this.history = [];
    this.ccSession = null;
  }

  cancel(): void {
    this.abort?.abort();
    this.abort = null;
  }

  get busy(): boolean {
    return this.abort !== null;
  }

  specs(signal: AbortSignal): ToolSpec[] {
    const host = this.host;
    const proxy = (name: string, description: string, schema: z.ZodObject<z.ZodRawShape>): ToolSpec => ({
      name,
      description,
      schema,
      run: async (input, id) => {
        host.emit({ type: "tool-start", id, name, input });
        try {
          const result = await host.exec(name, input);
          const r = result as { error?: string; summary?: string };
          host.emit({ type: "tool-end", id, ok: !r?.error, summary: r?.summary ?? r?.error ?? "" });
          return json(result);
        } catch (e) {
          host.emit({ type: "tool-end", id, ok: false, summary: (e as Error).message });
          return json({ error: (e as Error).message });
        }
      },
    });

    const importResult = async (path: string, part: string, pages: string | undefined, id: string) => {
      const outcome = await host.importDatasheet({ path, pages, hint: part }, (p) =>
        host.emit({ type: "status", message: `${part}: ${p.message}` }), signal);
      this.totalCostUsd += outcome.usage.costUsd;
      if (outcome.errors.length) {
        const summary = `import of ${part} failed validation`;
        host.emit({ type: "tool-end", id, ok: false, summary });
        return json({ error: summary, details: outcome.errors });
      }
      const def = outcome.result.component;
      await host.saveComponent(def);
      await host.exec("library_changed", {});
      host.emit({ type: "tool-end", id, ok: true, summary: `imported ${def.name} as ${def.id}` });
      return json({
        imported: summarizePart(def),
        fidelity: outcome.result.modelFidelity,
        notes: outcome.result.notes,
        warnings: outcome.warnings,
      });
    };

    return [
      {
        name: "get_inventory",
        description: "Parts the user already owns (their profile's inventory): name, library_id to place, value, package and quantity on hand. Check it before choosing parts and prefer these where they suit the design.",
        schema: z.object({}),
        run: async (_input, id) => {
          host.emit({ type: "tool-start", id, name: "get_inventory", input: {} });
          try {
            const inv = await host.inventory();
            host.emit({ type: "tool-end", id, ok: true, summary: inv.summary });
            return json(inv);
          } catch (e) {
            host.emit({ type: "tool-end", id, ok: false, summary: (e as Error).message });
            return json({ error: (e as Error).message });
          }
        },
      },
      proxy("search_library",
        "Search the component library (built-in and previously imported parts). Returns ids to use with place_part. Empty query lists everything.",
        z.object({ query: z.string() })),
      proxy("get_part",
        "Full pin list (ids, types, MCU port mapping), properties and model details for a library part.",
        z.object({ id: z.string() })),
      proxy("get_schematic",
        "Current schematic: parts with refs and properties, named nets with their pins, unconnected input pins, firmware sources.",
        z.object({})),
      proxy("place_part",
        "Place a library part on the schematic. Auto-positions it unless x/y are given (grid units of 10). Returns the ref and its pins.",
        z.object({
          def_id: z.string(),
          ref: z.string().optional().describe("Reference designator; omit to auto-number (U1, R2...)."),
          props: z.record(z.string(), z.string()).optional().describe("Property overrides, e.g. {\"R\": \"330\"}."),
          x: z.number().optional(),
          y: z.number().optional(),
          rotation: z.enum(["0", "90", "180", "270"]).optional(),
        })),
      proxy("connect",
        "Join pins into a named net. Draws a short stub and a net label on each pin (labels with equal names are connected). Net 'GND' draws ground symbols; give rail_voltage to make the net a supply rail.",
        z.object({
          net: z.string().describe("Net name, e.g. GND, VCC, LED1, LCD_RS."),
          pins: z.array(z.string()).describe("Pins as REF.PIN_ID, e.g. [\"U1.PB5\", \"R1.A\"]."),
          rail_voltage: z.number().optional().describe("Volts, for supply nets only."),
        })),
      proxy("disconnect",
        "Remove net connections from the given pins (their stubs and labels).",
        z.object({ pins: z.array(z.string()) })),
      proxy("remove_part", "Delete a part and the connections attached to it.", z.object({ ref: z.string() })),
      proxy("set_property", "Set a property on a placed part (e.g. R1 R=330, U1 CLOCK=8MHz).",
        z.object({ ref: z.string(), key: z.string(), value: z.string() })),
      proxy("write_firmware",
        "Store AVR assembly as a project source, assemble it, and set it as the MCU's program. Returns assembler errors with line numbers.",
        z.object({ mcu_ref: z.string(), filename: z.string().describe("e.g. main.asm"), source: z.string() })),
      proxy("define_emulated_part",
        "Create (or replace, by id) an EMULATED PART: a sensor or module simulated by a hidden backing microcontroller (an ATmega328P-compatible AVR core the user never sees) running emulator firmware you write. Use it for every sensor or smart module whose readings the user should control in simulation (rangefinders, temperature/humidity, gas, IMU, GPS, load cells, encoders...) and for modules with their own protocol (UART, I2C, SPI, 1-Wire, pulse-width, analog output). The part appears on the schematic as itself, with a SIM button that opens sliders for its readings. Never place a separate ATmega to stand in for a sensor.\nPINS: give each signal pin a `backing` resource: a backing-MCU port bit (PB0-PB7, PC0-PC6, PD0-PD7; USART is PD0=RXD/PD1=TXD; INT0/INT1 are PD2/PD3; pin-change interrupts on any bit; timer PWM on PD6/PD5/PB1/PB2/PB3/PD3) or DAC0-DAC3 for an analog output (millivolts, 50 ohm source). Leave power and ground pins without `backing`.\nCONTROLS: one per sensed quantity, in real units with a range and default; `scale` turns it into an integer for the firmware (metres with scale 1000 gives millimetres).\nFIRMWARE: AVR assembly, same assembler and ATmega328P register names as write_firmware, plus predefined symbols for reserved SRAM: CTRL_<KEY> = signed 32-bit little-endian round(value*scale) (lds r24, CTRL_DIST / lds r25, CTRL_DIST+1 ...), CTRL_CHANGED = byte that increments on every control change, DAC0..DAC3 = 16-bit little-endian millivolts. 0x100-0x14F is reserved: keep your variables at EMU_RAM (0x150) and above. Vector table at .org 0 with JMP entries; set up the stack. Emulate the real protocol from the datasheet (or from forum/library sources if there is no datasheet, stating the assumptions in notes): e.g. a UART module sets USART0 to its baud (clock_hz 18432000 gives exact standard rates, UBRR0 = 18432000/(16*baud) - 1), answers commands from RX and sends measurement frames on TX built from CTRL values; an I2C sensor bit-bangs a slave on two port bits; an analog sensor computes millivolts into a DAC in a loop. Returns assembler errors with line numbers; nothing is saved until it assembles and validates. Then place_part it and test with run_simulation actions {control:\"KEY\", value:n}.",
        z.object({
          id: z.string().describe("Library id, e.g. JC02_1. Reuse an id to replace your earlier version."),
          name: z.string().describe("e.g. 'JC02-1 laser rangefinder'"),
          description: z.string().describe("One line: what it is and its interface."),
          manufacturer: z.string().optional(),
          category: z.enum(["peripheral", "analog-ic", "semiconductor", "misc"]).optional().describe("Default peripheral."),
          ref_prefix: z.string().optional().describe("Default U."),
          pins: z.array(z.object({
            id: z.string().describe("Identifier, e.g. TXD, VOUT, VCC."),
            name: z.string().describe("Label on the symbol."),
            number: z.string().describe("Module/package pin number."),
            type: z.enum(["input", "output", "bidir", "opendrain", "analog", "power", "ground", "nc"]),
            side: z.enum(["left", "right", "top", "bottom"]),
            backing: z.string().optional().describe("Backing MCU resource: port bit like PD1, or DAC0-DAC3. Omit for power/ground."),
          })),
          controls: z.array(z.object({
            key: z.string().describe("Upper-case id, e.g. DIST."),
            label: z.string(),
            unit: z.string().optional(),
            min: z.number(),
            max: z.number(),
            step: z.number().optional(),
            default: z.number(),
            scale: z.number().optional(),
            kind: z.enum(["slider", "toggle"]).optional(),
          })),
          clock_hz: z.number().optional().describe("Backing MCU clock, default 16000000."),
          firmware: z.string().describe("Emulator firmware, AVR assembly."),
          notes: z.array(z.string()).optional().describe("Protocol assumptions and limitations, shown to the user."),
        })),
      proxy("run_simulation",
        "Simulate the current schematic headlessly and report indicators (LEDs, LCD text, terminal output, probes, meters, scopes), net values and warnings. Optional timed actions press buttons, toggle switches/logic states, move pots or type into terminals.",
        z.object({
          seconds: z.number().describe("Simulated time, at most 5."),
          actions: z.array(z.object({
            at: z.number().describe("Seconds from start."),
            ref: z.string(),
            action: z.record(z.string(), z.unknown()).describe("{pressed:true|false} for buttons, {} toggles switches/logic states, {position:0..1} pots, {send:\"text\\r\"} terminals, {control:\"KEY\", value:n} sets an emulated part's reading."),
          })).optional(),
          watch: z.array(z.string()).optional().describe("Net names to report min/max/edge counts for."),
        })),
      {
        name: "import_datasheet_from_url",
        description: "Download a datasheet PDF from a direct URL and import it as a library part (Claude reads it into a simulation model). The user must approve first. Returns the new part's id and pins.",
        schema: z.object({
          part_number: z.string(),
          url: z.string().describe("Direct link to the PDF."),
          pages: z.string().optional().describe("Page range like '1-12, 250-270' for very long datasheets."),
          reason: z.string().describe("One line: what this part does in the design."),
        }),
        run: async (input, id) => {
          host.emit({ type: "tool-start", id, name: "import_datasheet_from_url", input });
          try {
            const path = await downloadPdf(input.url, host.downloadsDir(), input.part_number, signal);
            let estimate: { costUsd: number; pages: number; subscription: boolean };
            try {
              estimate = await host.estimateImport({ path, pages: input.pages, hint: input.part_number });
            } catch (e) {
              // e.g. >600 pages without a range: surface to the model so it can pick pages
              host.emit({ type: "tool-end", id, ok: false, summary: (e as Error).message });
              return json({ error: (e as Error).message });
            }
            const approved = (await host.exec("approve_import", {
              part_number: input.part_number, url: input.url, reason: input.reason,
              pages: estimate.pages, cost_usd: estimate.costUsd, subscription: estimate.subscription,
            })) as { approved: boolean };
            if (!approved.approved) {
              host.emit({ type: "tool-end", id, ok: false, summary: "user declined the import" });
              return json({ error: "The user declined this import. Use a library part or ask how to proceed." });
            }
            return await importResult(path, input.part_number, input.pages, id);
          } catch (e) {
            host.emit({ type: "tool-end", id, ok: false, summary: (e as Error).message });
            return json({ error: (e as Error).message });
          }
        },
      },
      {
        name: "request_datasheet_file",
        description: "Ask the user to choose a datasheet PDF from their computer for a part (use when no downloadable PDF can be found). Imports it if they pick one.",
        schema: z.object({ part_number: z.string(), reason: z.string(), pages: z.string().optional() }),
        run: async (input, id) => {
          host.emit({ type: "tool-start", id, name: "request_datasheet_file", input });
          const r = (await host.exec("request_file", input)) as { path: string | null };
          if (!r.path) {
            host.emit({ type: "tool-end", id, ok: false, summary: "user skipped" });
            return json({ error: "The user did not provide a datasheet." });
          }
          try {
            return await importResult(r.path, input.part_number, input.pages, id);
          } catch (e) {
            host.emit({ type: "tool-end", id, ok: false, summary: (e as Error).message });
            return json({ error: (e as Error).message });
          }
        },
      },
    ];
  }

  /** Tools for a phase: the interview only gets read-only ones. */
  private phaseSpecs(phase: AssistantPhase, signal: AbortSignal): ToolSpec[] {
    const all = this.specs(signal);
    return phase === "interview" ? all.filter((s) => INTERVIEW_TOOLS.has(s.name)) : all;
  }

  async send(text: string, phase: AssistantPhase = "build"): Promise<void> {
    if (this.abort) throw new Error("assistant is busy");
    const abort = new AbortController();
    this.abort = abort;
    const tagged = `[${phase.toUpperCase()}] ${text}`;
    try {
      if ((await this.host.provider()) === "claude-code") await this.sendViaClaudeCode(tagged, phase, abort);
      else await this.sendViaApi(tagged, phase, abort);
    } finally {
      this.abort = null;
    }
  }

  private async sendViaApi(text: string, phase: AssistantPhase, abort: AbortController): Promise<void> {
    const host = this.host;
    let costUsd = 0;
    let stopReason: string | null = null;
    try {
      const key = await host.apiKey();
      const client = key ? new Anthropic({ apiKey: key }) : new Anthropic();
      // Streaming + client tools: let large inputs (firmware source) stream as
      // generated. The runner validates each input against its Zod schema
      // before run(), which covers the server no longer validating them.
      const tools = this.phaseSpecs(phase, abort.signal).map((spec) => ({
        ...betaZodTool({
          name: spec.name,
          description: spec.description,
          inputSchema: spec.schema,
          run: (input, ctx) => spec.run(input, ctx?.toolUse.id ?? `${spec.name}-${Date.now()}`),
        }),
        eager_input_streaming: true,
      }));
      const runner = client.beta.messages.toolRunner(
        {
          model: MODEL,
          max_tokens: 64000,
          stream: true,
          max_iterations: 60,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          cache_control: { type: "ephemeral" },
          system: [{ type: "text", text: ASSISTANT_SYSTEM_PROMPT }],
          thinking: { type: "adaptive" },
          output_config: { effort: "high" },
          tools: [
            { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 8 },
            { type: "web_fetch_20260209" as const, name: "web_fetch" as const, max_uses: 8 },
            ...tools,
          ],
          messages: [...this.history, { role: "user", content: text }],
        },
        { signal: abort.signal },
      );
      for await (const stream of runner) {
        stream.on("text", (delta) => host.emit({ type: "text", delta }));
        const msg = await stream.finalMessage();
        const u = msg.usage;
        costUsd += ((u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25) * PRICE_IN +
          (u.cache_read_input_tokens ?? 0) * PRICE_CACHE_READ + u.output_tokens * PRICE_OUT) / 1e6;
        for (const b of msg.content) {
          if (b.type === "server_tool_use") {
            const inp = b.input as { query?: string; url?: string };
            host.emit({ type: "web", kind: b.name === "web_fetch" ? "fetch" : "search", detail: inp.query ?? inp.url ?? "" });
          }
        }
        stopReason = msg.stop_reason;
        if (msg.stop_reason === "pause_turn") runner.pushMessages({ role: "assistant", content: msg.content });
        if (msg.stop_reason === "refusal") {
          host.emit({ type: "error", message: "Claude declined to continue this request." });
          break;
        }
      }
      this.history = [...runner.params.messages];
      this.totalCostUsd += costUsd;
      host.emit({ type: "done", costUsd, stopReason });
    } catch (e) {
      if (abort.signal.aborted) host.emit({ type: "done", costUsd, stopReason: "cancelled" });
      else if (e instanceof Anthropic.AuthenticationError) host.emit({ type: "error", message: "No valid API key. Add one in Settings, set ANTHROPIC_API_KEY, or switch the provider to Claude Code." });
      else if (e instanceof Anthropic.RateLimitError) host.emit({ type: "error", message: "Rate limited by the API; try again shortly." });
      else if (e instanceof Anthropic.APIError) host.emit({ type: "error", message: `API error ${e.status}: ${e.message}` });
      else host.emit({ type: "error", message: (e as Error).message });
    }
  }

  /**
   * Same agent, run by the user's local Claude Code: schematic tools are served
   * over a localhost MCP server, web access uses Claude Code's own
   * WebSearch/WebFetch, and every other built-in tool is switched off.
   */
  private async sendViaClaudeCode(text: string, phase: AssistantPhase, abort: AbortController): Promise<void> {
    const host = this.host;
    const { exe, workDir } = host.claudeCode();
    const server = await startToolServer("daedalus", this.phaseSpecs(phase, abort.signal));
    try {
      await mkdir(workDir, { recursive: true });
      const promptFile = join(workDir, "assistant-system.md");
      await writeFile(promptFile, ASSISTANT_SYSTEM_PROMPT);
      const mcpConfig = JSON.stringify({
        mcpServers: { daedalus: { type: "http", url: server.url, headers: { Authorization: `Bearer ${server.token}` } } },
      });
      const args = [
        "--model", "opus",
        "--system-prompt-file", promptFile,
        "--mcp-config", mcpConfig,
        "--tools", "WebSearch,WebFetch",
        "--allowedTools", "mcp__daedalus", "WebSearch", "WebFetch",
        "--permission-mode", "dontAsk",
        "--include-partial-messages",
        ...(this.ccSession ? ["--resume", this.ccSession] : []),
      ];
      const result = await runClaudeCode(text, args, {
        cwd: workDir,
        exe,
        signal: abort.signal,
        onEvent: (ev) => {
          if (ev.type === "system" && ev.subtype === "init") this.ccSession = String(ev.session_id);
          if (ev.type === "stream_event") {
            const e = ev.event as { type?: string; delta?: { type?: string; text?: string } };
            if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) host.emit({ type: "text", delta: e.delta.text });
          }
          if (ev.type === "assistant") {
            const content = (ev.message as { content?: { type: string; name?: string; input?: { query?: string; url?: string } }[] })?.content ?? [];
            for (const b of content) {
              if (b.type === "tool_use" && (b.name === "WebSearch" || b.name === "WebFetch")) {
                host.emit({ type: "web", kind: b.name === "WebFetch" ? "fetch" : "search", detail: b.input?.query ?? b.input?.url ?? "" });
              }
            }
          }
        },
      });
      this.ccSession = result.session_id;
      if (result.is_error) host.emit({ type: "error", message: `Claude Code: ${result.result ?? result.subtype}` });
      const cost = result.total_cost_usd ?? 0;
      this.totalCostUsd += cost;
      host.emit({ type: "done", costUsd: cost, stopReason: result.stop_reason ?? result.subtype, subscription: true });
    } catch (e) {
      if (abort.signal.aborted) host.emit({ type: "done", costUsd: 0, stopReason: "cancelled", subscription: true });
      else host.emit({ type: "error", message: (e as Error).message });
    } finally {
      await server.close();
    }
  }
}
