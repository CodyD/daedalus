import type { ComponentDef } from "../../shared/component";
import type { Project } from "../../shared/project";
import type { DaedalusApi } from "../../preload";

declare global {
  interface Window {
    daedalus?: DaedalusApi;
  }
}

// The renderer also runs in a plain browser (vite dev server) for quick UI
// work: file dialogs and datasheet import need the desktop app, everything
// else (editor, simulation, examples) works.
const exampleFiles = import.meta.glob("../../../examples/*.dad", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const LIB_KEY = "daedalus.library";
const desktopOnly = () => Promise.reject(new Error("This needs the desktop app (npm run dev)."));

function readLib(): ComponentDef[] {
  try {
    return JSON.parse(localStorage.getItem(LIB_KEY) ?? "[]");
  } catch {
    return [];
  }
}

const browserApi: DaedalusApi = {
  listLibrary: async () => readLib(),
  savePart: async (def) => {
    try {
      localStorage.setItem(LIB_KEY, JSON.stringify([...readLib().filter((d) => d.id !== def.id), def]));
    } catch { /* storage unavailable */ }
    return true;
  },
  deletePart: async (id) => {
    try {
      localStorage.setItem(LIB_KEY, JSON.stringify(readLib().filter((d) => d.id !== id)));
    } catch { /* storage unavailable */ }
    return true;
  },
  revealLibrary: desktopOnly,
  openDatasheet: desktopOnly,
  openProject: desktopOnly,
  openProjectPath: desktopOnly,
  recentProjects: async () => [],
  saveProject: desktopOnly,
  pickFile: desktopOnly,
  readFile: async () => null,
  listExamples: async () => Object.entries(exampleFiles).map(([path, text]) => ({
    file: path.split("/").pop()!, project: JSON.parse(text) as Project,
  })),
  pickDatasheet: desktopOnly,
  estimateImport: desktopOnly,
  importDatasheet: desktopOnly,
  cancelImport: async () => true,
  onImportProgress: () => () => {},
  assistantSend: desktopOnly,
  assistantCancel: async () => {},
  assistantReset: async () => {},
  assistantResult: async () => {},
  onAssistantEvent: () => () => {},
  onAssistantExec: () => () => {},
  getSettings: async () => ({
    keySource: "sdk-default", encryption: false, provider: "api", providerSetting: "auto", claudeCode: { path: null, version: null },
  }),
  setProvider: desktopOnly,
  setApiKey: desktopOnly,
  setTheme: async () => {},
  setZoom: (f) => { document.documentElement.style.setProperty("zoom", String(f)); },
};

export const api = (): DaedalusApi => window.daedalus ?? browserApi;
