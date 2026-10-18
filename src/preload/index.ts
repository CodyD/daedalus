import { contextBridge, ipcRenderer, webFrame } from "electron";
import type { ComponentDef } from "../shared/component";
import type { Project } from "../shared/project";
import type { ImportOutcome, ImportProgress, ImportRequest, PdfInfo } from "../main/datasheet";
import type { AssistantEvent, Provider } from "../main/assistant";
import type { AssistantPhase } from "../main/assistant-prompt";
import type { Distributor, StockAnswer } from "../main/distributors";
import type { InventoryItem, Profile, ProfileSummary } from "../shared/inventory";
import type { LinkedPhone } from "../main/api-client";

export interface AppSettings {
  keySource: "settings" | "env" | "sdk-default";
  encryption: boolean;
  provider: Provider;
  providerSetting: Provider | "auto";
  claudeCode: { path: string | null; version: string | null };
  /** Which distributors have credentials for stock checks. */
  distributors: { mouser: boolean; digikey: boolean };
}

export interface DistributorKeyUpdate {
  mouser?: string | null;
  digikeyId?: string | null;
  digikeySecret?: string | null;
}

export interface ExecRequest {
  id: string;
  name: string;
  input: unknown;
}

const api = {
  listLibrary: (): Promise<ComponentDef[]> => ipcRenderer.invoke("lib:list"),
  savePart: (def: ComponentDef): Promise<boolean> => ipcRenderer.invoke("lib:save", def),
  deletePart: (id: string): Promise<boolean> => ipcRenderer.invoke("lib:delete", id),
  revealLibrary: (): Promise<string> => ipcRenderer.invoke("lib:reveal"),
  openDatasheet: (path: string): Promise<string> => ipcRenderer.invoke("datasheet:open", path),
  openProject: (): Promise<{ path: string; project: Project } | null> => ipcRenderer.invoke("project:open"),
  openProjectPath: (path: string): Promise<{ path: string; project: Project }> => ipcRenderer.invoke("project:openPath", path),
  recentProjects: (): Promise<string[]> => ipcRenderer.invoke("project:recent"),
  saveProject: (project: Project, path?: string): Promise<string | null> => ipcRenderer.invoke("project:save", project, path),
  saveText: (text: string, name: string, filter: { name: string; extensions: string[] }): Promise<string | null> =>
    ipcRenderer.invoke("file:saveText", text, name, filter),
  pickFile: (kind: "hex" | "asm"): Promise<{ path: string; text: string } | null> => ipcRenderer.invoke("file:pick", kind),
  readFile: (path: string): Promise<string | null> => ipcRenderer.invoke("file:read", path),
  listExamples: (): Promise<{ file: string; project: Project }[]> => ipcRenderer.invoke("examples:list"),
  pickDatasheet: (): Promise<PdfInfo | null> => ipcRenderer.invoke("datasheet:pick"),
  estimateImport: (req: ImportRequest): Promise<{ inputTokens: number; costUsd: number; pages: number; subscription: boolean }> =>
    ipcRenderer.invoke("datasheet:estimate", req),
  importDatasheet: (req: ImportRequest): Promise<ImportOutcome> => ipcRenderer.invoke("datasheet:import", req),
  cancelImport: (): Promise<boolean> => ipcRenderer.invoke("datasheet:cancel"),
  onImportProgress: (fn: (p: ImportProgress) => void): (() => void) => {
    const h = (_e: unknown, p: ImportProgress) => fn(p);
    ipcRenderer.on("datasheet:progress", h);
    return () => ipcRenderer.removeListener("datasheet:progress", h);
  },
  assistantSend: (text: string, phase: AssistantPhase): Promise<boolean> => ipcRenderer.invoke("assistant:send", text, phase),
  assistantCancel: (): Promise<void> => ipcRenderer.invoke("assistant:cancel"),
  assistantReset: (): Promise<void> => ipcRenderer.invoke("assistant:reset"),
  assistantResult: (id: string, result: unknown): Promise<void> => ipcRenderer.invoke("assistant:exec-result", id, result),
  onAssistantEvent: (fn: (ev: AssistantEvent) => void): (() => void) => {
    const h = (_e: unknown, ev: AssistantEvent) => fn(ev);
    ipcRenderer.on("assistant:event", h);
    return () => ipcRenderer.removeListener("assistant:event", h);
  },
  onAssistantExec: (fn: (req: ExecRequest) => void): (() => void) => {
    const h = (_e: unknown, req: ExecRequest) => fn(req);
    ipcRenderer.on("assistant:exec", h);
    return () => ipcRenderer.removeListener("assistant:exec", h);
  },
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke("settings:get"),
  setProvider: (provider: Provider | "auto", claudePath?: string): Promise<boolean> => ipcRenderer.invoke("settings:setProvider", provider, claudePath),
  setApiKey: (key: string | null): Promise<boolean> => ipcRenderer.invoke("settings:setKey", key),
  setDistributorKeys: (keys: DistributorKeyUpdate): Promise<boolean> => ipcRenderer.invoke("settings:setDistributorKeys", keys),
  checkStock: (dist: Distributor, query: string): Promise<StockAnswer> => ipcRenderer.invoke("bom:stock", dist, query),
  listProfiles: (): Promise<{ active: string; profiles: ProfileSummary[] }> => ipcRenderer.invoke("profile:list"),
  activeProfile: (): Promise<Profile> => ipcRenderer.invoke("profile:active"),
  switchProfile: (id: string): Promise<Profile> => ipcRenderer.invoke("profile:switch", id),
  createProfile: (name: string): Promise<Profile> => ipcRenderer.invoke("profile:create", name),
  renameProfile: (id: string, name: string): Promise<boolean> => ipcRenderer.invoke("profile:rename", id, name),
  deleteProfile: (id: string): Promise<boolean> => ipcRenderer.invoke("profile:delete", id),
  /** Replaces the active profile's inventory. */
  setInventory: (items: InventoryItem[]): Promise<boolean> => ipcRenderer.invoke("inventory:set", items),
  /** A pairing code for the inventory scanner app, with its QR code as SVG markup. */
  startPairing: (): Promise<{ code: string; expiresAt: string; qrSvg: string }> => ipcRenderer.invoke("pair:start"),
  linkedPhones: (): Promise<LinkedPhone[]> => ipcRenderer.invoke("pair:list"),
  unpairPhone: (id: string): Promise<boolean> => ipcRenderer.invoke("pair:revoke", id),
  setTheme: (theme: "light" | "dark" | "system"): Promise<void> => ipcRenderer.invoke("theme:set", theme),
  /** Whole-window zoom, like a browser's Ctrl+plus. */
  setZoom: (factor: number): void => webFrame.setZoomFactor(factor),
};

export type DaedalusApi = typeof api;

contextBridge.exposeInMainWorld("daedalus", api);
