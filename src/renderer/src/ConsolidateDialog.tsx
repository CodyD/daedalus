import { useMemo, useState } from "react";
import type { ComponentDef } from "../../shared/component";
import { bomSettings } from "../../shared/bom";
import { ConsolidateResult, consolidate, findConsolidations } from "../../shared/consolidate";
import { PACK_INFO } from "../../shared/packages";
import type { Mount, Project } from "../../shared/project";
import { announce } from "./a11y";
import { Dialog } from "./Dialog";

interface Props {
  project: Project;
  defs: Map<string, ComponentDef>;
  onChange: (fn: (p: Project) => Project) => void;
  onClose: () => void;
}

export function ConsolidateDialog({ project, defs, onChange, onClose }: Props) {
  const [mount, setMount] = useState<Mount>(bomSettings(project).mount);
  const proposals = useMemo(() => findConsolidations(project, defs, mount), [project, defs, mount]);
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<ConsolidateResult | null>(null);
  const chosen = proposals.filter((_, i) => !skipped.has(i));
  const saved = chosen.reduce((n, p) => n + p.members.length - 1, 0);

  const apply = () => {
    const r = consolidate(project, defs, chosen);
    // The packages were picked for this assembly style, so the parts list follows it.
    onChange(() => ({ ...r.project, bom: { ...bomSettings(r.project), mount } }));
    setResult(r);
    setSkipped(new Set());
    announce(`${r.done.length} packages placed`);
  };

  return (
    <Dialog title="Consolidate Parts" onClose={onClose} style={{ width: 720 }}>
      <p className="sub">
        Replace basic parts with multi-unit packages: resistor arrays and networks, capacitor arrays, dual diodes, dual transistors,
        dual and quad op-amps. The package is placed where the parts were and their wiring is moved to its pins. Undo (Ctrl+Z) puts the parts back.
      </p>
      <div className="bom-bar">
        <div role="radiogroup" aria-label="Assembly" className="seg">
          {(["tht", "smd"] as Mount[]).map((m) => (
            <button key={m} role="radio" aria-checked={mount === m} className={`btn${mount === m ? " active" : ""}`}
              onClick={() => { setMount(m); setSkipped(new Set()); }}>{m === "tht" ? "Through-hole" : "Surface-mount"}</button>
          ))}
        </div>
        {mount === "tht" && <span className="desc">Capacitor arrays, dual diodes and dual transistors only come as SMD.</span>}
      </div>

      <fieldset>
        <legend>Suggestions</legend>
        {proposals.length === 0 && <div className="desc">Nothing to consolidate: no two parts can share a {mount.toUpperCase()} package.</div>}
        {proposals.map((p, i) => (
          <label key={`${p.kind}:${p.members.join(",")}`} className="check">
            <input type="checkbox" checked={!skipped.has(i)} onChange={(e) => {
              const s = new Set(skipped);
              if (e.target.checked) s.delete(i); else s.add(i);
              setSkipped(s);
            }} />
            <span>
              <b>{PACK_INFO[p.kind].label}</b>, {p.size} units: {p.detail}
              {p.size > p.members.length && <span className="desc"> ({p.size - p.members.length} unused)</span>}
            </span>
          </label>
        ))}
        {proposals.some((p) => p.kind === "opamp") && (
          <div className="desc">Op-amp packages keep the ideal op-amp model in simulation; the parts list buys an LM358 (dual) or LM324 (quad).</div>
        )}
      </fieldset>

      {result && (
        <div role="status" className="desc">
          {result.done.map((d) => (
            <div key={d.ref}>
              <b>{d.ref}</b> replaces {d.members.join(", ")}
              {d.labelled.length > 0 && <>; no clean wire route for {d.labelled.join(", ")}, joined with net labels instead</>}.
            </div>
          ))}
          {result.skipped.map((s) => <div key={s} className="msg-err">Skipped {s}: the parts changed.</div>)}
        </div>
      )}

      <div className="actions">
        {chosen.length > 0 && <span className="desc" style={{ alignSelf: "center" }}>{saved} fewer parts</span>}
        <button className="btn primary" disabled={!chosen.length} onClick={apply}>Consolidate{chosen.length ? ` (${chosen.length})` : ""}</button>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
    </Dialog>
  );
}
