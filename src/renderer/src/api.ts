import type { ComponentDef } from "../../shared/component";
import type { Project } from "../../shared/project";
import type { DaedalusApi } from "../../preload";
import { DEFAULT_PROFILE_ID, InventoryItem, Profile, newProfile } from "../../shared/inventory";

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
const INV_KEY = "daedalus.inventory";
const desktopOnly = () => Promise.reject(new Error("This needs the desktop app (npm run dev)."));

function readLib(): ComponentDef[] {
  try {
    return JSON.parse(localStorage.getItem(LIB_KEY) ?? "[]");
  } catch {
    return [];
  }
}

/** In the browser there is only the default profile. */
function readProfile(): Profile {
  let inventory: InventoryItem[] = [];
  try {
    inventory = InventoryItem.array().parse(JSON.parse(localStorage.getItem(INV_KEY) ?? "[]"));
  } catch { /* storage unavailable or malformed */ }
  return { ...newProfile(DEFAULT_PROFILE_ID, "Default"), inventory };
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
  saveText: async (text, name) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    return name;
  },
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
    distributors: { mouser: false, digikey: false },
  }),
  setProvider: desktopOnly,
  setApiKey: desktopOnly,
  setDistributorKeys: desktopOnly,
  checkStock: async () => ({ error: "Stock checks need the desktop app (npm run dev)." }),
  listProfiles: async () => ({ active: DEFAULT_PROFILE_ID, profiles: [{ id: DEFAULT_PROFILE_ID, name: "Default", items: readProfile().inventory.length }] }),
  activeProfile: async () => readProfile(),
  switchProfile: async () => readProfile(),
  createProfile: desktopOnly,
  renameProfile: desktopOnly,
  deleteProfile: desktopOnly,
  startPairing: desktopOnly,
  linkedPhones: async () => [],
  unpairPhone: desktopOnly,
  setInventory: async (items) => {
    try { localStorage.setItem(INV_KEY, JSON.stringify(items)); } catch { /* storage unavailable */ }
    return true;
  },
  setTheme: async () => {},
  setZoom: (f) => { document.documentElement.style.setProperty("zoom", String(f)); },
};

export const api = (): DaedalusApi => window.daedalus ?? browserApi;
