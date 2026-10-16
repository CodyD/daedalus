import { useEffect, useId, useRef, useState } from "react";
import type { ComponentDef } from "../../shared/component";
import { validateComponent } from "../../sim/validate";
import type { ImportOutcome, PdfInfo } from "../../main/datasheet";
import { api } from "./api";
import { Dialog } from "./Dialog";

type Step = "pick" | "estimate" | "running" | "review";

interface Props {
  existingIds: Set<string>;
  onClose: () => void;
  onSaved: (def: ComponentDef, place: boolean) => void;
}

export function ImportDialog({ existingIds, onClose, onSaved }: Props) {
  const [step, setStep] = useState<Step>("pick");
  const [pdf, setPdf] = useState<PdfInfo | null>(null);
  const [pages, setPages] = useState("");
  const [hint, setHint] = useState("");
  const [estimate, setEstimate] = useState<{ inputTokens: number; costUsd: number; pages: number; subscription: boolean } | null>(null);
  const [progress, setProgress] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [json, setJson] = useState("");
  const [check, setCheck] = useState<{ errors: string[]; warnings: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const uid = useId();

  useEffect(() => api().onImportProgress((p) => {
    setProgress((prev) => {
      const line = `[${p.phase}] ${p.message}`;
      // Collapse consecutive updates of the same phase into one live line.
      if (prev.length && prev[prev.length - 1].startsWith(`[${p.phase}]`)) return [...prev.slice(0, -1), line];
      return [...prev, line];
    });
  }), []);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [progress]);

  // Each step replaces the controls that had focus; move it to the new step's first control.
  useEffect(() => {
    document.querySelector<HTMLElement>(".dialog [data-autofocus]")?.focus();
  }, [step]);

  const req = () => ({ path: pdf!.path, pages, hint });

  const pick = async () => {
    setError(null);
    const info = await api().pickDatasheet();
    if (!info) return;
    setPdf(info);
    setStep("estimate");
    setEstimate(null);
  };

  const doEstimate = async () => {
    setBusy(true);
    setError(null);
    try {
      setEstimate(await api().estimateImport(req()));
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    setStep("running");
    setProgress([]);
    setError(null);
    try {
      const out = await api().importDatasheet(req());
      setOutcome(out);
      setJson(JSON.stringify(out.result.component, null, 2));
      setCheck({ errors: out.errors, warnings: out.warnings });
      setStep("review");
    } catch (e) {
      setError(cleanErr(e));
      setStep("estimate");
    }
  };

  const current = (): ComponentDef | null => {
    try {
      return JSON.parse(json) as ComponentDef;
    } catch {
      return null;
    }
  };

  const revalidate = () => {
    const def = current();
    setCheck(def ? validateComponent(def) : { errors: ["definition is not valid JSON"], warnings: [] });
  };

  const save = async (place: boolean) => {
    const def = current();
    if (!def) return;
    const v = validateComponent(def);
    setCheck(v);
    if (v.errors.length) return;
    await api().savePart(def);
    onSaved(def, place);
  };

  const comp = outcome?.result.component;
  const tooMany = pdf && pdf.pages > 600 && !pages.trim();

  return (
    <Dialog title="Import part from datasheet" onClose={onClose} closable={step !== "running"}>
        <p className="sub">Claude reads the PDF, extracts the pinout and electrical characteristics, and writes a simulation model (SPICE, behavioural logic, or an AVR register map). The simulator compiles it before it reaches your library.</p>

        {step === "pick" && (
          <div className="actions" style={{ justifyContent: "flex-start" }}>
            <button className="btn primary" onClick={pick} data-autofocus>Choose PDF…</button>
          </div>
        )}

        {pdf && step !== "pick" && (
          <div className="kv" role="group" aria-label="Selected PDF">
            <span>file</span><span>{pdf.name}</span>
            <span>pages</span><span>{pdf.pages}</span>
            <span>size</span><span>{(pdf.bytes / 1048576).toFixed(1)} MB</span>
          </div>
        )}

        {step === "estimate" && pdf && (
          <>
            <div className="field">
              <label htmlFor={`${uid}-hint`}>Part / instructions (optional)</label>
              <input id={`${uid}-hint`} data-autofocus value={hint} onChange={(e) => setHint(e.target.value)} placeholder="e.g. 74HC165 in DIP-16; or ATtiny85 PDIP-8" />
            </div>
            <div className="field">
              <label htmlFor={`${uid}-pages`}>Pages to send {pdf.pages > 600 ? <span className="msg-warn">(required: Claude reads at most 600 pages)</span> : "(optional)"}</label>
              <input id={`${uid}-pages`} aria-required={pdf.pages > 600} aria-invalid={!!tooMany} value={pages} onChange={(e) => setPages(e.target.value)} placeholder="e.g. 1-15, 280-300 (pinout, register summary, DC characteristics)" />
            </div>
            {estimate && (
              <div className="desc" role="status">
                {estimate.subscription
                  ? `${estimate.pages} pages · runs on your Claude Code plan`
                  : `${estimate.pages} pages ≈ ${estimate.inputTokens.toLocaleString()} input tokens · estimated cost ≈ $${estimate.costUsd.toFixed(2)} (Claude Opus 5.5)`}
              </div>
            )}
            {error && <div className="msg-err" role="alert">{error}</div>}
            <div className="actions">
              <button className="btn" onClick={pick}>Different PDF…</button>
              <button className="btn" onClick={doEstimate} disabled={busy || !!tooMany}>{busy ? "Checking…" : "Estimate cost"}</button>
              <button className="btn primary" onClick={run} disabled={!!tooMany}>Import with Claude</button>
            </div>
          </>
        )}

        {(step === "running" || step === "review") && (
          <div className="progress" ref={logRef} role="log" aria-live="polite" aria-label="Import progress" tabIndex={0}>{progress.join("\n") || "Starting…"}</div>
        )}
        {step === "running" && (
          <div className="actions"><button className="btn" data-autofocus onClick={() => api().cancelImport()}>Cancel</button></div>
        )}

        {step === "review" && comp && outcome && (
          <>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }} role="status" tabIndex={-1} data-autofocus>
              <b style={{ fontSize: 16 }}>{comp.name}</b>
              <span className={`pill ${outcome.result.modelFidelity}`}><span className="sr-only">model fidelity: </span>{outcome.result.modelFidelity}</span>
              <span className="pill">{comp.model.kind}{comp.model.mcu ? ` · ${comp.model.mcu.coreName}` : ""}</span>
              <span className="desc">{comp.pins.length} pins{outcome.usage.inputTokens ? ` · $${outcome.usage.costUsd.toFixed(2)} · ${outcome.usage.inputTokens.toLocaleString()} in / ${outcome.usage.outputTokens.toLocaleString()} out tokens` : ""}</span>
            </div>
            {existingIds.has(comp.id) && <div className="msg-warn">A part with id "{comp.id}" already exists; saving replaces it.</div>}
            {outcome.result.notes.length > 0 && <ul className="notes">{outcome.result.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
            <details>
              <summary>Pins</summary>
              <table className="pin-table">
                <thead><tr><th>#</th><th>Id</th><th>Name</th><th>Type</th><th>Side</th><th>Port</th></tr></thead>
                <tbody>{comp.pins.map((p) => <tr key={p.id}><td>{p.number}</td><td>{p.id}</td><td>{p.name}</td><td>{p.type}</td><td>{p.side}</td><td>{p.port ?? ""}</td></tr>)}</tbody>
              </table>
            </details>
            <details>
              <summary>Edit definition (JSON)</summary>
              <textarea aria-label="Part definition JSON" className="code" style={{ width: "100%", minHeight: 260 }} spellCheck={false} value={json} onChange={(e) => setJson(e.target.value)} />
              <button className="btn" onClick={revalidate}>Re-check</button>
            </details>
            <div role="alert">
              {check?.errors.map((e, i) => <div key={`e${i}`} className="msg-err"><span aria-hidden>✗ </span><span className="sr-only">Error: </span>{e}</div>)}
            </div>
            {check?.warnings.map((w, i) => <div key={`w${i}`} className="msg-warn"><span aria-hidden>⚠ </span><span className="sr-only">Warning: </span>{w}</div>)}
            <div className="actions">
              <button className="btn" onClick={onClose}>Discard</button>
              <button className="btn" onClick={() => save(false)} disabled={!!check?.errors.length}>Save to library</button>
              <button className="btn primary" onClick={() => save(true)} disabled={!!check?.errors.length}>Save &amp; place</button>
            </div>
          </>
        )}
        {step !== "review" && step !== "running" && (
          <div className="actions"><button className="btn" onClick={onClose}>Close</button></div>
        )}
        {step === "running" && error && <div className="msg-err" role="alert">{error}</div>}
    </Dialog>
  );
}

function cleanErr(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
