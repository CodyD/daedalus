import { useEffect, useId, useState } from "react";
import type { AppSettings } from "../../preload";
import { A11yOptions, ZOOMS, arrowNav } from "./a11y";
import { api } from "./api";
import { Dialog } from "./Dialog";
import { Layout, PANELS, PANEL_TITLES, defaultLayout, isVisible, setHidden } from "./dock/layout";
import type { ThemeSetting } from "./theme";

/** Per-machine schematic view preferences (kept in localStorage). */
export interface ViewOptions {
  showLabels: boolean;
  showLinks: boolean;
}

export function loadViewOptions(): ViewOptions {
  try {
    return {
      showLabels: localStorage.getItem("daedalus.showLabels") !== "0",
      showLinks: localStorage.getItem("daedalus.showLinks") === "1",
    };
  } catch {
    return { showLabels: true, showLinks: false };
  }
}

export function saveViewOptions(v: ViewOptions): void {
  try {
    localStorage.setItem("daedalus.showLabels", v.showLabels ? "1" : "0");
    localStorage.setItem("daedalus.showLinks", v.showLinks ? "1" : "0");
  } catch { /* storage unavailable */ }
}

interface Props {
  view: ViewOptions;
  onView: (v: ViewOptions) => void;
  theme: ThemeSetting;
  onTheme: (t: ThemeSetting) => void;
  layout: Layout;
  onLayout: (l: Layout) => void;
  a11y: A11yOptions;
  onA11y: (o: A11yOptions) => void;
  onClose: () => void;
}

type Page = "environment" | "a11y" | "windows" | "schematic" | "ai";
const PAGES: [Page, string][] = [
  ["environment", "General"], ["a11y", "Accessibility"], ["windows", "Tool Windows"], ["schematic", "Schematic"], ["ai", "AI Provider"],
];

export function SettingsDialog({ view, onView, theme, onTheme, layout, onLayout, a11y, onA11y, onClose }: Props) {
  const [page, setPage] = useState<Page>("environment");
  const uid = useId();
  const f = (name: string) => `${uid}-${name}`;
  const [info, setInfo] = useState<AppSettings | null>(null);
  const [key, setKey] = useState("");
  const [claudePath, setClaudePath] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = () => api().getSettings().then((s) => { setInfo(s); setClaudePath((p) => p || s.claudeCode.path || ""); });
  useEffect(() => { refresh(); }, []);

  const keySource = info?.keySource === "settings" ? "saved in this app (encrypted with the OS key store)"
    : info?.keySource === "env" ? "ANTHROPIC_API_KEY environment variable"
    : "none found (SDK will also try ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile)";

  const setProvider = async (p: AppSettings["providerSetting"]) => {
    try {
      await api().setProvider(p, claudePath.trim());
      setMsg(null);
      refresh();
    } catch (e) {
      setMsg(String(e));
    }
  };

  return (
    <Dialog title="Options" onClose={onClose} className="options" style={{ width: 720 }}>
        <div className="options-body">
          <div className="options-nav" role="tablist" aria-orientation="vertical" aria-label="Option pages"
            onKeyDown={(e) => {
              arrowNav(e, "[role=tab]", "y");
              const id = (document.activeElement as HTMLElement)?.dataset.page as Page | undefined;
              if (id && id !== page) setPage(id);
            }}>
            {PAGES.map(([id, label]) => (
              <button key={id} id={f(`tab-${id}`)} data-page={id} role="tab" aria-selected={page === id} aria-controls={f("page")}
                tabIndex={page === id ? 0 : -1} className={page === id ? "active" : undefined} onClick={() => setPage(id)}>{label}</button>
            ))}
          </div>
          <div className="options-page" id={f("page")} role="tabpanel" aria-labelledby={f(`tab-${page}`)}>
            {page === "environment" && (
              <div className="field">
                <label htmlFor={f("theme")}>Color theme</label>
                <select id={f("theme")} value={theme} onChange={(e) => onTheme(e.target.value as ThemeSetting)}>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                  <option value="high-contrast">High contrast</option>
                  <option value="system">Use system setting</option>
                </select>
                <div className="desc">"Use system setting" also switches to high contrast when Windows high contrast mode is on.</div>
              </div>
            )}

            {page === "a11y" && <>
              <div className="field">
                <label htmlFor={f("zoom")}>Text and interface size</label>
                <select id={f("zoom")} value={a11y.zoom} onChange={(e) => onA11y({ ...a11y, zoom: Number(e.target.value) })} aria-describedby={f("zoom-d")}>
                  {ZOOMS.map((z) => <option key={z} value={z}>{Math.round(z * 100)}%{z === 1 ? " (default)" : ""}</option>)}
                </select>
                <div className="desc" id={f("zoom-d")}>Ctrl+Plus and Ctrl+Minus change it from anywhere; Ctrl+0 resets it.</div>
              </div>
              <fieldset>
                <legend>Display</legend>
                <label className="check">
                  <input type="checkbox" checked={theme === "high-contrast"} onChange={(e) => onTheme(e.target.checked ? "high-contrast" : "system")} />
                  High contrast theme
                </label>
                <label className="check">
                  <input type="checkbox" checked={a11y.colorSafe} onChange={(e) => onA11y({ ...a11y, colorSafe: e.target.checked })} aria-describedby={f("safe-d")} />
                  Colour-blind safe palette
                </label>
                <div className="desc" id={f("safe-d")}>Wires, logic levels and scope traces use colours that stay distinct with colour vision deficiency, and a LOW pin state is drawn hollow.</div>
                <label className="check">
                  <input type="checkbox" checked={a11y.reduceMotion} onChange={(e) => onA11y({ ...a11y, reduceMotion: e.target.checked })} />
                  Reduce motion (no pulsing or animated indicators)
                </label>
              </fieldset>
              <fieldset>
                <legend>Screen reader</legend>
                <label className="check">
                  <input type="checkbox" checked={a11y.announce} onChange={(e) => onA11y({ ...a11y, announce: e.target.checked })} aria-describedby={f("ann-d")} />
                  Announce selection and simulation changes
                </label>
                <div className="desc" id={f("ann-d")}>
                  On the schematic: N / Shift+N select parts, arrows move them, I describes the selection and its pins, Enter or Space
                  operates buttons and switches while simulating. F6 moves between the schematic and tool windows; Alt or F10 opens the menus.
                </div>
              </fieldset>
            </>}

            {page === "windows" && (
              <fieldset>
                <legend>Show these tool windows</legend>
                {PANELS.map((id) => (
                  <label key={id} className="check">
                    <input type="checkbox" checked={isVisible(layout, id)} onChange={(e) => onLayout(setHidden(layout, id, !e.target.checked))} />
                    {PANEL_TITLES[id]}
                  </label>
                ))}
                <div className="desc">Drag a tool window's title bar or tab to move it. Drop it on a docking guide to dock it, or anywhere else to float it. The splitters between windows can also be focused with Tab and moved with the arrow keys.</div>
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn" onClick={() => onLayout(defaultLayout())}>Reset Window Layout</button>
                </div>
              </fieldset>
            )}

            {page === "schematic" && (
              <fieldset>
                <legend>Schematic view</legend>
                <label className="check">
                  <input type="checkbox" checked={view.showLabels} onChange={(e) => onView({ ...view, showLabels: e.target.checked })} aria-describedby={f("labels-d")} />
                  Show net labels
                </label>
                <div className="desc" id={f("labels-d")}>Off: labels are hidden and their nets are drawn as wires straight between the component pins.</div>
              </fieldset>
            )}

            {page === "ai" && <>
              <div className="field">
                <label htmlFor={f("provider")}>AI provider (datasheet import and design assistant)</label>
                <select id={f("provider")} value={info?.providerSetting ?? "auto"} onChange={(e) => setProvider(e.target.value as AppSettings["providerSetting"])}>
                  <option value="auto">Automatic: Claude Code if installed and no API key is set</option>
                  <option value="claude-code">Claude Code: use my local `claude` CLI and its login</option>
                  <option value="api">Claude API: use an API key</option>
                </select>
                {info && <div className="desc">Active: <b>{info.provider === "claude-code" ? "Claude Code" : "Claude API"}</b></div>}
              </div>

              <div className="field">
                <label htmlFor={f("claude")}>Claude Code</label>
                <div className="desc" id={f("claude-d")}>
                  {info?.claudeCode.path
                    ? <>Found <code>{info.claudeCode.path}</code>{info.claudeCode.version ? ` (${info.claudeCode.version})` : ""}. Usage counts against your Claude Code plan; your hooks, CLAUDE.md files and MCP servers are not loaded for these runs.</>
                    : "Not found. Install Claude Code and sign in (run `claude` once), or give the path to the executable below."}
                </div>
                <div className="row">
                  <input id={f("claude")} aria-describedby={f("claude-d")} value={claudePath} onChange={(e) => setClaudePath(e.target.value)} placeholder="Path to claude / claude.exe (optional)" />
                  <button className="btn" onClick={() => setProvider(info?.providerSetting ?? "auto")}>Use path</button>
                </div>
              </div>

              <div className="field">
                <label htmlFor={f("key")}>Anthropic API key</label>
                <div className="desc" id={f("key-d")}>Current: {keySource}</div>
                <input id={f("key")} aria-describedby={f("key-d")} type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…" />
              </div>
              <div className="row">
                {info?.keySource === "settings" && (
                  <button className="btn danger" onClick={async () => { await api().setApiKey(null); setMsg("Removed saved key."); refresh(); }}>Remove saved key</button>
                )}
                <button className="btn" disabled={!key.trim()} onClick={async () => {
                  try {
                    await api().setApiKey(key.trim());
                    setKey("");
                    setMsg("Key saved.");
                    refresh();
                  } catch (e) {
                    setMsg(String(e));
                  }
                }}>Save key</button>
              </div>
              <div className="desc" role="status">{msg}</div>
            </>}
          </div>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={onClose}>OK</button>
        </div>
    </Dialog>
  );
}
