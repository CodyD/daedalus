// Runs the locally installed Claude Code CLI in headless (-p) mode, using the
// user's own Claude Code login instead of an API key.

import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeCodeResult {
  type: "result";
  subtype: string;
  is_error: boolean;
  result?: string;
  structured_output?: unknown;
  session_id: string;
  total_cost_usd?: number;
  num_turns?: number;
  stop_reason?: string;
}

/** One line of `--output-format stream-json` output. */
export type StreamEvent = { type: string; [k: string]: unknown };

let cachedPath: string | null | undefined;

/** Locate the `claude` executable (GUI-launched apps may not inherit the shell PATH). */
export function findClaudeCode(override?: string): string | null {
  if (override && existsSync(override)) return override;
  if (cachedPath !== undefined) return cachedPath;
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const candidates = [
    join(homedir(), ".local", "bin", exe),
    join(homedir(), ".claude", "local", exe),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];
  cachedPath = candidates.find((c) => existsSync(c)) ?? null;
  if (!cachedPath) {
    try {
      const out = execFileSync(process.platform === "win32" ? "where" : "which", ["claude"], { encoding: "utf8" });
      cachedPath = out.split(/\r?\n/).find((l) => l.trim() && existsSync(l.trim()))?.trim() ?? null;
    } catch {
      cachedPath = null;
    }
  }
  return cachedPath;
}

export function claudeCodeVersion(path: string): string | null {
  try {
    return execFileSync(path, ["--version"], { encoding: "utf8", timeout: 15000 }).trim();
  } catch {
    return null;
  }
}

export interface RunOptions {
  cwd: string;
  /** Called for every stream-json event (system/init, assistant, stream_event, result...). */
  onEvent?: (ev: StreamEvent) => void;
  signal?: AbortSignal;
  exe?: string;
}

/**
 * Spawn `claude -p <prompt> --output-format stream-json ...` and resolve with
 * the final result event. Arguments are passed without a shell.
 */
export function runClaudeCode(prompt: string, args: string[], opts: RunOptions): Promise<ClaudeCodeResult> {
  const exe = findClaudeCode(opts.exe);
  if (!exe) {
    return Promise.reject(new Error("Claude Code (the `claude` CLI) was not found. Install it, or switch the AI provider to the Claude API in Settings."));
  }
  const full = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    // The user's hooks, CLAUDE.md and settings are for their coding sessions, not this app.
    "--setting-sources", "",
    "--strict-mcp-config",
    ...args,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(exe, full, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let buf = "";
    let stderr = "";
    let result: ClaudeCodeResult | null = null;
    const onAbort = () => child.kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: StreamEvent;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "result") result = ev as unknown as ClaudeCodeResult;
        opts.onEvent?.(ev);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => { stderr = (stderr + c).slice(-4000); });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.signal?.aborted) return reject(new Error("cancelled"));
      if (result) return resolve(result);
      reject(new Error(`Claude Code exited with code ${code}${stderr ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`));
    });
  });
}
