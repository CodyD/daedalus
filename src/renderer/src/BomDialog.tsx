import { useEffect, useId, useMemo, useState } from "react";
import type { ComponentDef } from "../../shared/component";
import { BomLine, SMD_SIZES, bomCsv, bomSettings, buildBom, digikeyUrl, isPurchasable, mouserUrl } from "../../shared/bom";
import type { BomSettings, Mount, Project, SmdSize } from "../../shared/project";
import type { Distributor, StockAnswer } from "../../main/distributors";
import { InventoryItem, onHand } from "../../shared/inventory";
import { announce } from "./a11y";
import { api } from "./api";
import { Dialog } from "./Dialog";

interface Props {
  project: Project;
  defs: Map<string, ComponentDef>;
  onChange: (fn: (p: Project) => Project, group?: string) => void;
  /** Active profile's parts, for the On Hand column. */
  inventory: InventoryItem[];
  onInventory: () => void;
  onConsolidate: () => void;
  onDistributorOptions: () => void;
  onClose: () => void;
}

const DISTS: [Distributor, string, (q: string) => string][] = [["mouser", "Mouser", mouserUrl], ["digikey", "DigiKey", digikeyUrl]];

export function BomDialog({ project, defs, onChange, inventory, onInventory, onConsolidate, onDistributorOptions, onClose }: Props) {
  const uid = useId();
  const settings = bomSettings(project);
  const lines = useMemo(() => buildBom(project, defs), [project, defs]);
  const simOnly = project.parts.filter((p) => { const d = defs.get(p.defId); return d && !isPurchasable(d); }).length;
  const [keys, setKeys] = useState({ mouser: false, digikey: false });
  useEffect(() => { api().getSettings().then((s) => setKeys(s.distributors)).catch(() => {}); }, []);
  const [stock, setStock] = useState<Record<string, StockAnswer | "loading">>({});
  const [copied, setCopied] = useState(false);

  const setBom = (patch: Partial<BomSettings>) => onChange((p) => ({ ...p, bom: { ...bomSettings(p), ...patch } }), "bom");
  const setLine = (key: string, patch: { mount?: Mount; query?: string }) => onChange((p) => {
    const s = bomSettings(p);
    const next = { ...s.lines?.[key], ...patch };
    if (!next.mount) delete next.mount;
    if (!next.query) delete next.query;
    const lines = { ...s.lines };
    if (Object.keys(next).length) lines[key] = next;
    else delete lines[key];
    return { ...p, bom: { ...s, lines: Object.keys(lines).length ? lines : undefined } };
  }, `bom:${key}`);

  const enabled = DISTS.filter(([d]) => keys[d]);
  const checkStock = async () => {
    announce("Checking stock");
    // One request at a time per distributor keeps well inside their rate limits.
    await Promise.all(enabled.map(async ([dist]) => {
      for (const l of lines) {
        const k = `${dist}|${l.query}`;
        setStock((s) => ({ ...s, [k]: "loading" }));
        const answer = await api().checkStock(dist, l.query);
        setStock((s) => ({ ...s, [k]: answer }));
      }
    }));
    announce("Stock check finished");
  };

  const copyCsv = async () => {
    await navigator.clipboard.writeText(bomCsv(lines));
    setCopied(true);
    announce("Parts list copied as CSV");
    setTimeout(() => setCopied(false), 1500);
  };

  const total = lines.reduce((n, l) => n + l.qty, 0);
  const have = new Map(lines.map((l) => [l.key, onHand(l, inventory)]));
  const toBuy = lines.reduce((n, l) => n + Math.max(0, l.qty - have.get(l.key)!), 0);

  return (
    <Dialog title="Parts List" onClose={onClose} className="bom" style={{ width: "min(1180px, calc(100vw - 32px))" }}>
      <div className="bom-bar">
        <div role="radiogroup" aria-label="Assembly" className="seg">
          {(["tht", "smd"] as Mount[]).map((m) => (
            <button key={m} role="radio" aria-checked={settings.mount === m} className={`btn${settings.mount === m ? " active" : ""}`}
              title={m === "tht" ? "Through-hole: leaded parts for breadboards, perfboard and hand soldering" : "Surface-mount: smaller parts for reflow or a steady hand"}
              onClick={() => setBom({ mount: m })}>{m === "tht" ? "Through-hole" : "Surface-mount"}</button>
          ))}
        </div>
        <label htmlFor={`${uid}-size`} className="desc">Chip size</label>
        <select id={`${uid}-size`} value={settings.smdSize} disabled={settings.mount !== "smd"} onChange={(e) => setBom({ smdSize: e.target.value as SmdSize })}
          title="Footprint for SMD resistors, capacitors, inductors and LEDs">
          {SMD_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <div className="spacer" />
        <span className="desc">{lines.length} lines, {total} parts{inventory.length ? `, ${toBuy} to buy` : ""}{simOnly ? `; ${simOnly} simulation-only parts left out` : ""}</span>
      </div>

      {lines.length === 0 ? <p className="sub">No purchasable parts on the schematic yet.</p> : (
        <div className="bom-scroll">
          <table className="pin-table bom-table">
            <thead>
              <tr>
                <th>Qty</th><th title="How many your inventory has">On hand</th><th>References</th><th>Part</th><th>Value</th><th>Mount</th><th>Package</th><th>Search</th>
                {DISTS.map(([d, label]) => <th key={d}>{label}</th>)}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => <Row key={l.key} line={l} have={have.get(l.key)!} stock={stock} onLine={setLine} />)}
            </tbody>
          </table>
        </div>
      )}

      <div className="actions">
        <button className="btn" onClick={onInventory} title="Record the parts you already own">Inventory…</button>
        <button className="btn" onClick={onConsolidate} title="Replace resistors, capacitors, diodes, transistors and op-amps with multi-unit packages">Consolidate…</button>
        <div className="spacer" />
        {enabled.length
          ? <button className="btn" onClick={checkStock} disabled={!lines.length}>Check Stock ({enabled.map(([, l]) => l).join(", ")})</button>
          : <button className="btn" onClick={onDistributorOptions} title="Add Mouser or DigiKey API credentials to check stock and prices">Set Up Stock Check…</button>}
        <button className="btn" onClick={copyCsv} disabled={!lines.length}>{copied ? "Copied" : "Copy as CSV"}</button>
        <button className="btn primary" onClick={onClose}>Close</button>
      </div>
    </Dialog>
  );
}

function Row({ line: l, have, stock, onLine }: {
  line: BomLine;
  have: number;
  stock: Record<string, StockAnswer | "loading">;
  onLine: (key: string, patch: { mount?: Mount; query?: string }) => void;
}) {
  // Edit locally and save on blur, so typing doesn't push an undo step per key.
  const [q, setQ] = useState(l.query);
  useEffect(() => setQ(l.query), [l.query]);
  const commit = () => { if (q.trim() !== l.query) onLine(l.key, { query: q.trim() === l.autoQuery ? "" : q.trim() }); };
  return (
    <tr>
      <td>{l.qty}</td>
      <td>{have === 0 ? <span className="desc">0</span> : have >= l.qty ? <span title="Enough on hand">{have} ✓</span> : <span title={`${l.qty - have} more needed`}>{have}</span>}</td>
      <td className="bom-refs">{l.refs.join(", ")}</td>
      <td>{l.name}</td>
      <td>{l.value}</td>
      <td>
        {l.mount === null ? <span className="desc">n/a</span>
          : !l.choice ? l.mount.toUpperCase()
          : (
            <select aria-label={`Mount for ${l.refs.join(", ")}`} value={l.mountOverride ? l.mount : ""} onChange={(e) => onLine(l.key, { mount: (e.target.value || undefined) as Mount | undefined })}>
              <option value="">Project default</option>
              <option value="tht">THT</option>
              <option value="smd">SMD</option>
            </select>
          )}
      </td>
      <td>{l.package}</td>
      <td className="bom-q">
        <input aria-label={`Search text for ${l.refs.join(", ")}`} value={q} onChange={(e) => setQ(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />
        {l.query !== l.autoQuery && <button className="btn icon" title={`Reset to "${l.autoQuery}"`} aria-label="Reset search text" onClick={() => onLine(l.key, { query: "" })}>↺</button>}
      </td>
      {DISTS.map(([d, label, url]) => (
        <td key={d} className="bom-dist">
          <a href={url(l.query)} target="_blank" rel="noreferrer" title={`Search ${label} for "${l.query}"`}>Search</a>
          <Stock answer={stock[`${d}|${l.query}`]} />
        </td>
      ))}
    </tr>
  );
}

function Stock({ answer }: { answer?: StockAnswer | "loading" }) {
  if (!answer) return null;
  if (answer === "loading") return <div className="desc">checking…</div>;
  if ("error" in answer) return <div className="msg-err" title={answer.error}>error</div>;
  const best = answer.hits[0];
  if (!best || best.stock <= 0) return <div className="msg-err">none in stock</div>;
  const others = answer.hits.slice(1).map((h) => `${h.mpn}: ${h.stock.toLocaleString()}`).join("\n");
  return (
    <div title={`${best.manufacturer} ${best.mpn}\n${best.description}${others ? `\n\nAlso:\n${others}` : ""}`}>
      <a href={best.url} target="_blank" rel="noreferrer">{best.mpn}</a>
      <div className="desc">{best.stock.toLocaleString()} in stock{best.price !== null ? ` · ${best.currency === "USD" ? "$" : `${best.currency} `}${best.price.toFixed(best.price < 1 ? 3 : 2)}` : ""}</div>
    </div>
  );
}
