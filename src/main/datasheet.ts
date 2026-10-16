// Datasheet -> component import, powered by Claude.
//
// 1. Load the PDF (optionally only a page range: MCU datasheets often exceed
//    the 600-page request limit, and the pinout + register summary + DC
//    characteristics are all the model needs).
// 2. Ask Claude for a ComponentDef as structured output, streaming its
//    reasoning summary to the UI as progress.
// 3. Compile the result with the simulator's own validator; send any errors
//    back for a repair turn (append-only conversation, at most 2 repairs).

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import { ComponentDef } from "../shared/component";
import { validateComponent } from "../sim/validate";
import { IMPORT_SYSTEM_PROMPT } from "./import-prompt";

export const MODEL = "claude-opus-5-5";
const MAX_PAGES = 600;
const MAX_BYTES = 30 * 1024 * 1024;
const MAX_REPAIRS = 2;
// Claude Opus 5.5 list price, USD per million tokens.
const PRICE_IN = 4;
const PRICE_OUT = 20;

export const ImportResult = z.object({
  component: ComponentDef,
  notes: z.array(z.string()),
  modelFidelity: z.enum(["full", "partial", "pins-only"]),
  sourcePages: z.array(z.string()),
});
export type ImportResult = z.infer<typeof ImportResult>;

export interface ImportRequest {
  path: string;
  /** "1-12, 300-320" (1-based, inclusive). Empty = whole document. */
  pages?: string;
  /** Which part to import when the datasheet covers a family, plus any hints. */
  hint?: string;
}

export interface ImportProgress {
  phase: "reading" | "thinking" | "writing" | "validating" | "repairing" | "done" | "error";
  message: string;
  outputTokens?: number;
}

export interface ImportOutcome {
  result: ImportResult;
  warnings: string[];
  errors: string[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number };
}

export interface PdfInfo {
  path: string;
  name: string;
  pages: number;
  bytes: number;
}

export async function inspectPdf(path: string): Promise<PdfInfo> {
  const buf = await readFile(path);
  const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
  return { path, name: basename(path), pages: doc.getPageCount(), bytes: buf.length };
}

export function parsePageRange(spec: string, total: number): number[] {
  const out = new Set<number>();
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(part);
    if (!m) throw new Error(`bad page range '${part}'`);
    const a = +m[1];
    const b = m[2] ? +m[2] : a;
    if (a < 1 || b > total || a > b) throw new Error(`page range ${part} is outside 1-${total}`);
    for (let p = a; p <= b; p++) out.add(p - 1);
  }
  return [...out].sort((x, y) => x - y);
}

/** Load the PDF, cut it to the requested pages, return base64 for the API. */
export async function loadPdf(req: ImportRequest): Promise<{ data: string; pages: number; bytes: Uint8Array }> {
  const buf = await readFile(req.path);
  const src = await PDFDocument.load(buf, { ignoreEncryption: true });
  const total = src.getPageCount();
  let bytes: Uint8Array = buf;
  let pages = total;
  if (req.pages?.trim()) {
    const idx = parsePageRange(req.pages, total);
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, idx);
    copied.forEach((p) => out.addPage(p));
    bytes = await out.save();
    pages = idx.length;
  }
  if (pages > MAX_PAGES) {
    throw new Error(`The datasheet has ${pages} pages; Claude reads at most ${MAX_PAGES} per request. ` +
      "Enter a page range covering the pinout, register summary and electrical characteristics.");
  }
  if (bytes.length > MAX_BYTES) {
    throw new Error(`The PDF is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is 30 MB. Enter a page range to send fewer pages.`);
  }
  return { data: Buffer.from(bytes).toString("base64"), pages, bytes };
}

function firstMessage(pdf: string, req: ImportRequest): Anthropic.Beta.BetaMessageParam {
  const hint = req.hint?.trim();
  return {
    role: "user",
    content: [
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: pdf },
        title: basename(req.path),
        // Repair turns re-send the PDF; cache it so they read it at 5% cost.
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: hint
          ? `Import this part as a simulator component. User's instructions: ${hint}`
          : "Import the primary part described by this datasheet as a simulator component.",
      },
    ],
  };
}

function makeClient(apiKey?: string): Anthropic {
  // Without an explicit key the SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN
  // or an `ant auth login` profile.
  return apiKey ? new Anthropic({ apiKey }) : new Anthropic();
}

const SYSTEM: Anthropic.Beta.BetaTextBlockParam[] = [
  { type: "text", text: IMPORT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
];

export async function estimateImport(req: ImportRequest, apiKey?: string): Promise<{ inputTokens: number; costUsd: number; pages: number }> {
  const { data, pages } = await loadPdf(req);
  const client = makeClient(apiKey);
  const count = await client.messages.countTokens({
    model: MODEL,
    system: IMPORT_SYSTEM_PROMPT,
    messages: [firstMessage(data, req) as Anthropic.MessageParam],
  });
  // Output is typically 4-15k tokens including reasoning.
  const costUsd = (count.input_tokens * PRICE_IN + 12_000 * PRICE_OUT) / 1e6;
  return { inputTokens: count.input_tokens, costUsd, pages };
}

export async function importDatasheet(
  req: ImportRequest,
  onProgress: (p: ImportProgress) => void,
  opts: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<ImportOutcome> {
  onProgress({ phase: "reading", message: "Loading PDF" });
  const { data } = await loadPdf(req);
  const client = makeClient(opts.apiKey);
  const messages: Anthropic.Beta.BetaMessageParam[] = [firstMessage(data, req)];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };

  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    onProgress({ phase: attempt ? "repairing" : "thinking", message: attempt ? `Repair round ${attempt}` : "Claude is reading the datasheet" });
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 64000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: SYSTEM,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high", format: betaZodOutputFormat(ImportResult) },
        messages,
      },
      { signal: opts.signal },
    );
    let thinking = "";
    let written = 0;
    stream.on("thinking", (delta) => {
      thinking += delta;
      const line = thinking.trim().split("\n").filter(Boolean).pop() ?? "";
      onProgress({ phase: "thinking", message: line.slice(0, 200) });
    });
    stream.on("text", (delta) => {
      written += delta.length;
      if (written % 400 < delta.length) onProgress({ phase: "writing", message: `Writing component definition (${written} chars)` });
    });
    const msg = await stream.finalMessage();
    usage.inputTokens += msg.usage.input_tokens + (msg.usage.cache_creation_input_tokens ?? 0);
    usage.cacheReadTokens += msg.usage.cache_read_input_tokens ?? 0;
    usage.outputTokens += msg.usage.output_tokens;
    usage.costUsd = (usage.inputTokens * PRICE_IN + usage.cacheReadTokens * PRICE_IN * 0.05 + usage.outputTokens * PRICE_OUT) / 1e6;

    if (msg.stop_reason === "refusal") {
      throw new Error(`Claude declined this request${msg.stop_details?.explanation ? `: ${msg.stop_details.explanation}` : ""}.`);
    }
    if (msg.stop_reason === "max_tokens") throw new Error("The response hit the output limit before the definition was complete.");
    const parsed = msg.parsed_output;
    if (!parsed) throw new Error("Claude's response did not match the component schema.");

    onProgress({ phase: "validating", message: "Compiling the model in the simulator" });
    const component: ComponentDef = {
      ...parsed.component,
      source: { kind: "datasheet", file: basename(req.path), path: req.path, importedAt: new Date().toISOString(), notes: parsed.notes },
    };
    const { errors, warnings } = validateComponent(component);
    if (!errors.length || attempt === MAX_REPAIRS) {
      onProgress({ phase: "done", message: errors.length ? "Imported with errors" : "Import complete" });
      return { result: { ...parsed, component }, warnings, errors, usage };
    }
    // Append-only repair turn: keep Claude's full response, then report the errors.
    messages.push({ role: "assistant", content: msg.content });
    messages.push({
      role: "user",
      content: `The simulator rejected this definition:\n${errors.map((e) => `- ${e}`).join("\n")}\n\nReturn the complete corrected definition.`,
    });
  }
  throw new Error("unreachable");
}
