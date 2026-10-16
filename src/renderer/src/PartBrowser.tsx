import { useId, useMemo, useRef, useState } from "react";
import type { ComponentDef } from "../../shared/component";

const ORDER: ComponentDef["category"][] = [
  "mcu", "peripheral", "indicator", "instrument", "logic", "analog-ic", "semiconductor", "passive", "source", "terminal", "misc",
];
const LABEL: Record<ComponentDef["category"], string> = {
  mcu: "Microcontrollers", peripheral: "Peripherals", indicator: "Indicators", instrument: "Instruments", logic: "Logic",
  "analog-ic": "Analog ICs", semiconductor: "Semiconductors", passive: "Passives", source: "Sources", terminal: "Terminals",
  misc: "Other",
};

interface Props {
  parts: ComponentDef[];
  selected: string | null;
  onPick: (id: string) => void;
  onImport: () => void;
}

/**
 * Library list. Keyboard: one Tab stop; arrows / Home / End move, Enter or
 * Space picks the part for placing (the schematic gets focus to place it).
 * Down arrow from the search box moves into the list.
 */
export function PartBrowser({ parts, selected, onPick, onImport }: Props) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const uid = useId();
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hit = (d: ComponentDef) => !needle || [d.id, d.name, d.description, d.manufacturer ?? ""].some((s) => s.toLowerCase().includes(needle));
    return ORDER.map((c) => ({ c, items: parts.filter((d) => d.category === c && hit(d)) })).filter((g) => g.items.length);
  }, [parts, q]);
  const flat = groups.flatMap((g) => g.items);
  const count = flat.length;
  // The roving item: the cursor if still listed, else the picked part, else the first.
  const active = flat.find((d) => d.id === cursor) ?? flat.find((d) => d.id === selected) ?? flat[0];
  const optId = (id: string) => `${uid}-opt-${id}`;

  const focusItem = (id: string) => {
    setCursor(id);
    requestAnimationFrame(() => {
      const el = document.getElementById(optId(id));
      el?.focus();
      el?.scrollIntoView({ block: "nearest" });
    });
  };

  const pick = (id: string) => {
    onPick(id);
    // Hand focus to the schematic so the part can be placed from the keyboard.
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".canvas-wrap svg")?.focus());
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!active) return;
    const i = flat.indexOf(active);
    const to = e.key === "ArrowDown" ? flat[Math.min(count - 1, i + 1)]
      : e.key === "ArrowUp" ? flat[Math.max(0, i - 1)]
      : e.key === "Home" ? flat[0]
      : e.key === "End" ? flat[count - 1]
      : e.key === "PageDown" ? flat[Math.min(count - 1, i + 10)]
      : e.key === "PageUp" ? flat[Math.max(0, i - 10)]
      : null;
    if (to) { e.preventDefault(); focusItem(to.id); return; }
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(active.id); }
  };

  return (
    <div className="pane">
      <div className="pane-bar">
        <input
          className="search"
          type="search"
          aria-label="Search parts"
          aria-controls={`${uid}-list`}
          placeholder="Search parts…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "ArrowDown" && active) { e.preventDefault(); focusItem(active.id); } }}
          data-pane-focus
        />
        <button className="btn" onClick={onImport} title="Import a part from a PDF datasheet with Claude">+ Datasheet</button>
      </div>
      <div className="sr-only" role="status">{q.trim() ? `${count} ${count === 1 ? "part" : "parts"} found` : ""}</div>
      <div className="scroll" ref={list} id={`${uid}-list`} role="listbox" aria-label="Parts library" onKeyDown={onKey}>
        {groups.map(({ c, items }) => (
          <div key={c} role="group" aria-labelledby={`${uid}-cat-${c}`}>
            <div className="cat" id={`${uid}-cat-${c}`} role="presentation">{LABEL[c]}</div>
            {items.map((d) => {
              const tags = [d.source?.kind === "datasheet" ? "imported from a datasheet by AI" : "", d.model.kind === "emulator" ? "emulated sensor" : ""].filter(Boolean);
              return (
                <div
                  key={d.id}
                  id={optId(d.id)}
                  role="option"
                  aria-selected={selected === d.id}
                  aria-description={[d.description, ...tags].filter(Boolean).join(". ")}
                  tabIndex={active?.id === d.id ? 0 : -1}
                  className={`part-item${selected === d.id ? " selected" : ""}`}
                  onClick={() => { setCursor(d.id); onPick(d.id); }}
                  title={d.description}
                >
                  <span>{d.name}</span>
                  {d.source?.kind === "datasheet" && <span className="tag" aria-hidden>AI</span>}
                  {d.model.kind === "emulator" && <span className="tag" aria-hidden title="Emulated by a backing microcontroller; readings are set in the Sensor Emulator">SIM</span>}
                </div>
              );
            })}
          </div>
        ))}
        {count === 0 && <div className="desc" style={{ padding: 8 }}>No parts match.</div>}
      </div>
    </div>
  );
}
