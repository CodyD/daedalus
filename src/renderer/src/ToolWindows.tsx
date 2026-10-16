import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentDef } from "../../shared/component";
import { AsmError, assemble } from "../../sim/mcu/avr/asm";
import { M328P_SYMBOLS } from "../../sim/mcu/avr/variants";
import { controlValue } from "../../sim/mcu/avr/emulator";
import { formatValue } from "../../sim/units";
import type { Frame } from "./sim.worker";

export interface LogLine {
  time: number;
  level: string;
  source: string;
  message: string;
}

// Tool windows for the bottom dock by default: simulation log, virtual
// terminal, oscilloscope, CPU registers and firmware sources.

export function LogView({ logs }: { logs: LogLine[] }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" }); // returns a Promise in newer Chromium; don't return it
  }, [logs.length]);
  if (!logs.length) return <div className="log" role="log" aria-label="Simulation output" tabIndex={0}><div className="t">Simulation messages appear here.</div></div>;
  return (
    <div className="log" role="log" aria-label="Simulation output" tabIndex={0}>
      {logs.map((l, i) => (
        <div key={i} className={l.level}>
          {l.level !== "info" && <span className="sr-only">{l.level === "error" ? "Error" : "Warning"}: </span>}
          <span className="t">{formatValue(l.time, "s").padStart(8)}</span>
          <b>{l.source}</b>: {l.message}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

export function TerminalView({ refs, frame, onActuate }: { refs: string[]; frame: Frame | null; onActuate: (ref: string, action: Record<string, unknown>) => void }) {
  const [ref, setRef] = useState(refs[0]);
  const [line, setLine] = useState("");
  const pre = useRef<HTMLPreElement>(null);
  const active = refs.includes(ref) ? ref : refs[0];
  const text = (frame?.indicate[active] as { text?: string } | undefined)?.text ?? "";
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [text]);
  if (!refs.length) return <div className="desc">Place a Virtual Terminal on the schematic to use this window.</div>;
  return (
    <div className="terminal">
      {refs.length > 1 && <select aria-label="Terminal" value={active} onChange={(e) => setRef(e.target.value)}>{refs.map((r) => <option key={r}>{r}</option>)}</select>}
      <pre ref={pre} tabIndex={0} aria-label={`${active} serial output`}>{text || (frame ? "" : "Start the simulation to see serial output.")}</pre>
      <form onSubmit={(e) => {
        e.preventDefault();
        if (!frame) return;
        onActuate(active, { send: line + "\r" });
        setLine("");
      }} style={{ display: "flex", gap: 6 }}>
        <input style={{ flex: 1 }} aria-label={`Send to ${active}`} value={line} onChange={(e) => setLine(e.target.value)} placeholder="Type and press Enter to send (adds CR)" disabled={!frame} />
        <button className="btn" type="button" onClick={() => onActuate(active, { clear: true })} disabled={!frame}>Clear</button>
      </form>
    </div>
  );
}

// Theme / palette driven (see --trace-N in styles.css).
const TRACE = ["var(--trace-1)", "var(--trace-2)", "var(--trace-3)", "var(--trace-4)"];

export function ScopeView({ refs, frame }: { refs: string[]; frame: Frame | null }) {
  const [ref, setRef] = useState(refs[0]);
  const [vdiv, setVdiv] = useState(2);
  const active = refs.includes(ref) ? ref : refs[0];
  const ind = frame?.indicate[active] as { window: number; samples: number[][] } | undefined;
  const W = 1000, H = 200, divs = 8;
  const paths = useMemo(() => {
    if (!ind?.samples.length) return [];
    const t1 = ind.samples[ind.samples.length - 1][0];
    const t0 = t1 - ind.window;
    return [1, 2, 3, 4].map((ch) => {
      let d = "";
      for (const s of ind.samples) {
        const v = s[ch];
        if (Number.isNaN(v)) return "";
        const x = ((s[0] - t0) / ind.window) * W;
        const y = H / 2 - (v / vdiv) * (H / divs);
        const yc = Math.max(1, Math.min(H - 1, y)).toFixed(1); // clip to the screen edge
        // Sample-and-hold: the solver only emits points when something changes.
        d += d ? `H${x.toFixed(1)}V${yc}` : `M${x.toFixed(1)},${yc}`;
      }
      return d;
    });
  }, [ind, vdiv]);
  // Latest reading per channel, shown beside the trace and read out to screen readers.
  const last = ind?.samples.length ? ind.samples[ind.samples.length - 1] : undefined;
  const reading = (ch: number) => (last && !Number.isNaN(last[ch + 1]) ? formatValue(last[ch + 1], "V") : "—");
  const timeDiv = ind ? formatValue(ind.window / 10, "s") : "—";
  if (!refs.length) return <div className="desc">Place an Oscilloscope on the schematic to use this window.</div>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 150px", gap: 8, height: "100%" }}>
      <svg className="scope-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`Oscilloscope ${active}, ${vdiv} volts per division, ${timeDiv} per division. ${["A", "B", "C", "D"].map((c, i) => `Channel ${c} ${reading(i)}`).join(", ")}.`}>
        {Array.from({ length: 11 }, (_, i) => <line key={`v${i}`} x1={(i * W) / 10} x2={(i * W) / 10} y1={0} y2={H} stroke="#1b2f55" />)}
        {Array.from({ length: divs + 1 }, (_, i) => <line key={`h${i}`} y1={(i * H) / divs} y2={(i * H) / divs} x1={0} x2={W} stroke={i === divs / 2 ? "#2e4a80" : "#1b2f55"} />)}
        {paths.map((d, i) => d && <path key={i} d={d} stroke={TRACE[i]} fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />)}
      </svg>
      <div className="inspector" style={{ padding: 0 }}>
        {refs.length > 1 && <select aria-label="Oscilloscope" value={active} onChange={(e) => setRef(e.target.value)}>{refs.map((r) => <option key={r}>{r}</option>)}</select>}
        <div className="field"><label htmlFor={`vdiv-${active}`}>Volts / div</label>
          <select id={`vdiv-${active}`} value={vdiv} onChange={(e) => setVdiv(Number(e.target.value))}>
            {[0.1, 0.2, 0.5, 1, 2, 5].map((v) => <option key={v} value={v}>{v} V</option>)}
          </select>
        </div>
        <div className="desc">Time / div: {timeDiv}</div>
        {["A", "B", "C", "D"].map((c, i) => (
          <div key={c} className="mono" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span aria-hidden style={{ width: 14, height: 3, background: TRACE[i], flex: "none" }} />
            Ch {c} <span style={{ marginLeft: "auto" }}>{reading(i)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CpuView({ refs, frame }: { refs: string[]; frame: Frame | null }) {
  if (!refs.length) return <div className="desc">No microcontroller on the schematic.</div>;
  return (
    <div style={{ display: "flex", gap: 30 }}>
      {refs.map((r) => {
        const c = frame?.indicate[r] as { pc: number; cycles: number; sreg: number; sp: number; regs: number[]; sleeping: boolean; loaded: boolean; clock: number } | undefined;
        if (!c) return <div key={r} className="desc">{r}: start the simulation to inspect the CPU.</div>;
        const flags = "ITHSVNZC".split("").map((f, i) => ((c.sreg >> (7 - i)) & 1 ? f : "-")).join("");
        return (
          <div key={r}>
            <div className="title" style={{ marginBottom: 6 }}>{r} {c.loaded ? "" : "(no program)"}</div>
            <div className="kv" style={{ marginBottom: 8 }}>
              <span>PC</span><span>0x{c.pc.toString(16).padStart(4, "0")}</span>
              <span>SP</span><span>0x{c.sp.toString(16).padStart(4, "0")}</span>
              <span>SREG</span><span>{flags}</span>
              <span>cycles</span><span>{c.cycles.toLocaleString()} ({formatValue(c.cycles / c.clock, "s")})</span>
              <span>state</span><span>{c.sleeping ? "sleep" : "running"}</span>
            </div>
            <div className="regs">
              {c.regs.map((v, i) => <span key={i}><span className="n">R{i}</span> {v.toString(16).padStart(2, "0")}</span>)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function FirmwareView({ sources, onSources }: { sources: Record<string, string>; onSources: (s: Record<string, string>) => void }) {
  const names = Object.keys(sources);
  const [name, setName] = useState(names[0] ?? "");
  const active = names.includes(name) ? name : names[0];
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [newName, setNewName] = useState("");
  const build = () => {
    try {
      const r = assemble(sources[active], M328P_SYMBOLS);
      setStatus({ ok: true, msg: `Assembled ${r.bytes.length} bytes (${Object.keys(r.labels).length} labels).` });
    } catch (e) {
      setStatus({ ok: false, msg: e instanceof AsmError ? e.message : String(e) });
    }
  };
  return (
    <div className="fw">
      <div className="files">
        <div role="group" aria-label="Source files" style={{ display: "contents" }}>
          {names.map((n) => <button key={n} className={`btn${n === active ? " active" : ""}`} aria-pressed={n === active} onClick={() => setName(n)}>{n}</button>)}
        </div>
        <form style={{ display: "flex", gap: 4 }} onSubmit={(e) => {
          e.preventDefault();
          const n = newName.trim();
          if (!n || sources[n] !== undefined) return;
          onSources({ ...sources, [n]: "; AVR assembly for ATmega328P\n.org 0\n  rjmp main\nmain:\n  rjmp main\n" });
          setName(n);
          setNewName("");
        }}>
          <input style={{ minWidth: 0, flex: 1 }} aria-label="New source file name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="new.asm" />
          <button className="btn" type="submit" title="Add source file" aria-label="Add source file">+</button>
        </form>
        {active && <button className="btn" onClick={build}>Assemble</button>}
        <div className="desc">Set an MCU's Program property to <code>src:{active ?? "file.asm"}</code> to run it.</div>
        <div role="status">{status && <div className={status.ok ? "desc" : "err"}>{status.ok ? "" : <span className="sr-only">Assembly failed: </span>}{status.msg}</div>}</div>
      </div>
      {active ? (
        <textarea spellCheck={false} aria-label={`${active} source`} value={sources[active]} onChange={(e) => onSources({ ...sources, [active]: e.target.value })} />
      ) : (
        <div className="desc">No firmware sources in this project. Create one, or point the MCU at a .hex file built with avr-gcc / Arduino.</div>
      )}
    </div>
  );
}

export interface EmulatedPart {
  ref: string;
  def: ComponentDef;
  props: Record<string, string>;
}

/**
 * Controls for emulated sensors: the quantities each part's backing
 * microcontroller reports, settable before and during a simulation.
 */
export function EmulatorView({ parts, target, onTarget, frame, onControl }: {
  parts: EmulatedPart[];
  target: string | null;
  onTarget: (ref: string) => void;
  frame: Frame | null;
  onControl: (ref: string, key: string, value: number) => void;
}) {
  if (!parts.length) {
    return <div className="desc">No emulated parts on the schematic. Ask the AI Assistant for a sensor or module (for example "a JC02-1 laser rangefinder") and it creates one, backed by a hidden microcontroller you control from here.</div>;
  }
  const part = parts.find((p) => p.ref === target) ?? parts[0];
  const em = part.def.model.emulator!;
  const ind = frame?.indicate[part.ref] as { loaded?: boolean; cycles?: number; controls?: Record<string, number>; dacs?: Record<string, number> } | undefined;
  return (
    <div className="emu">
      {parts.length > 1 && (
        <select aria-label="Emulated part" value={part.ref} onChange={(e) => onTarget(e.target.value)}>
          {parts.map((p) => <option key={p.ref} value={p.ref}>{p.ref} · {p.def.name}</option>)}
        </select>
      )}
      <div>
        <div className="title">{part.ref} · {part.def.name}</div>
        <div className="desc">{part.def.description}</div>
      </div>
      <div className="emu-status">
        <span className={`dot${ind?.loaded ? " on" : ""}`} aria-hidden />
        {ind ? `Backing MCU running · ${formatValue(em.clockHz, "Hz")} · ${(ind.cycles ?? 0).toLocaleString()} cycles`
          : `Backing MCU (AVR, ${formatValue(em.clockHz, "Hz")}) starts with the simulation`}
      </div>
      {em.controls.map((c) => {
        const value = ind?.controls?.[c.key] ?? controlValue(part.def, part.props, c.key);
        const set = (v: number) => Number.isFinite(v) && onControl(part.ref, c.key, Math.min(c.max, Math.max(c.min, v)));
        const label = `${c.label}${c.unit ? ` (${c.unit})` : ""}`;
        if (c.kind === "toggle") {
          return (
            <div key={c.key} className="field">
              <label className="check"><input type="checkbox" checked={value >= 0.5} onChange={(e) => set(e.target.checked ? c.max : c.min)} />{label}</label>
            </div>
          );
        }
        const step = c.step ?? (c.max - c.min) / 1000;
        return (
          <div key={c.key} className="emu-ctl">
            <label htmlFor={`emu-${part.ref}-${c.key}`}>{label}</label>
            <input id={`emu-${part.ref}-${c.key}`} type="range" min={c.min} max={c.max} step={step} value={value} onChange={(e) => set(Number(e.target.value))} />
            <input type="number" aria-label={label} min={c.min} max={c.max} step={step} value={value} onChange={(e) => set(Number(e.target.value))} />
          </div>
        );
      })}
      {ind?.dacs && Object.keys(ind.dacs).length > 0 && (
        <div className="kv">{Object.entries(ind.dacs).map(([k, v]) => <Fragment key={k}><span>{k}</span><span>{v.toFixed(3)} V</span></Fragment>)}</div>
      )}
      <details>
        <summary>Backing microcontroller</summary>
        <table className="pin-table" style={{ margin: "6px 0" }}>
          <thead><tr><th>Pin</th><th>Backing MCU</th></tr></thead>
          <tbody>{part.def.pins.filter((p) => p.port).map((p) => <tr key={p.id}><td>{p.name}</td><td>{p.port}</td></tr>)}</tbody>
        </table>
        <pre className="code">{em.source.trim()}</pre>
      </details>
    </div>
  );
}
