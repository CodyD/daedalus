import { useMemo, useState } from "react";
import type { ComponentDef } from "../../shared/component";
import { kicadNetlist } from "../../shared/kicad";
import type { Project } from "../../shared/project";
import { announce } from "./a11y";
import { api } from "./api";
import { Dialog } from "./Dialog";

interface Props {
  project: Project;
  defs: Map<string, ComponentDef>;
  /** Mount and chip size are set in the parts list. */
  onPartsList: () => void;
  onClose: () => void;
}

export function KicadDialog({ project, defs, onPartsList, onClose }: Props) {
  const out = useMemo(() => kicadNetlist(project, defs), [project, defs]);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const exportNetlist = async () => {
    setError(null);
    try {
      const target = await api().saveText(out.text, `${project.name || "untitled"}.net`, { name: "KiCad netlist", extensions: ["net"] });
      if (target) { setSaved(target); announce("Netlist exported"); }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Dialog title="Export to KiCad PCB" onClose={onClose} className="bom" style={{ width: "min(900px, calc(100vw - 32px))" }}>
      <p className="sub">
        Writes a KiCad netlist with a footprint for each part, from the mount and package chosen in the parts list.
        In KiCad's PCB Editor, choose File › Import › Netlist… and pick the file; parts arrive with their connections
        shown as ratsnest lines, ready to place and route.
      </p>

      {out.parts.length === 0 ? <p className="sub">No board parts on the schematic yet.</p> : (
        <div className="bom-scroll">
          <table className="pin-table bom-table">
            <thead><tr><th>Reference</th><th>Value</th><th>Package</th><th>Footprint</th></tr></thead>
            <tbody>
              {out.parts.map((p) => (
                <tr key={p.ref}>
                  <td>{p.ref}</td>
                  <td>{p.value}</td>
                  <td>{p.package || <span className="desc">n/a</span>}</td>
                  <td>{p.footprint ? <code>{p.footprint.id}</code> : <span className="desc">none: assign in KiCad</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {out.warnings.length > 0 && (
        <ul className="sub" aria-label="Warnings">
          {out.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
      {saved && <p className="sub" role="status">Saved {saved}</p>}
      {error && <p className="sub" role="alert">Could not export: {error}</p>}

      <div className="actions">
        <button className="btn" onClick={onPartsList} title="Choose through-hole or surface-mount and the chip size">Parts List…</button>
        <div className="spacer" />
        <span className="desc">{out.parts.length} parts, {out.nets} nets</span>
        <button className="btn" onClick={exportNetlist} disabled={!out.parts.length}>Export Netlist…</button>
        <button className="btn primary" onClick={onClose}>Close</button>
      </div>
    </Dialog>
  );
}
