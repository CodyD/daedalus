// Datasheet import through the local Claude Code CLI (the user's own login).
//
// Same contract as the API path: Claude reads the PDF (with Claude Code's Read
// tool, which handles PDFs page by page), returns the component as schema-
// validated structured output (--json-schema), and the simulator's validator
// errors go back for repair rounds in the same session (--resume).

import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { ComponentDef } from "../shared/component";
import { validateComponent } from "../sim/validate";
import { runClaudeCode } from "./claude-code";
import { ImportOutcome, ImportProgress, ImportRequest, ImportResult, loadPdf } from "./datasheet";
import { IMPORT_SYSTEM_PROMPT } from "./import-prompt";

const MAX_REPAIRS = 2;

export async function importDatasheetViaClaudeCode(
  req: ImportRequest,
  onProgress: (p: ImportProgress) => void,
  opts: { workDir: string; exe?: string; signal?: AbortSignal },
): Promise<ImportOutcome> {
  onProgress({ phase: "reading", message: "Loading PDF" });
  const { bytes, pages } = await loadPdf(req);
  const dir = join(opts.workDir, `import-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, "datasheet.pdf"), bytes);
    await writeFile(join(dir, "system.md"), IMPORT_SYSTEM_PROMPT);
    // Claude Code's validator doesn't load the draft-2020 meta-schema; drop the $schema tag.
    const { $schema: _meta, ...jsonSchema } = z.toJSONSchema(ImportResult, { target: "draft-7" }) as Record<string, unknown>;
    const schema = JSON.stringify(jsonSchema);
    const baseArgs = [
      "--model", "opus",
      "--system-prompt-file", join(dir, "system.md"),
      "--tools", "Read",
      "--allowedTools", "Read",
      "--permission-mode", "dontAsk",
      "--json-schema", schema,
    ];
    const hint = req.hint?.trim();
    let prompt =
      `The datasheet is ./datasheet.pdf (${pages} pages${req.pages ? `, pages ${req.pages} of ${basename(req.path)}` : `, ${basename(req.path)}`}). ` +
      "Read it with the Read tool, at most 20 pages per call using the pages parameter; start with the pinout, " +
      "then the electrical characteristics and (for MCUs) the register summary and interrupt vectors. " +
      (hint ? `Import this part as a simulator component. User's instructions: ${hint}` : "Import the primary part it describes as a simulator component.");
    let session: string | null = null;
    let costUsd = 0;

    for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
      onProgress({ phase: attempt ? "repairing" : "thinking", message: attempt ? `Repair round ${attempt}` : "Claude Code is reading the datasheet" });
      const result = await runClaudeCode(prompt, session ? [...baseArgs, "--resume", session] : baseArgs, {
        cwd: dir,
        exe: opts.exe,
        signal: opts.signal,
        onEvent: (ev) => {
          if (ev.type !== "assistant") return;
          const content = (ev.message as { content?: { type: string; text?: string; name?: string; input?: { pages?: string } }[] })?.content ?? [];
          for (const b of content) {
            if (b.type === "tool_use" && b.name === "Read") onProgress({ phase: "thinking", message: `Reading pages ${b.input?.pages ?? "1-…"}` });
            if (b.type === "text" && b.text?.trim()) onProgress({ phase: "writing", message: b.text.trim().split("\n").pop()!.slice(0, 200) });
          }
        },
      });
      session = result.session_id;
      costUsd += result.total_cost_usd ?? 0;
      if (result.is_error) throw new Error(`Claude Code reported an error: ${result.result ?? result.subtype}`);
      const parsed = ImportResult.safeParse(result.structured_output);
      if (!parsed.success) {
        if (attempt === MAX_REPAIRS) throw new Error("Claude Code's answer did not match the component schema.");
        prompt = `Your output did not match the schema: ${parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Return the complete corrected result.`;
        continue;
      }
      onProgress({ phase: "validating", message: "Compiling the model in the simulator" });
      const component: ComponentDef = {
        ...parsed.data.component,
        source: { kind: "datasheet", file: basename(req.path), path: req.path, importedAt: new Date().toISOString(), notes: parsed.data.notes },
      };
      const { errors, warnings } = validateComponent(component);
      if (!errors.length || attempt === MAX_REPAIRS) {
        onProgress({ phase: "done", message: errors.length ? "Imported with errors" : "Import complete" });
        return {
          result: { ...parsed.data, component },
          warnings,
          errors,
          // Claude Code reports an API-equivalent cost; on a subscription plan it's covered by the plan.
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd },
        };
      }
      prompt = `The simulator rejected this definition:\n${errors.map((e) => `- ${e}`).join("\n")}\n\nReturn the complete corrected definition.`;
    }
    throw new Error("unreachable");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
