import { useEffect, useRef, useState } from "react";
import type { AssistantEvent } from "../../../main/assistant";
import type { AssistantPhase } from "../../../main/assistant-prompt";
import { api } from "../api";
import type { ApprovalRequest } from "./executor";

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; id: string; name: string; status: "running" | "ok" | "error"; summary: string }
  | { kind: "web"; text: string }
  | { kind: "status"; text: string }
  | { kind: "approval"; key: string; req: ApprovalRequest; state: "pending" | "approved" | "declined" }
  | { kind: "file"; key: string; part: string; reason: string; state: "pending" | "picked" | "skipped" }
  | { kind: "error"; text: string }
  | { kind: "done"; cost: number; subscription?: boolean };

const TOOL_LABEL: Record<string, string> = {
  get_inventory: "Checked inventory",
  search_library: "Searched library",
  get_part: "Read part",
  get_schematic: "Read schematic",
  place_part: "Placed",
  connect: "Connected",
  disconnect: "Disconnected",
  remove_part: "Removed",
  set_property: "Set",
  write_firmware: "Firmware",
  run_simulation: "Simulated",
  import_datasheet_from_url: "Datasheet import",
  request_datasheet_file: "Datasheet from file",
};

export function applyEvent(items: ChatItem[], ev: AssistantEvent): ChatItem[] {
  const last = items[items.length - 1];
  switch (ev.type) {
    case "text":
      if (last?.kind === "assistant") return [...items.slice(0, -1), { ...last, text: last.text + ev.delta }];
      return [...items, { kind: "assistant", text: ev.delta }];
    case "tool-start":
      return [...items, { kind: "tool", id: ev.id, name: ev.name, status: "running", summary: "" }];
    case "tool-end":
      return items.map((it) => (it.kind === "tool" && it.id === ev.id ? { ...it, status: ev.ok ? "ok" : "error", summary: ev.summary } : it));
    case "web":
      return [...items, { kind: "web", text: `${ev.kind === "search" ? "Web search" : "Fetched"}: ${ev.detail}` }];
    case "status":
      if (last?.kind === "status") return [...items.slice(0, -1), { kind: "status", text: ev.message }];
      return [...items, { kind: "status", text: ev.message }];
    case "error":
      return [...items, { kind: "error", text: ev.message }];
    case "done":
      return [...items.filter((it) => it.kind !== "status"), { kind: "done", cost: ev.costUsd, subscription: ev.subscription }];
  }
}

interface Props {
  items: ChatItem[];
  busy: boolean;
  phase: AssistantPhase;
  onSend: (text: string) => void;
  onBuild: () => void;
  onCancel: () => void;
  onReset: () => void;
  onApproval: (key: string, approved: boolean) => void;
  onFile: (key: string, pick: boolean) => void;
}

const STARTERS = [
  "A reaction-time game: an LED lights after a random delay, I press a button, and the time shows on a 16x2 LCD.",
  "Read a potentiometer and show its voltage on a 4-digit 7-segment display.",
  "A thermostat: read an LM35 temperature sensor and switch a relay with hysteresis.",
];

/** Answer options ("- ..." bullets) offered by the assistant's latest question. */
function answerOptions(items: ChatItem[]): string[] {
  const last = items[items.length - 1];
  if (last?.kind !== "assistant" && last?.kind !== "done") return [];
  const msg = [...items].reverse().find((it) => it.kind === "assistant");
  if (msg?.kind !== "assistant" || !/\*\*Q\d+\./.test(msg.text) || /spec complete/i.test(msg.text)) return [];
  const tail = msg.text.slice(msg.text.lastIndexOf("**Q"));
  return [...tail.matchAll(/^\s*[-*]\s+(.+)$/gm)].map((m) => m[1].replace(/\*\*/g, "").trim());
}

export function AssistantPanel(p: Props) {
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [p.items]);
  const interviewing = p.phase === "interview";
  const options = interviewing && !p.busy ? answerOptions(p.items) : [];
  const specDone = interviewing && p.items.some((it) => it.kind === "assistant" && /spec complete/i.test(it.text));
  const started = p.items.some((it) => it.kind === "assistant");
  const send = () => {
    const t = text.trim();
    if (!t || p.busy) return;
    p.onSend(t);
    setText("");
  };
  return (
    <div className="chat">
      {/* aria-busy holds back announcements while a reply streams in, then reads it once. */}
      <div className="chat-log" role="log" aria-label="Conversation with the AI assistant" aria-live="polite" aria-busy={p.busy} tabIndex={0}>
        {p.items.length === 0 && (
          <div className="chat-empty">
            <p>Describe what you want to build. The assistant interviews you one question at a time until the design is fully specified. Press <b>Build</b> when you're ready: it then imports missing datasheets (with your approval), wires the schematic, writes firmware and simulates it to check.</p>
            <div role="group" aria-label="Example projects">
              {STARTERS.map((s) => <button key={s} className="chip" onClick={() => setText(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {p.items.map((it, i) => <Item key={i} it={it} onApproval={p.onApproval} onFile={p.onFile} />)}
        {options.length > 0 && (
          <div className="chat-options" role="group" aria-label="Suggested answers">
            {options.map((o) => (
              <button key={o} className="chip" onClick={() => p.onSend(o.replace(/\s*\(recommended\)/i, ""))}>{o}</button>
            ))}
          </div>
        )}
        {p.busy && <div className="chat-busy" aria-hidden>working…</div>}
        <div ref={end} />
      </div>
      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <div className="sr-only" role="status">{p.busy ? "Assistant is working" : ""}</div>
        <textarea
          value={text}
          aria-label="Message to the assistant"
          aria-describedby="chat-enter-hint"
          placeholder={p.busy ? "Assistant is working…" : !started ? "Describe your project…"
            : interviewing ? "Answer the question above…" : "Ask for a change…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          rows={3}
        />
        <span id="chat-enter-hint" className="sr-only">Enter sends; Shift+Enter starts a new line.</span>
        <div className="chat-actions">
          <button type="button" className="btn" onClick={p.onReset} disabled={p.busy} title="Start a new conversation">New chat</button>
          <span className="chat-phase">{interviewing ? (specDone ? "Spec complete" : "Interview") : "Build mode"}</span>
          <div className="spacer" />
          {interviewing && (
            <button type="button" className={`btn${specDone ? " primary ready" : ""}`} onClick={p.onBuild}
              disabled={p.busy || !started} title="Build the circuit from the answers so far">Build</button>
          )}
          {p.busy
            ? <button type="button" className="btn danger" onClick={p.onCancel}>Stop</button>
            : <button type="submit" className="btn primary" disabled={!text.trim()}>Send</button>}
        </div>
      </form>
    </div>
  );
}

function Item({ it, onApproval, onFile }: { it: ChatItem; onApproval: Props["onApproval"]; onFile: Props["onFile"] }) {
  switch (it.kind) {
    case "user": return <div className="msg user"><span className="sr-only">You: </span>{it.text}</div>;
    case "assistant": return <div className="msg bot"><span className="sr-only">Assistant: </span><Markdown text={it.text} /></div>;
    case "tool":
      return (
        <div className={`act ${it.status}`}>
          <span className="dot" aria-hidden />{it.status === "error" && <span className="sr-only">Failed: </span>}{TOOL_LABEL[it.name] ?? it.name}{it.summary ? `: ${it.summary}` : it.status === "running" ? "…" : ""}
        </div>
      );
    case "web": return <div className="act web"><span className="dot" aria-hidden />{it.text}</div>;
    case "status": return <div className="act running"><span className="dot" aria-hidden />{it.text}</div>;
    case "error": return <div className="msg err" role="alert"><span className="sr-only">Error: </span>{it.text}</div>;
    case "done":
      return <div className="act done">{it.subscription ? `Claude Code plan · API-equivalent ≈ $${it.cost.toFixed(3)}` : `turn cost ≈ $${it.cost.toFixed(3)}`}</div>;
    case "approval":
      return (
        <div className="card" role="group" aria-label={`Import datasheet for ${it.req.part_number}`}>
          <b>Import datasheet: {it.req.part_number}</b>
          <div className="desc">{it.req.reason}</div>
          <div className="desc mono">{it.req.url}</div>
          <div className="desc">{it.req.pages} pages · {it.req.subscription ? "runs on your Claude Code plan" : `estimated ≈ $${it.req.cost_usd.toFixed(2)}`}</div>
          {it.state === "pending" ? (
            <div className="actions">
              <button className="btn" onClick={() => onApproval(it.key, false)}>Decline</button>
              <button className="btn primary" onClick={() => onApproval(it.key, true)}>Import</button>
            </div>
          ) : <div className={it.state === "approved" ? "desc" : "msg-warn"}>{it.state}</div>}
        </div>
      );
    case "file":
      return (
        <div className="card" role="group" aria-label={`Datasheet needed for ${it.part}`}>
          <b>Datasheet needed: {it.part}</b>
          <div className="desc">{it.reason}</div>
          {it.state === "pending" ? (
            <div className="actions">
              <button className="btn" onClick={() => onFile(it.key, false)}>Skip</button>
              <button className="btn primary" onClick={() => onFile(it.key, true)}>Choose PDF…</button>
            </div>
          ) : <div className="desc">{it.state}</div>}
        </div>
      );
  }
}

/** Minimal markdown: paragraphs, bullet lists, **bold**, `code`, fenced code. */
function Markdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.split("\n");
  let list: string[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={`l${blocks.length}`}>{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>);
    list = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("```")) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      blocks.push(<pre key={`c${blocks.length}`} className="code">{code.join("\n")}</pre>);
      continue;
    }
    const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(l);
    if (li) { list.push(li[1]); continue; }
    flush();
    if (l.trim()) {
      const h = /^#{1,4}\s+(.*)$/.exec(l);
      blocks.push(h ? <p key={`p${blocks.length}`}><b>{inline(h[1])}</b></p> : <p key={`p${blocks.length}`}>{inline(l)}</p>);
    }
  }
  flush();
  return <>{blocks}</>;
}

function inline(s: string): React.ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <b key={i}>{part.slice(2, -2)}</b>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    return part;
  });
}

export async function pickDatasheetPath(): Promise<string | null> {
  const info = await api().pickDatasheet();
  return info?.path ?? null;
}
