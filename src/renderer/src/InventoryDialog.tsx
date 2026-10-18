import { useEffect, useId, useMemo, useState } from "react";
import type { ComponentDef } from "../../shared/component";
import { buildBom, isPurchasable } from "../../shared/bom";
import { parsePackageId } from "../../shared/packages";
import { DEFAULT_PROFILE_ID, InventoryItem, Profile, ProfileSummary, itemsForLine, mergeInventory, newItemId } from "../../shared/inventory";
import type { Project } from "../../shared/project";
import { announce } from "./a11y";
import { api } from "./api";
import { Dialog } from "./Dialog";
import { PairPhonePanel } from "./PairPhonePanel";

interface Props {
  project: Project;
  defs: Map<string, ComponentDef>;
  /** The active profile changed or its inventory was saved. */
  onProfile: (p: Profile) => void;
  onClose: () => void;
}

const CATEGORY_ORDER: ComponentDef["category"][] = ["passive", "semiconductor", "indicator", "logic", "analog-ic", "mcu", "peripheral", "misc"];

/** Default of the part's value property (R, C, L), used to prefill the value field. */
const VALUE_KEYS = ["R", "C", "L"];
const defaultValue = (def: ComponentDef) => def.properties.find((p) => VALUE_KEYS.includes(p.key))?.default;

export function InventoryDialog({ project, defs, onProfile, onClose }: Props) {
  const uid = useId();
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [items, setItems] = useState<InventoryItem[]>([]);
  /** The inventory as loaded, so a save can keep what a paired phone added meanwhile. */
  const [base, setBase] = useState<InventoryItem[]>([]);
  const [pairingPhone, setPairingPhone] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [filter, setFilter] = useState("");
  /** Inline name editor for a new or renamed profile. */
  const [naming, setNaming] = useState<{ mode: "new" | "rename"; name: string } | null>(null);
  const [error, setError] = useState("");

  const load = async (p?: Profile) => {
    const [list, active] = await Promise.all([api().listProfiles(), p ? Promise.resolve(p) : api().activeProfile()]);
    setProfiles(list.profiles);
    setProfile(active);
    setItems(active.inventory);
    setBase(active.inventory);
    setDirty(false);
    onProfile(active);
  };
  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, []);

  const libParts = useMemo(() => {
    const byCat = new Map<string, ComponentDef[]>();
    for (const d of defs.values()) {
      if (!isPurchasable(d) || parsePackageId(d.id)) continue;
      byCat.set(d.category, [...(byCat.get(d.category) ?? []), d]);
    }
    for (const list of byCat.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return CATEGORY_ORDER.filter((c) => byCat.has(c)).map((c) => [c, byCat.get(c)!] as const);
  }, [defs]);
  const listed = useMemo(() => new Set(libParts.flatMap(([, list]) => list.map((d) => d.id))), [libParts]);

  const edit = (id: string, patch: Partial<InventoryItem>) => {
    setItems((list) => list.map((it) => (it.id === id ? { ...it, ...patch } : it)));
    setDirty(true);
  };
  const add = () => {
    setFilter("");
    setItems((list) => [...list, { id: newItemId(), name: "", qty: 1 }]);
    setDirty(true);
  };
  const remove = (id: string) => { setItems((list) => list.filter((it) => it.id !== id)); setDirty(true); };

  /** Adds the purchasable parts on the schematic, merging with matching lines. */
  const addFromSchematic = () => {
    const next = [...items];
    let added = 0;
    for (const line of buildBom(project, defs)) {
      const defId = line.key.slice(0, line.key.indexOf("|"));
      if (!defs.has(defId)) continue;
      added += line.qty;
      const match = itemsForLine(line, next.map((it) => ({ ...it, qty: Math.max(it.qty, 1) })))[0];
      if (match) {
        const i = next.findIndex((it) => it.id === match.id);
        next[i] = { ...next[i], qty: next[i].qty + line.qty };
      } else {
        next.push({ id: newItemId(), defId, name: line.name, value: line.value || undefined, package: line.package || undefined, qty: line.qty });
      }
    }
    setItems(next);
    setDirty(true);
    announce(added ? `Added ${added} parts from the schematic` : "No purchasable parts on the schematic");
  };

  const save = async () => {
    setError("");
    const clean = items
      .map((it) => ({ ...it, name: it.name.trim() || (it.defId ? defs.get(it.defId)?.name ?? it.defId : "") }))
      .filter((it) => it.name);
    try {
      const now = await api().activeProfile();
      const merged = now.id === profile!.id ? mergeInventory(base, clean, now.inventory) : clean;
      await api().setInventory(merged);
      await load({ ...profile!, inventory: merged });
      announce("Inventory saved");
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const okToLeave = () => !dirty || confirm("Discard unsaved inventory changes?");
  const close = () => { if (okToLeave()) onClose(); };

  const switchTo = async (id: string) => {
    if (!okToLeave()) return;
    try { await load(await api().switchProfile(id)); } catch (e) { setError((e as Error).message); }
  };
  const commitName = async () => {
    if (!naming || !profile) return;
    const name = naming.name.trim();
    if (!name) { setNaming(null); return; }
    try {
      if (naming.mode === "new") {
        if (!okToLeave()) return;
        await load(await api().createProfile(name));
      } else {
        await api().renameProfile(profile.id, name);
        const renamed = { ...profile, name };
        setProfile(renamed);
        setProfiles((await api().listProfiles()).profiles);
        onProfile(renamed);
      }
      setNaming(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const deleteProfile = async () => {
    if (!profile || profile.id === DEFAULT_PROFILE_ID) return;
    if (!confirm(`Delete the profile "${profile.name}" and its inventory of ${profile.inventory.length} parts? This cannot be undone.`)) return;
    try {
      await api().deleteProfile(profile.id);
      await load(await api().switchProfile(DEFAULT_PROFILE_ID));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = items.filter((it) => {
    if (!words.length || !it.name) return true;
    const hay = `${it.name} ${it.defId ?? ""} ${it.value ?? ""} ${it.package ?? ""} ${it.location ?? ""} ${it.notes ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const total = items.reduce((n, it) => n + it.qty, 0);

  return (
    <Dialog title="Parts Inventory" onClose={close} className="bom inventory" style={{ width: "min(1180px, calc(100vw - 32px))" }}>
      <div className="bom-bar">
        <label htmlFor={`${uid}-profile`} className="desc">Profile</label>
        {naming ? (
          <>
            <input id={`${uid}-profile`} autoFocus value={naming.name} placeholder="Profile name" aria-label={naming.mode === "new" ? "New profile name" : "Profile name"}
              onChange={(e) => setNaming({ ...naming, name: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") commitName(); }}
              // Capture phase, so Escape cancels the name edit before the dialog's own Escape closes it.
              onKeyDownCapture={(e) => { if (e.key === "Escape") { e.stopPropagation(); setNaming(null); } }} />
            <button className="btn" onClick={commitName}>{naming.mode === "new" ? "Create" : "Rename"}</button>
            <button className="btn" onClick={() => setNaming(null)}>Cancel</button>
          </>
        ) : (
          <>
            <select id={`${uid}-profile`} value={profile?.id ?? ""} onChange={(e) => switchTo(e.target.value)}>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button className="btn" onClick={() => setNaming({ mode: "new", name: "" })}>New…</button>
            <button className="btn" onClick={() => profile && setNaming({ mode: "rename", name: profile.name })} disabled={!profile}>Rename…</button>
            <button className="btn" onClick={deleteProfile} disabled={!profile || profile.id === DEFAULT_PROFILE_ID}
              title={profile?.id === DEFAULT_PROFILE_ID ? "The default profile cannot be deleted" : undefined}>Delete</button>
          </>
        )}
        <div className="spacer" />
        <input type="search" aria-label="Filter inventory" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 180 }} />
        <span className="desc">{items.length} lines, {total} parts</span>
      </div>
      <p className="sub">The AI assistant checks this list when it picks parts and uses what you have where it suits the design.</p>

      {pairingPhone ? (
        <PairPhonePanel onDone={() => {
          setPairingPhone(false);
          // Show what the phone added, unless that would throw away edits here.
          if (!dirty) load().catch((e) => setError((e as Error).message));
        }} />
      ) : <>
      {items.length === 0 ? <p className="sub">No parts recorded yet. Add them one by one, or add everything on the open schematic.</p> : (
        <div className="bom-scroll">
          <table className="pin-table bom-table inv-table">
            <thead>
              <tr><th>Library part</th><th>Name / part number</th><th>Value</th><th>Package</th><th>Qty</th><th>Location</th><th>Notes</th><th><span className="sr-only">Remove</span></th></tr>
            </thead>
            <tbody>
              {shown.map((it, i) => {
                const label = it.name || `row ${i + 1}`;
                return (
                  <tr key={it.id}>
                    <td>
                      <select aria-label={`Library part for ${label}`} value={it.defId ?? ""} onChange={(e) => {
                        const def = defs.get(e.target.value);
                        edit(it.id, {
                          defId: def?.id,
                          name: it.name || def?.name || "",
                          value: it.value || (def && defaultValue(def)) || undefined,
                        });
                      }}>
                        <option value="">(not in library)</option>
                        {it.defId && !listed.has(it.defId) && <option value={it.defId}>{defs.get(it.defId)?.name ?? `${it.defId} (missing)`}</option>}
                        {libParts.map(([cat, list]) => (
                          <optgroup key={cat} label={cat}>
                            {list.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                          </optgroup>
                        ))}
                      </select>
                    </td>
                    <td><input aria-label={`Name for row ${i + 1}`} value={it.name} placeholder="e.g. NE555P, 10k resistor" onChange={(e) => edit(it.id, { name: e.target.value })} /></td>
                    <td><input aria-label={`Value for ${label}`} value={it.value ?? ""} placeholder="10k" style={{ width: 70 }} onChange={(e) => edit(it.id, { value: e.target.value || undefined })} /></td>
                    <td><input aria-label={`Package for ${label}`} value={it.package ?? ""} placeholder="DIP-8" style={{ width: 80 }} onChange={(e) => edit(it.id, { package: e.target.value || undefined })} /></td>
                    <td><input aria-label={`Quantity of ${label}`} type="number" min={0} step={1} value={it.qty} style={{ width: 64 }}
                      onChange={(e) => edit(it.id, { qty: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} /></td>
                    <td><input aria-label={`Location of ${label}`} value={it.location ?? ""} style={{ width: 100 }} onChange={(e) => edit(it.id, { location: e.target.value || undefined })} /></td>
                    <td><input aria-label={`Notes for ${label}`} value={it.notes ?? ""} onChange={(e) => edit(it.id, { notes: e.target.value || undefined })} /></td>
                    <td><button className="btn icon" aria-label={`Remove ${label}`} title="Remove" onClick={() => remove(it.id)}>×</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {error && <p className="msg-err" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn" onClick={add}>Add Part</button>
        <button className="btn" onClick={addFromSchematic} disabled={!project.parts.some((p) => { const d = defs.get(p.defId); return d && isPurchasable(d); })}
          title="Add every purchasable part on the open schematic, e.g. after buying its parts list">Add Parts from Schematic</button>
        <button className="btn" onClick={() => setPairingPhone(true)}
          title="Pair the Daedalus Inventory Scanner app to add parts by photographing them">Pair Phone…</button>
        <div className="spacer" />
        <button className="btn" onClick={close}>{dirty ? "Cancel" : "Close"}</button>
        <button className="btn primary" onClick={async () => { if (await save()) onClose(); }} disabled={!dirty}>Save</button>
      </div>
      </>}
    </Dialog>
  );
}
