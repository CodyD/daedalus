import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentDef } from "../../shared/component";
import { BUILTIN_LIBRARY } from "../../shared/library";
import { decodeHistory, encodeHistory, stripHistory } from "../../shared/history";
import { Project, buildNetlist, emptyProject, nextRef } from "../../shared/project";
import type { Rotation } from "../../shared/symbols";
import { api } from "./api";
import { A11yOptions, announce, applyA11y, arrowNav, loadA11y, saveA11y, stepZoom } from "./a11y";
import { Dialog } from "./Dialog";
import { AssistantPanel, ChatItem, applyEvent, pickDatasheetPath } from "./assistant/AssistantPanel";
import { ExecContext, executeTool } from "./assistant/executor";
import type { runHeadless } from "../../sim/headless";
import { CpuView, EmulatorView, FirmwareView, LogLine, LogView, ScopeView, TerminalView } from "./ToolWindows";
import { controlProp } from "../../sim/mcu/avr/emulator";
import { DockHost } from "./dock/DockHost";
import { Layout, PANELS, PANEL_TITLES, PanelId, activate, defaultLayout, isVisible, loadLayout, saveLayout, setHidden } from "./dock/layout";
import { Icon, Menu, MenuBar } from "./MenuBar";
import { ThemeSetting, applyTheme, loadTheme, saveTheme } from "./theme";
import { resolveFiles } from "./firmware";
import { ImportDialog } from "./ImportDialog";
import { BomDialog } from "./BomDialog";
import { KicadDialog } from "./KicadDialog";
import { ConsolidateDialog } from "./ConsolidateDialog";
import { InventoryDialog } from "./InventoryDialog";
import type { Profile } from "../../shared/inventory";
import { Inspector } from "./Inspector";
import { PartBrowser } from "./PartBrowser";
import { Mode, Schematic, Selection } from "./Schematic";
import { AssistantPhase, BUILD_REQUEST } from "../../main/assistant-prompt";
import { OptionsPage, SettingsDialog, ViewOptions, loadViewOptions, saveViewOptions } from "./SettingsDialog";
import type { Frame, FromWorker, ToWorker } from "./sim.worker";

type SimState = "stopped" | "running" | "paused";

const SPEEDS = [0.01, 0.1, 0.5, 1, 2, 10];

export function App() {
  const [project, setProject] = useState<Project>(emptyProject);
  const [path, setPath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [userParts, setUserParts] = useState<ComponentDef[]>([]);
  const [viewOpts, setViewOpts] = useState<ViewOptions>(loadViewOptions);
  const changeView = (v: ViewOptions) => { setViewOpts(v); saveViewOptions(v); };
  const [mode, setMode] = useState<Mode>({ kind: "select" });
  const [selection, setSelection] = useState<Selection>(null);
  const [libPick, setLibPick] = useState<string | null>(null);
  const [simState, setSimState] = useState<SimState>("stopped");
  const [frame, setFrame] = useState<Frame | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [speed, setSpeed] = useState(1);
  const [dialog, setDialog] = useState<"import" | "settings" | "examples" | "bom" | "consolidate" | "inventory" | "kicad" | null>(null);
  /** Dialog to return to when the current one closes (Parts List -> Consolidate / Options). */
  const [dialogBack, setDialogBack] = useState<"bom" | "kicad" | null>(null);
  const [optionsPage, setOptionsPage] = useState<OptionsPage | undefined>();
  const closeDialog = () => { setDialog(dialogBack); setDialogBack(null); setOptionsPage(undefined); };
  const [examples, setExamples] = useState<{ file: string; project: Project }[]>([]);
  const workerRef = useRef<Worker | null>(null);
  const [layout, setLayout] = useState<Layout>(loadLayout);
  useEffect(() => saveLayout(layout), [layout]);
  const [reveal, setReveal] = useState<{ id: PanelId; n: number } | undefined>();
  /** Opens a tool window and brings it to the front (sliding out an auto-hidden one). */
  const showPanel = (id: PanelId) => { setLayout((l) => activate(l, id)); setReveal({ id, n: Date.now() }); };
  const [emuTarget, setEmuTarget] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeSetting>(loadTheme);
  useEffect(() => applyTheme(theme), [theme]);
  const [a11y, setA11y] = useState<A11yOptions>(loadA11y);
  useEffect(() => { applyA11y(a11y, api().setZoom); saveA11y(a11y); }, [a11y]);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatPhase, setChatPhase] = useState<AssistantPhase>("interview");
  const projectRef = useRef(project);
  projectRef.current = project;
  const pendingUi = useRef(new Map<string, (v: unknown) => void>());
  /** Output is brought forward once per run, on the first warning. */
  const warnedRef = useRef(false);

  useEffect(() => { api().listLibrary().then(setUserParts); }, []);
  /** Active user profile; its inventory feeds the parts list and the AI assistant. */
  const [profile, setProfile] = useState<Profile | null>(null);
  useEffect(() => { api().activeProfile().then(setProfile).catch(() => {}); }, []);

  const defs = useMemo(() => {
    const m = new Map<string, ComponentDef>();
    for (const d of BUILTIN_LIBRARY) m.set(d.id, d);
    for (const d of project.embeddedParts ?? []) m.set(d.id, d);
    for (const d of userParts) m.set(d.id, d);
    return m;
  }, [userParts, project.embeddedParts]);
  const allParts = useMemo(() => [...defs.values()], [defs]);
  const defsRef = useRef(defs);
  defsRef.current = defs;

  const { netlist, wireNets, pinNets } = useMemo(() => buildNetlist(project, defs), [project, defs]);

  // --- undo / redo -----------------------------------------------------------
  // Snapshots of the whole project. Edits sharing a `group` (one drag, typing in
  // one property field) collapse into a single undo step.
  const past = useRef<Project[]>([]);
  const future = useRef<Project[]>([]);
  const lastGroup = useRef<string | null>(null);
  const [, setHistoryRev] = useState(0);
  const commit = useCallback((next: Project, group?: string) => {
    const prev = projectRef.current;
    if (next === prev) return;
    if (!group || group !== lastGroup.current) {
      past.current.push(prev);
      if (past.current.length > 200) past.current.shift();
    }
    lastGroup.current = group ?? null;
    future.current = [];
    projectRef.current = next;
    setProject(next);
    setDirty(true);
    setHistoryRev((r) => r + 1);
  }, []);
  const change = useCallback((fn: (p: Project) => Project, group?: string) => commit(fn(projectRef.current), group), [commit]);
  const travel = (from: { current: Project[] }, to: { current: Project[] }) => {
    const p = from.current.pop();
    if (!p) return;
    to.current.push(projectRef.current);
    lastGroup.current = null;
    projectRef.current = p;
    setProject(p);
    setDirty(true);
    setHistoryRev((r) => r + 1);
    setSelection((s) => (s?.kind === "part" && !p.parts.some((q) => q.ref === s.ref)) || (s?.kind === "wire" && !p.wires.some((w) => w.id === s.id)) ? null : s);
  };
  const undo = () => travel(past, future);
  const redo = () => travel(future, past);
  /** Start a fresh history (new / opened / example project). */
  const resetHistory = () => { past.current = []; future.current = []; lastGroup.current = null; setHistoryRev((r) => r + 1); };

  const place = (defId: string, x: number, y: number, rot: Rotation) => {
    const def = defs.get(defId);
    if (!def) return;
    const ref = nextRef(project, def.refPrefix);
    change((p) => {
      // Imported parts travel with the project so it opens on other machines.
      const embedded = (def.source?.kind === "datasheet" || def.source?.kind === "emulated") && !(p.embeddedParts ?? []).some((d) => d.id === def.id)
        ? [...(p.embeddedParts ?? []), def] : p.embeddedParts;
      return { ...p, embeddedParts: embedded, parts: [...p.parts, { ref, defId, x, y, rot, props: {} }] };
    });
    setSelection({ kind: "part", ref });
  };

  // --- simulation -----------------------------------------------------------

  const post = (m: ToWorker) => workerRef.current?.postMessage(m);

  const stop = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setFrame(null);
    setSimState("stopped");
  }, []);

  const start = async () => {
    if (simState === "paused") {
      post({ type: "resume" });
      setSimState("running");
      return;
    }
    const { netlist: resolved, problems } = await resolveFiles(netlist, project);
    const startLogs: LogLine[] = problems.map((p) => ({
      time: 0, level: "error", source: p.ref, message: p.source ? `${p.source}: ${p.message}` : p.message,
    }));
    setLogs(startLogs);
    warnedRef.current = false;
    if (problems.some((p) => p.source)) {
      showPanel("firmware");
      return;
    }
    const w = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === "error") {
        setLogs((l) => [...l, { time: 0, level: "error", source: "simulator", message: m.message }]);
        setSimState("paused");
        return;
      }
      setFrame(m);
      if (m.logs.length) {
        setLogs((l) => [...l, ...m.logs].slice(-1000));
        if (m.logs.some((x) => x.level !== "info") && !warnedRef.current) { warnedRef.current = true; showPanel("output"); }
      }
      if (!m.running) setSimState((s) => (s === "running" && m.failed ? "paused" : s));
    };
    workerRef.current = w;
    w.postMessage({ type: "speed", value: speed } satisfies ToWorker);
    w.postMessage({ type: "start", netlist: resolved } satisfies ToWorker);
    setSimState("running");
    setMode({ kind: "select" });
  };

  const pause = () => { post({ type: "pause" }); setSimState("paused"); };
  const step = async () => {
    if (simState === "stopped") {
      await start();
      post({ type: "pause" });
      setSimState("paused");
      return;
    }
    post({ type: "step", dt: 0.01 });
    setSimState("paused");
  };
  const actuate = (ref: string, action: Record<string, unknown>) => post({ type: "actuate", ref, action });
  const openEmulator = (ref: string) => { setEmuTarget(ref); showPanel("emulator"); };
  /** A sensor emulator control moved: remember it on the part, and tell a running simulation. */
  const setControl = (ref: string, key: string, value: number) => {
    change((p) => ({ ...p, parts: p.parts.map((q) => (q.ref === ref ? { ...q, props: { ...q.props, [controlProp(key)]: String(value) } } : q)) }), `ctl:${ref}.${key}`);
    if (simState !== "stopped") actuate(ref, { control: key, value });
  };

  useEffect(() => stop, [stop]);
  useEffect(() => { post({ type: "speed", value: speed }); }, [speed]);

  // --- design assistant -------------------------------------------------------

  useEffect(() => api().onAssistantEvent((ev) => {
    setChat((c) => applyEvent(c, ev));
    if (ev.type === "done" || ev.type === "error") setChatBusy(false);
  }), []);

  useEffect(() => {
    let queue = Promise.resolve();
    const ask = <T,>(item: (key: string) => ChatItem): Promise<T> => new Promise((resolve) => {
      const key = `${Date.now()}-${Math.random()}`;
      pendingUi.current.set(key, resolve as (v: unknown) => void);
      setChat((c) => [...c, item(key)]);
    });
    const ctx: ExecContext = {
      getProject: () => projectRef.current,
      // Each assistant edit is its own undo step; commit keeps the ref current
      // synchronously since tools in one turn run back to back.
      setProject: (p) => commit(p),
      defs: () => defsRef.current,
      resolveFiles,
      simulate: (netlist, opts) => new Promise<ReturnType<typeof runHeadless>>((resolve, reject) => {
        const w = new Worker(new URL("./assistant/headless.worker.ts", import.meta.url), { type: "module" });
        w.onmessage = (e) => {
          w.terminate();
          if (e.data.ok) resolve(e.data.report);
          else reject(new Error(e.data.error));
        };
      w.postMessage({ netlist, opts });
      }),
      askApproval: (req) => ask<boolean>((key) => ({ kind: "approval", key, req, state: "pending" })),
      askFile: (req) => ask<string | null>((key) => ({ kind: "file", key, part: req.part_number, reason: req.reason, state: "pending" })),
      libraryChanged: async () => {
        const lib = await api().listLibrary();
        defsRef.current = new Map([...defsRef.current, ...lib.map((d) => [d.id, d] as const)]);
        setUserParts(lib);
      },
      savePart: async (def) => {
        await api().savePart(def);
        // Keep copies embedded in the open project (placed earlier) in step with the library.
        const p = projectRef.current;
        if (p.embeddedParts?.some((d) => d.id === def.id)) {
          commit({ ...p, embeddedParts: p.embeddedParts.map((d) => (d.id === def.id ? def : d)) });
        }
        await ctx.libraryChanged();
      },
    };
    return api().onAssistantExec((req) => {
      queue = queue.then(async () => {
        const result = await executeTool(req.name, req.input, ctx);
        await api().assistantResult(req.id, result);
      });
    });
  }, []);

  const answerUi = async (key: string, kind: "approval" | "file", yes: boolean) => {
    const resolve = pendingUi.current.get(key);
    if (!resolve) return;
    pendingUi.current.delete(key);
    if (kind === "approval") {
      setChat((c) => c.map((it) => (it.kind === "approval" && it.key === key ? { ...it, state: yes ? "approved" : "declined" } : it)));
      resolve(yes);
    } else {
      const path = yes ? await pickDatasheetPath() : null;
      setChat((c) => c.map((it) => (it.kind === "file" && it.key === key ? { ...it, state: path ? "picked" : "skipped" } : it)));
      resolve(path);
    }
  };

  const sendChat = async (text: string, phase = chatPhase, shown = text) => {
    if (simState !== "stopped") stop();
    setChat((c) => [...c, { kind: "user", text: shown }]);
    setChatBusy(true);
    try {
      if (!(await api().assistantSend(text, phase))) setChatBusy(false);
    } catch (e) {
      setChat((c) => [...c, { kind: "error", text: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") }]);
      setChatBusy(false);
    }
  };

  const cancelChat = async () => {
    for (const r of pendingUi.current.values()) r(null);
    pendingUi.current.clear();
    await api().assistantCancel();
    setChatBusy(false);
  };

  // --- files ------------------------------------------------------------------

  const confirmDiscard = () => !dirty || confirm("Discard unsaved changes?");
  const newProject = () => { if (!confirmDiscard()) return; stop(); setProject(emptyProject()); resetHistory(); setPath(null); setDirty(false); setSelection(null); };
  const load = (r: { path: string; project: Project }) => {
    stop();
    const h = decodeHistory(r.project.history);
    setProject(stripHistory(r.project));
    resetHistory();
    past.current = h.past;
    future.current = h.future;
    setPath(r.path);
    setDirty(false);
    setSelection(null);
  };
  const open = async () => {
    if (!confirmDiscard()) return;
    const r = await api().openProject();
    if (r) load(r);
  };
  const [recent, setRecent] = useState<string[]>([]);
  const openRecent = async (file: string) => {
    if (!confirmDiscard()) return;
    try { load(await api().openProjectPath(file)); } catch (e) { alert(`Could not open ${file}: ${(e as Error).message}`); }
  };
  const save = async (as = false) => {
    const history = encodeHistory(past.current, future.current);
    const target = await api().saveProject(history ? { ...project, history } : project, as ? undefined : path ?? undefined);
    if (target) { setPath(target); setDirty(false); }
  };
  const openExamples = async () => { setExamples(await api().listExamples()); setDialog("examples"); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "s") { e.preventDefault(); save(e.shiftKey); }
      if (e.ctrlKey && e.key === "o") { e.preventDefault(); open(); }
      if (e.ctrlKey && !e.altKey && ["=", "+", "-", "_", "0"].includes(e.key)) {
        e.preventDefault();
        const z = stepZoom(a11y.zoom, e.key === "0" ? 0 : e.key === "-" || e.key === "_" ? -1 : 1);
        setA11y({ ...a11y, zoom: z });
        announce(`Zoom ${Math.round(z * 100)}%`);
      }
      // Inside text fields, leave Ctrl+Z / Ctrl+Y to the field's own undo.
      const inField = (e.target as HTMLElement)?.closest?.("input, textarea, select, .cm-editor");
      if (e.ctrlKey && !inField && !simulating) {
        const k = e.key.toLowerCase();
        if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
        if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
      }
      if (e.key === "F12") { e.preventDefault(); simState === "running" ? pause() : start(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const simulating = simState !== "stopped";
  const selPart = selection?.kind === "part" ? selection.ref : null;

  // Screen reader: say when the simulation starts, pauses, stops or fails.
  const firstState = useRef(true);
  useEffect(() => {
    if (firstState.current) { firstState.current = false; return; }
    announce(simState === "running" ? "Simulation running" : simState === "paused" ? "Simulation paused" : "Simulation stopped");
  }, [simState]);
  useEffect(() => { if (frame?.failed) announce("Simulation failed. See the Output window.", true); }, [frame?.failed]);
  const timeStr = `${(frame?.time ?? 0).toFixed(1)} s`;
  const slow = frame && simState === "running" && frame.load >= 0.99 && frame.rate < speed * 0.9;

  const byBuiltin = (b: string) => project.parts.filter((q) => defs.get(q.defId)?.model.builtin === b).map((q) => q.ref);
  const warnCount = logs.filter((l) => l.level !== "info").length;

  const renderPanel = (id: PanelId) => {
    switch (id) {
      case "parts":
        return (
          <PartBrowser
            parts={allParts}
            selected={libPick}
            onPick={(pick) => {
              setLibPick(pick);
              setSelection(null);
              if (!simulating) setMode({ kind: "place", defId: pick, rot: 0 });
            }}
            onImport={() => setDialog("import")}
          />
        );
      case "properties":
        return (
          <div className="scroll">
            <Inspector
              project={project}
              defs={defs}
              selection={selection}
              libraryPick={libPick ? defs.get(libPick) ?? null : null}
              wireNets={wireNets}
              pinNets={pinNets}
              simulating={simulating}
              indicate={selPart ? (frame?.indicate[selPart] as Record<string, unknown> | undefined) : undefined}
              onProps={(ref, props) => change((p) => ({ ...p, parts: p.parts.map((q) => (q.ref === ref ? { ...q, props } : q)) }), `props:${ref}`)}
              onActuate={actuate}
              onDeleteLibraryPart={async (id) => {
                await api().deletePart(id);
                setUserParts(await api().listLibrary());
                setLibPick(null);
              }}
            />
          </div>
        );
      case "assistant":
        return (
          <AssistantPanel
            items={chat}
            busy={chatBusy}
            phase={chatPhase}
            onSend={(t) => sendChat(t)}
            onBuild={() => { setChatPhase("build"); sendChat(BUILD_REQUEST, "build", "Build"); }}
            onCancel={cancelChat}
            onReset={async () => { await api().assistantReset(); setChat([]); setChatPhase("interview"); }}
            onApproval={(k, yes) => answerUi(k, "approval", yes)}
            onFile={(k, yes) => answerUi(k, "file", yes)}
          />
        );
      case "emulator":
        return (
          <div className="panel">
            <EmulatorView
              parts={project.parts.flatMap((q) => {
                const def = defs.get(q.defId);
                return def?.model.kind === "emulator" ? [{ ref: q.ref, def, props: q.props }] : [];
              })}
              target={emuTarget ?? (selPart && defs.get(project.parts.find((q) => q.ref === selPart)?.defId ?? "")?.model.kind === "emulator" ? selPart : null)}
              onTarget={setEmuTarget}
              frame={frame}
              onControl={setControl}
            />
          </div>
        );
      case "output": return <div className="panel"><LogView logs={logs} /></div>;
      case "terminal": return <div className="panel"><TerminalView refs={byBuiltin("vterm")} frame={frame} onActuate={actuate} /></div>;
      case "scope": return <div className="panel"><ScopeView refs={byBuiltin("scope")} frame={frame} /></div>;
      case "cpu": return <div className="panel"><CpuView refs={project.parts.filter((q) => defs.get(q.defId)?.model.kind === "mcu").map((q) => q.ref)} frame={frame} /></div>;
      case "firmware": return <div className="panel"><FirmwareView sources={project.sources ?? {}} onSources={(sources) => change((p) => ({ ...p, sources }), "sources")} /></div>;
    }
  };

  const fileName = (f: string) => f.slice(Math.max(f.lastIndexOf("\\"), f.lastIndexOf("/")) + 1);
  const menus: Menu[] = [
    {
      label: "File",
      onOpen: () => { api().recentProjects().then(setRecent); },
      items: [
        { label: "New Schematic", onClick: newProject, disabled: simulating },
        { label: "Open…", shortcut: "Ctrl+O", onClick: open, disabled: simulating },
        {
          label: "Recent Schematics", disabled: simulating,
          submenu: recent.length ? recent.map((f) => ({ label: fileName(f), title: f, onClick: () => openRecent(f) })) : [{ label: "(none)", disabled: true }],
        },
        { label: "Examples…", onClick: openExamples, disabled: simulating },
        { sep: true },
        { label: "Save", shortcut: "Ctrl+S", onClick: () => save() },
        { label: "Save As…", shortcut: "Ctrl+Shift+S", onClick: () => save(true) },
        { sep: true },
        { label: "Export to KiCad PCB…", onClick: () => setDialog("kicad"), title: "Netlist with footprints for KiCad's PCB Editor" },
      ],
    },
    {
      label: "Edit",
      items: [
        { label: "Undo", shortcut: "Ctrl+Z", onClick: undo, disabled: simulating || !past.current.length },
        { label: "Redo", shortcut: "Ctrl+Y", onClick: redo, disabled: simulating || !future.current.length },
        { sep: true },
        { label: "Select", onClick: () => setMode({ kind: "select" }), checked: mode.kind === "select", disabled: simulating },
        { label: "Wire", onClick: () => setMode({ kind: "wire" }), checked: mode.kind === "wire", disabled: simulating },
      ],
    },
    {
      label: "View",
      items: [
        {
          label: "Label Connections", checked: viewOpts.showLinks, disabled: !viewOpts.showLabels,
          title: viewOpts.showLabels ? "Draw a line between net labels that share a name" : "Turn on net labels in Options first",
          onClick: () => changeView({ ...viewOpts, showLinks: !viewOpts.showLinks }),
        },
        { sep: true },
        ...PANELS.map((id) => ({
          label: PANEL_TITLES[id], checked: isVisible(layout, id),
          onClick: () => (isVisible(layout, id) ? setLayout(setHidden(layout, id, true)) : showPanel(id)),
        })),
        { sep: true },
        { label: "Reset Window Layout", onClick: () => setLayout(defaultLayout()) },
      ],
    },
    {
      label: "Simulate",
      items: [
        { label: simState === "running" ? "Pause" : simState === "paused" ? "Continue" : "Start", shortcut: "F12", onClick: () => (simState === "running" ? pause() : start()) },
        { label: "Step 10 ms", onClick: step },
        { label: "Stop", onClick: stop, disabled: simState === "stopped" },
        { sep: true },
        { label: "Speed", submenu: SPEEDS.map((v) => ({ label: `${v}×`, checked: speed === v, onClick: () => setSpeed(v) })) },
      ],
    },
    {
      label: "Tools",
      items: [
        { label: "Import Datasheet…", onClick: () => setDialog("import"), disabled: simulating },
        { label: "AI Assistant", onClick: () => showPanel("assistant") },
        { sep: true },
        { label: "Parts List…", onClick: () => setDialog("bom"), title: "Bill of materials with Mouser and DigiKey links" },
        { label: "Parts Inventory…", onClick: () => setDialog("inventory"), title: "Parts you already own; the AI assistant uses them where they fit" },
        { label: "Consolidate…", onClick: () => setDialog("consolidate"), disabled: simulating, title: "Combine basic parts into resistor arrays, dual diodes and other multi-unit packages" },
        { sep: true },
        { label: "Options…", onClick: () => setDialog("settings") },
      ],
    },
  ];

  /** A toolbar button. `pressed` makes it a toggle (announced as pressed / not pressed). */
  const tb = (icon: keyof typeof Icon, title: string, onClick: () => void, opts: { disabled?: boolean; checked?: boolean; pressed?: boolean; label?: string } = {}) => (
    <button className={`tb-btn${opts.checked || opts.pressed ? " checked" : ""}`} title={title} aria-label={title}
      aria-pressed={opts.pressed} onClick={onClick} disabled={opts.disabled}>
      {Icon[icon]}{opts.label && <span aria-hidden>{opts.label}</span>}
    </button>
  );
  const docName = path ? fileName(path) : `${project.name}.dad`;
  useEffect(() => { document.title = `${docName}${dirty ? " (unsaved)" : ""} · Daedalus`; }, [docName, dirty]);

  return (
    <div className="app">
      <header className="app-header">
      <h1 className="sr-only">Daedalus, {docName}</h1>
      <MenuBar menus={menus}>
        <div className="spacer" />
        <div className="title-doc" aria-hidden>{docName}{dirty ? "*" : ""} · Daedalus</div>
      </MenuBar>
      <div className="toolbar" role="toolbar" aria-label="Main toolbar" onKeyDown={(e) => (e.target as HTMLElement).tagName !== "SELECT" && arrowNav(e, "button.tb-btn, select")}>
        <div className="tb-group" role="group" aria-label="File">
          {tb("new", "New Schematic", newProject, { disabled: simulating })}
          {tb("open", "Open (Ctrl+O)", open, { disabled: simulating })}
          {tb("save", "Save (Ctrl+S)", () => save())}
        </div>
        <div className="tb-group" role="group" aria-label="History">
          {tb("undo", "Undo (Ctrl+Z)", undo, { disabled: simulating || !past.current.length })}
          {tb("redo", "Redo (Ctrl+Y)", redo, { disabled: simulating || !future.current.length })}
        </div>
        <div className="tb-group" role="group" aria-label="Tool">
          {tb("select", "Select", () => setMode({ kind: "select" }), { disabled: simulating, pressed: mode.kind === "select" })}
          {tb("wire", "Wire (W)", () => setMode({ kind: "wire" }), { disabled: simulating, pressed: mode.kind === "wire" })}
        </div>
        <div className="tb-group" role="group" aria-label="AI">
          {tb("datasheet", "Import a part from a PDF datasheet with Claude", () => setDialog("import"), { disabled: simulating, label: "Import Datasheet" })}
          {tb("assistant", chatBusy ? "AI Assistant (working)" : "AI Assistant", () => showPanel("assistant"), { label: `AI Assistant${chatBusy ? " •" : ""}` })}
        </div>
        <div className="tb-group" role="group" aria-label="Simulation">
          {tb("run", simState === "paused" ? "Continue (F12)" : "Start (F12)", start, { disabled: simState === "running", label: simState === "paused" ? "Continue" : "Start" })}
          {tb("step", "Step 10 ms", step)}
          {tb("pause", "Pause", pause, { disabled: simState !== "running", pressed: simState === "paused" })}
          {tb("stop", "Stop", stop, { disabled: simState === "stopped" })}
          <select className="tb-select" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="Simulation speed" aria-label="Simulation speed">
            {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
        </div>
        <div className="spacer" />
        {tb("options", "Options", () => setDialog("settings"))}
      </div>
      </header>

      <DockHost
        layout={layout}
        onLayout={setLayout}
        render={renderPanel}
        reveal={reveal}
        badge={(id) => (id === "output" && warnCount > 0
          ? <span className="badge"><span aria-hidden>{warnCount}</span><span className="sr-only">, {warnCount} {warnCount === 1 ? "warning" : "warnings"}</span></span>
          : null)}
      >
        <div className="doc-tabs" aria-hidden>
          <div className="doc-tab active" title={path ?? undefined}>{docName}{dirty ? "*" : ""}</div>
        </div>
        <Schematic
          showLabels={viewOpts.showLabels}
          showLinks={viewOpts.showLinks}
          project={project}
          defs={defs}
          mode={mode}
          setMode={setMode}
          selection={selection}
          setSelection={(s) => { setSelection(s); if (s) setLibPick(null); }}
          onChange={change}
          onPlace={place}
          frame={frame}
          wireNets={wireNets}
          pinNets={pinNets}
          onActuate={actuate}
          onEmulator={openEmulator}
        />
      </DockHost>

      <footer className={`statusbar ${simState}`} aria-label="Status">
        <span>{simState === "stopped" ? "Ready" : simState === "paused" ? "Paused" : "Running"}</span>
        {frame?.failed && <span>Simulation failed</span>}
        <div className="spacer" />
        {profile && (
          <button className="status-btn" onClick={() => setDialog("inventory")} title="Open the parts inventory for this profile">
            Profile: {profile.name} ({profile.inventory.length} parts)
          </button>
        )}
        {simState === "running" && <span>{slow ? `${Math.round((frame!.rate / speed) * 100)}% real time` : "Real time"}</span>}
        {simState !== "stopped" && <span className="mono">{timeStr}</span>}
        <span>Speed {speed}×</span>
      </footer>

      {dialog === "import" && (
        <ImportDialog
          existingIds={new Set(defs.keys())}
          onClose={() => setDialog(null)}
          onSaved={async (def, placeIt) => {
            setUserParts(await api().listLibrary());
            setDialog(null);
            setLibPick(def.id);
            if (placeIt) setMode({ kind: "place", defId: def.id, rot: 0 });
          }}
        />
      )}
      {dialog === "settings" && (
        <SettingsDialog
          view={viewOpts}
          onView={changeView}
          theme={theme}
          onTheme={(t) => { setTheme(t); saveTheme(t); }}
          layout={layout}
          onLayout={setLayout}
          a11y={a11y}
          onA11y={setA11y}
          initialPage={optionsPage}
          onClose={closeDialog}
        />
      )}
      {dialog === "bom" && (
        <BomDialog
          project={project}
          defs={defs}
          onChange={change}
          inventory={profile?.inventory ?? []}
          onInventory={() => { setDialogBack("bom"); setDialog("inventory"); }}
          onConsolidate={() => { setDialogBack("bom"); setDialog("consolidate"); }}
          onDistributorOptions={() => { setDialogBack("bom"); setOptionsPage("distributors"); setDialog("settings"); }}
          onClose={closeDialog}
        />
      )}
      {dialog === "kicad" && (
        <KicadDialog project={project} defs={defs} onPartsList={() => { setDialogBack("kicad"); setDialog("bom"); }} onClose={closeDialog} />
      )}
      {dialog === "inventory" && (
        <InventoryDialog project={project} defs={defs} onProfile={setProfile} onClose={closeDialog} />
      )}
      {dialog === "consolidate" && (
        <ConsolidateDialog project={project} defs={defs} onChange={(fn) => { change(fn); setSelection(null); }} onClose={closeDialog} />
      )}
      {dialog === "examples" && (
        <Dialog title="Example circuits" onClose={() => setDialog(null)} style={{ width: 560 }}>
            {examples.length === 0 && <p className="sub">No examples found.</p>}
            {examples.map((ex) => (
              <button key={ex.file} className="btn" style={{ textAlign: "left", padding: "8px 12px" }} onClick={() => {
                if (!confirmDiscard()) return;
                stop();
                setProject(stripHistory(ex.project));
                resetHistory();
                setPath(null);
                setDirty(false);
                setSelection(null);
                setDialog(null);
              }}>
                <b>{ex.project.name}</b><br /><span className="desc">{ex.file}</span>
              </button>
            ))}
            <div className="actions"><button className="btn" onClick={() => setDialog(null)}>Close</button></div>
        </Dialog>
      )}

      {/* Screen reader announcements (see a11y.ts announce()). */}
      <div className="sr-only" aria-live="polite" id="sr-polite-a" />
      <div className="sr-only" aria-live="polite" id="sr-polite-b" />
      <div className="sr-only" role="alert" id="sr-alert" />
    </div>
  );
}
