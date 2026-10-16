import type { ComponentDef } from "../../shared/component";
import type { PartInstance, Project } from "../../shared/project";
import { isTerminal } from "../../shared/edit";
import { api } from "./api";
import type { Selection } from "./Schematic";

interface Props {
  project: Project;
  defs: Map<string, ComponentDef>;
  selection: Selection;
  libraryPick: ComponentDef | null;
  wireNets: Map<string, string>;
  pinNets: Map<string, string>;
  simulating: boolean;
  indicate?: Record<string, unknown>;
  onProps: (ref: string, props: Record<string, string>) => void;
  onActuate: (ref: string, action: Record<string, unknown>) => void;
  onDeleteLibraryPart: (id: string) => void;
}

export function Inspector(p: Props) {
  const sel = p.selection;
  if (sel?.kind === "wire") {
    return <div className="inspector" role="group" aria-label="Wire properties"><div className="title">Wire</div><div className="kv"><span>net</span><span>{p.wireNets.get(sel.id) ?? "?"}</span></div></div>;
  }
  const part = sel?.kind === "part" ? p.project.parts.find((q) => q.ref === sel.ref) : undefined;
  const def = part ? p.defs.get(part.defId) : p.libraryPick ?? undefined;
  if (!def) {
    return (
      <div className="inspector">
        <div className="title">{p.project.name}</div>
        <div className="desc">{p.project.parts.length} parts · {p.project.wires.length} wires</div>
        <div className="desc">Select a part to edit its properties, or pick one from the library to place it.</div>
      </div>
    );
  }
  return (
    <div className="inspector">
      <div>
        <div className="title">{part ? `${part.ref} · ` : ""}{def.name}</div>
        <div className="desc">{def.description}</div>
        {def.manufacturer && <div className="desc">{def.manufacturer}</div>}
      </div>
      {part && <PropEditor part={part} def={def} project={p.project} disabled={p.simulating} onProps={p.onProps} />}
      {part && isTerminal(part.defId) && <NetPins part={part} def={def} project={p.project} defs={p.defs} pinNets={p.pinNets} />}
      {!(part && isTerminal(part.defId)) && <Datasheet def={def} />}
      {part && !isTerminal(part.defId) && <PinConnections part={part} def={def} project={p.project} defs={p.defs} pinNets={p.pinNets} />}
      {part && p.simulating && def.symbol.builtin === "pot" && (
        <div className="field">
          <label htmlFor={`wiper-${part.ref}`}>Wiper (live)</label>
          <input id={`wiper-${part.ref}`} type="range" min={0} max={1} step={0.005}
            value={Number((p.indicate as { position?: number } | undefined)?.position ?? 0.5)}
            aria-valuetext={`${Math.round(Number((p.indicate as { position?: number } | undefined)?.position ?? 0.5) * 100)}%`}
            onChange={(e) => p.onActuate(part.ref, { position: Number(e.target.value) })} />
        </div>
      )}
      <ModelSummary def={def} />
      {!part && def.source?.kind === "datasheet" && (
        <button className="btn danger" onClick={() => p.onDeleteLibraryPart(def.id)}>Remove from library</button>
      )}
    </div>
  );
}

function PropEditor({ part, def, project, disabled, onProps }: {
  part: PartInstance; def: ComponentDef; project: Project; disabled: boolean;
  onProps: (ref: string, props: Record<string, string>) => void;
}) {
  if (!def.properties.length) return null;
  const set = (k: string, v: string) => onProps(part.ref, { ...part.props, [k]: v });
  const sources = Object.keys(project.sources ?? {});
  return (
    <>
      {def.properties.map((pd) => {
        const v = part.props[pd.key] ?? pd.default;
        const id = `prop-${part.ref}-${pd.key}`;
        const label = `${pd.label}${pd.unit ? ` (${pd.unit})` : ""}`;
        return (
          <div className="field" key={pd.key}>
            <label htmlFor={id}>{label}</label>
            {pd.kind === "choice" ? (
              <select id={id} value={v} disabled={disabled} onChange={(e) => set(pd.key, e.target.value)}>
                {pd.choices?.map((c) => <option key={c}>{c}</option>)}
              </select>
            ) : pd.kind === "file" ? (
              <>
                <div className="row">
                  <input id={id} value={v} disabled={disabled} placeholder="path to .hex / .asm, or src:file.asm" onChange={(e) => set(pd.key, e.target.value)} />
                  <button className="btn" disabled={disabled} aria-label={`Browse for ${label}`} title="Browse…" onClick={async () => {
                    const f = await api().pickFile("hex");
                    if (f) set(pd.key, f.path);
                  }}>…</button>
                </div>
                {sources.length > 0 && (
                  <select aria-label={`${label}: project firmware source`} value={sources.includes(v.replace(/^src:/, "")) ? v : ""} disabled={disabled} onChange={(e) => set(pd.key, e.target.value)}>
                    <option value="">— project firmware source —</option>
                    {sources.map((s) => <option key={s} value={`src:${s}`}>{s}</option>)}
                  </select>
                )}
              </>
            ) : (
              <input id={id} value={v} disabled={disabled} onChange={(e) => set(pd.key, e.target.value)} />
            )}
          </div>
        );
      })}
    </>
  );
}

function Datasheet({ def }: { def: ComponentDef }) {
  const src = def.source;
  if (src?.kind === "emulated") {
    return <div className="field"><label>Emulated part</label><div className="desc">Simulated by a backing microcontroller. Set the readings it reports with its SIM button or the Sensor Emulator window.</div></div>;
  }
  if (src?.kind !== "datasheet") return <div className="field"><label>Datasheet</label><div className="desc">Built-in part, no datasheet.</div></div>;
  return (
    <div className="field">
      <label>Datasheet</label>
      <div className="row">
        <span className="ds-name" title={src.path ?? src.file}>{src.file ?? "unknown"}</span>
        {src.path && <button className="btn" aria-label={`Open datasheet ${src.file ?? ""}`} onClick={async () => {
          const err = await api().openDatasheet(src.path!);
          if (err) alert(err);
        }}>Open</button>}
      </div>
      {src.importedAt && <div className="desc">Imported {new Date(src.importedAt).toLocaleDateString()}</div>}
    </div>
  );
}

// Per pin: what other component pins share its net (labels and rails followed by name).
function PinConnections({ part, def, project, defs, pinNets }: {
  part: PartInstance; def: ComponentDef; project: Project; defs: Map<string, ComponentDef>; pinNets: Map<string, string>;
}) {
  const byNet = new Map<string, string[]>();
  for (const q of project.parts) {
    const d = defs.get(q.defId);
    if (!d || isTerminal(q.defId)) continue;
    for (const pin of d.pins) {
      const net = pinNets.get(`${q.ref}.${pin.id}`);
      if (net) byNet.set(net, [...(byNet.get(net) ?? []), `${q.ref}.${pin.name}`]);
    }
  }
  return (
    <div className="field">
      <label>Pin connections</label>
      <table className="pin-table conn-table" aria-label={`${part.ref} pin connections`}>
        <thead><tr><th scope="col"><abbr title="Pin number">#</abbr></th><th scope="col">Pin</th><th scope="col">Net</th><th scope="col">Connected to</th></tr></thead>
        <tbody>
          {def.pins.map((pin) => {
            const net = pinNets.get(`${part.ref}.${pin.id}`);
            const self = `${part.ref}.${pin.name}`;
            const others = net ? (byNet.get(net) ?? []).filter((x) => x !== self) : [];
            // A net named by a rail or label counts even with no other component pins.
            const live = !!net && (others.length > 0 || !/^N\d+$/.test(net));
            return (
              <tr key={pin.id} className={live ? undefined : "nc"}>
                <td>{pin.number}</td><td>{pin.name}</td><td>{live ? net : <span aria-label="none">—</span>}</td>
                <td>{!live ? "not connected" : others.length ? others.join(", ") : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Component pins on a terminal's net, wherever on the sheet they are.
function NetPins({ part, def, project, defs, pinNets }: {
  part: PartInstance; def: ComponentDef; project: Project; defs: Map<string, ComponentDef>; pinNets: Map<string, string>;
}) {
  const net = def.pins[0] && pinNets.get(`${part.ref}.${def.pins[0].id}`);
  if (!net) return <div className="field"><label>Connected pins</label><div className="desc">Not connected.</div></div>;
  const rows = project.parts.flatMap((q) => {
    const d = defs.get(q.defId);
    if (!d || isTerminal(q.defId)) return [];
    return d.pins.filter((pin) => pinNets.get(`${q.ref}.${pin.id}`) === net).map((pin) => ({ ref: q.ref, part: d.name, pin }));
  });
  return (
    <div className="field">
      <label>Connected pins · net {net}</label>
      {rows.length === 0 ? <div className="desc">No component pins on this net.</div> : (
        <table className="pin-table">
          <thead><tr><th>Part</th><th>Pin</th><th>#</th></tr></thead>
          <tbody>
            {rows.map((r) => <tr key={`${r.ref}.${r.pin.id}`}><td title={r.part}>{r.ref}</td><td>{r.pin.name}</td><td>{r.pin.number}</td></tr>)}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ModelSummary({ def }: { def: ComponentDef }) {
  const m = def.model;
  const kind = m.kind === "mcu" ? `MCU · ${m.mcu?.coreName}${m.mcu?.core === "unsupported" ? " (wiring only)" : ""}`
    : m.kind === "emulator" ? "emulated · backing AVR" : m.kind;
  return (
    <details>
      <summary>Model: {kind} · {def.pins.length} pins</summary>
      {m.spice && <pre className="code">{m.spice}</pre>}
      {m.logic && <pre className="code">{m.logic}</pre>}
      <table className="pin-table">
        <thead><tr><th>#</th><th>Pin</th><th>Type</th><th>Port</th></tr></thead>
        <tbody>
          {def.pins.map((pin) => <tr key={pin.id}><td>{pin.number}</td><td>{pin.name}</td><td>{pin.type}</td><td>{pin.port ?? ""}</td></tr>)}
        </tbody>
      </table>
      {def.source?.notes?.length ? <ul className="notes">{def.source.notes.map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
    </details>
  );
}
