import { BrowserWindow, app, dialog, ipcMain, nativeTheme, safeStorage, screen, session, shell } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ComponentDef } from "../shared/component";
import type { Project } from "../shared/project";
import { Assistant, Provider } from "./assistant";
import type { AssistantPhase } from "./assistant-prompt";
import { claudeCodeVersion, findClaudeCode } from "./claude-code";
import { ImportProgress, ImportRequest, estimateImport, importDatasheet, inspectPdf, loadPdf } from "./datasheet";
import { importDatasheetViaClaudeCode } from "./datasheet-claude-code";
import { apiClient, type LinkedPhone } from "./api-client";
import QRCode from "qrcode";
import { Distributor, DistributorKeys, lookupStock } from "./distributors";
import { profileStore, remoteProfileStore } from "./profiles";
import { BUILTIN_LIBRARY } from "../shared/library";
import { DEFAULT_PROFILE_ID, describeInventory } from "../shared/inventory";

const here = dirname(fileURLToPath(import.meta.url));
const userDir = () => app.getPath("userData");
const libDir = () => join(userDir(), "library");
const settingsPath = () => join(userDir(), "settings.json");
const partsCachePath = () => join(userDir(), "parts-cache.json");
const localProfilesDir = () => join(userDir(), "profiles");

// The daedalus-api Worker. DAEDALUS_API_URL overrides it from the environment,
// the project's .env (dev, e.g. http://localhost:8787), or a .env in the user
// data folder; set it empty to keep parts and profiles on this machine only.
const DEFAULT_API_URL = "https://daedalus-api.cd-cloud.workers.dev";
for (const p of [join(app.getAppPath(), ".env"), join(userDir(), ".env")]) {
  try { if (existsSync(p)) process.loadEnvFile(p); } catch { /* malformed .env */ }
}
const apiUrl = process.env.DAEDALUS_API_URL ?? DEFAULT_API_URL;
const api = apiUrl ? apiClient(apiUrl, {
  // The device token only grants access to this install's own data; without OS
  // key storage (some Linux desktops) it is kept unencrypted rather than not at all.
  load: async () => {
    const s = await loadSettings();
    return decrypt(s.deviceTokenEnc) ?? s.deviceToken;
  },
  save: async (token) => {
    const s = await loadSettings();
    if (safeStorage.isEncryptionAvailable()) s.deviceTokenEnc = safeStorage.encryptString(token).toString("base64");
    else s.deviceToken = token;
    await saveSettings(s);
    await queueCachedImports();
  },
}) : null;
const db = api?.parts ?? null;
const profiles = api
  ? remoteProfileStore(api, localProfilesDir(), join(userDir(), "profiles-cache.json"))
  : profileStore(localProfilesDir());

interface Settings {
  apiKeyEnc?: string;
  /** Unset = auto: Claude Code when no saved/env API key and the CLI is installed. */
  provider?: Provider;
  claudePath?: string;
  /** Folder of the last project opened or saved; the Open dialog starts there. */
  lastDir?: string;
  /** Most recently opened/saved project paths, newest first. */
  recent?: string[];
  /** Main window placement from the last session. */
  window?: WindowState;
  /** Distributor API credentials for stock checks, encrypted like apiKeyEnc. */
  mouserKeyEnc?: string;
  digikeyIdEnc?: string;
  digikeySecretEnc?: string;
  /** Profile whose inventory is in use; unset = the default profile. */
  activeProfile?: string;
  /** daedalus-api device token, encrypted like apiKeyEnc (deviceToken when OS key storage is unavailable). */
  deviceTokenEnc?: string;
  deviceToken?: string;
}

interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized?: boolean;
}

async function loadSettings(): Promise<Settings> {
  try {
    return JSON.parse(await readFile(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

async function saveSettings(s: Settings): Promise<void> {
  await mkdir(userDir(), { recursive: true });
  await writeFile(settingsPath(), JSON.stringify(s, null, 2));
}

const RECENT_MAX = 5;

async function rememberProject(path: string): Promise<void> {
  const s = await loadSettings();
  s.lastDir = dirname(path);
  s.recent = [path, ...(s.recent ?? []).filter((p) => p !== path)].slice(0, RECENT_MAX);
  await saveSettings(s);
}

async function apiKey(): Promise<string | undefined> {
  const s = await loadSettings();
  if (s.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(Buffer.from(s.apiKeyEnc, "base64"));
  }
  return undefined; // SDK falls back to ANTHROPIC_API_KEY / ant profile
}

const decrypt = (v?: string) =>
  v && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(v, "base64")) : undefined;

/** Saved keys, else MOUSER_API_KEY / DIGIKEY_CLIENT_ID / DIGIKEY_CLIENT_SECRET. */
async function distributorKeys(): Promise<DistributorKeys> {
  const s = await loadSettings();
  return {
    mouser: decrypt(s.mouserKeyEnc) ?? process.env.MOUSER_API_KEY,
    digikeyId: decrypt(s.digikeyIdEnc) ?? process.env.DIGIKEY_CLIENT_ID,
    digikeySecret: decrypt(s.digikeySecretEnc) ?? process.env.DIGIKEY_CLIENT_SECRET,
  };
}

async function provider(): Promise<Provider> {
  const s = await loadSettings();
  cachedClaudePath = s.claudePath;
  if (s.provider) return s.provider;
  const hasKey = !!s.apiKeyEnc || !!process.env.ANTHROPIC_API_KEY;
  return !hasKey && findClaudeCode(s.claudePath) ? "claude-code" : "api";
}

const claudeWorkDir = () => join(userDir(), "claude-code");

async function runImport(req: ImportRequest, onProgress: (p: ImportProgress) => void, signal: AbortSignal) {
  if ((await provider()) === "claude-code") {
    const s = await loadSettings();
    return importDatasheetViaClaudeCode(req, onProgress, { workDir: claudeWorkDir(), exe: s.claudePath, signal });
  }
  return importDatasheet(req, onProgress, { apiKey: await apiKey(), signal });
}

async function runEstimate(req: ImportRequest): Promise<{ inputTokens: number; costUsd: number; pages: number; subscription: boolean }> {
  if ((await provider()) === "claude-code") {
    // Claude Code runs on the user's plan; just validate the PDF / page range.
    const { pages } = await loadPdf(req);
    return { inputTokens: 0, costUsd: 0, pages, subscription: true };
  }
  return { ...(await estimateImport(req, await apiKey())), subscription: false };
}

function safeFileName(id: string): string {
  return id.replace(/[^\w.-]+/g, "_");
}

// --- component library -------------------------------------------------------
// With daedalus-api configured, this install's imported parts live there and
// the library folder is an outbox: a save that cannot reach the API lands there
// and is uploaded on the next successful listing (then moved to
// library/uploaded/). The last listing is cached so the library still loads
// offline. Built-in parts ship with the app and are never uploaded.

const partFile = (id: string) => join(libDir(), `${safeFileName(id)}.json`);

async function listLocalParts(): Promise<ComponentDef[]> {
  await mkdir(libDir(), { recursive: true });
  const out: ComponentDef[] = [];
  for (const f of await readdir(libDir())) {
    if (!f.endsWith(".json")) continue;
    try {
      const parsed = ComponentDef.safeParse(JSON.parse(await readFile(join(libDir(), f), "utf8")));
      if (parsed.success) out.push(parsed.data);
    } catch { /* unreadable file */ }
  }
  return out;
}

async function saveLocalPart(def: ComponentDef): Promise<void> {
  await mkdir(libDir(), { recursive: true });
  await writeFile(partFile(def.id), JSON.stringify(def, null, 2));
}

async function readPartsCache(): Promise<ComponentDef[]> {
  try {
    return ComponentDef.array().parse(JSON.parse(await readFile(partsCachePath(), "utf8")));
  } catch {
    return [];
  }
}

/**
 * On first registration with the API: parts the old shared database listed
 * (still in the listing cache) go into the outbox, so this install keeps the
 * parts it had imported.
 */
async function queueCachedImports(): Promise<void> {
  const builtin = new Set(BUILTIN_LIBRARY.map((d) => d.id));
  for (const d of await readPartsCache()) {
    if (d.source?.kind !== "builtin" && !builtin.has(d.id)) await saveLocalPart(d);
  }
}

async function listLibrary(): Promise<ComponentDef[]> {
  // Registers on first run (see queueCachedImports) before the outbox is read.
  await api?.register().catch(() => { /* offline: handled below */ });
  const local = await listLocalParts();
  if (!db) return local;
  let remote: ComponentDef[];
  const pending = new Map(local.map((d) => [d.id, d]));
  try {
    if (local.length) {
      await db.saveAll(local);
      await mkdir(join(libDir(), "uploaded"), { recursive: true });
      for (const d of local) {
        await rename(partFile(d.id), join(libDir(), "uploaded", `${safeFileName(d.id)}.json`)).catch(() => {});
      }
      pending.clear();
    }
    remote = await db.list();
    await writeFile(partsCachePath(), JSON.stringify(remote));
  } catch (e) {
    console.warn(`Parts API unreachable, using the cached library: ${e}`);
    remote = await readPartsCache();
  }
  const byId = new Map(remote.map((d) => [d.id, d]));
  for (const d of pending.values()) byId.set(d.id, d);
  return [...byId.values()];
}

async function savePart(def: ComponentDef): Promise<void> {
  if (db) {
    try {
      await db.save(def);
      await rm(partFile(def.id), { force: true });
      return;
    } catch (e) {
      console.warn(`Parts API unreachable, saving ${def.id} locally until it is: ${e}`);
    }
  }
  await saveLocalPart(def);
}

async function deletePart(id: string): Promise<void> {
  await rm(partFile(id), { force: true });
  if (!db) return;
  try {
    await db.remove(id);
  } catch (e) {
    console.warn(`Parts API unreachable, ${id} was not removed from it: ${e}`);
  }
  await writeFile(partsCachePath(), JSON.stringify((await readPartsCache()).filter((d) => d.id !== id)));
}

// --- profiles and inventory ---------------------------------------------------

async function activeProfileId(): Promise<string> {
  return (await loadSettings()).activeProfile ?? DEFAULT_PROFILE_ID;
}

/** The active profile; falls back to the default one if its file is gone. */
async function activeProfile() {
  return profiles.get(await activeProfileId());
}

let importAbort: AbortController | null = null;
let cachedClaudePath: string | undefined;

function registerIpc(win: BrowserWindow): void {
  ipcMain.handle("lib:list", () => listLibrary());

  ipcMain.handle("lib:save", async (_e, def: unknown) => {
    await savePart(ComponentDef.parse(def));
    return true;
  });

  ipcMain.handle("lib:delete", async (_e, id: string) => {
    await deletePart(id);
    return true;
  });

  ipcMain.handle("lib:reveal", () => shell.openPath(libDir()));

  ipcMain.handle("profile:list", async () => ({ active: (await activeProfile()).id, profiles: await profiles.list() }));
  ipcMain.handle("profile:active", () => activeProfile());
  ipcMain.handle("profile:switch", async (_e, id: string) => {
    const p = await profiles.get(id);
    await saveSettings({ ...(await loadSettings()), activeProfile: p.id });
    return p;
  });
  ipcMain.handle("profile:create", async (_e, name: string) => {
    const p = await profiles.create(String(name));
    await saveSettings({ ...(await loadSettings()), activeProfile: p.id });
    return p;
  });
  ipcMain.handle("profile:rename", async (_e, id: string, name: string) => { await profiles.rename(id, String(name)); return true; });
  ipcMain.handle("profile:delete", async (_e, id: string) => {
    await profiles.remove(id);
    const s = await loadSettings();
    if (s.activeProfile === id) { delete s.activeProfile; await saveSettings(s); }
    return true;
  });
  ipcMain.handle("inventory:set", async (_e, items: unknown) => {
    await profiles.setInventory(await activeProfileId(), items);
    return true;
  });

  // --- phone pairing (daedalus-inventory-scanner) ---------------------------
  const pairingApi = () => {
    if (!api) throw new Error("Pairing a phone needs the Daedalus API, but DAEDALUS_API_URL is set empty.");
    return api;
  };
  ipcMain.handle("pair:start", async () => {
    const { code, expiresAt } = await pairingApi().pairing.code();
    // The scanner app reads the API address from the QR too, so a dev API works.
    const link = `daedalus://pair?api=${encodeURIComponent(apiUrl)}&code=${code}`;
    const qrSvg = await QRCode.toString(link, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return { code, expiresAt, qrSvg };
  });
  ipcMain.handle("pair:list", (): Promise<LinkedPhone[]> => pairingApi().pairing.linked());
  ipcMain.handle("pair:revoke", async (_e, id: string) => { await pairingApi().pairing.revoke(String(id)); return true; });

  // Returns "" on success, else an error message (e.g. the PDF was moved).
  ipcMain.handle("datasheet:open", (_e, path: string) =>
    existsSync(path) ? shell.openPath(path) : `File not found: ${path}`);

  ipcMain.handle("project:open", async () => {
    const { lastDir } = await loadSettings();
    const r = await dialog.showOpenDialog(win, {
      defaultPath: lastDir && existsSync(lastDir) ? lastDir : undefined,
      filters: [{ name: "Daedalus project", extensions: ["dad", "daedalus", "pcproj", "json"] }],
      properties: ["openFile"],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const path = r.filePaths[0];
    const project = JSON.parse(await readFile(path, "utf8")) as Project;
    await rememberProject(path);
    return { path, project };
  });

  ipcMain.handle("project:openPath", async (_e, path: string) => {
    const project = JSON.parse(await readFile(path, "utf8")) as Project;
    await rememberProject(path);
    return { path, project };
  });

  ipcMain.handle("project:recent", async () => {
    const s = await loadSettings();
    const live = (s.recent ?? []).filter((p) => existsSync(p));
    if (live.length !== (s.recent ?? []).length) await saveSettings({ ...s, recent: live });
    return live;
  });

  ipcMain.handle("project:save", async (_e, project: Project, path?: string) => {
    let target = path;
    if (!target) {
      const { lastDir } = await loadSettings();
      const name = `${project.name || "untitled"}.dad`;
      const r = await dialog.showSaveDialog(win, {
        defaultPath: lastDir && existsSync(lastDir) ? join(lastDir, name) : name,
        filters: [{ name: "Daedalus project", extensions: ["dad"] }],
      });
      if (r.canceled || !r.filePath) return null;
      target = r.filePath;
    }
    // Readable project, with the (bulky, machine-only) undo history on one line at the end.
    const { history, ...rest } = project;
    let text = JSON.stringify(rest, null, 2);
    if (history) text = `${text.slice(0, -2)},
  "history": ${JSON.stringify(history)}
}`;
    await writeFile(target, text);
    await rememberProject(target);
    return target;
  });

  ipcMain.handle("file:saveText", async (_e, text: string, name: string, filter: { name: string; extensions: string[] }) => {
    const { lastDir } = await loadSettings();
    const r = await dialog.showSaveDialog(win, {
      defaultPath: lastDir && existsSync(lastDir) ? join(lastDir, name) : name,
      filters: [filter],
    });
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, text);
    return r.filePath;
  });

  ipcMain.handle("file:pick", async (_e, kind: "hex" | "asm") => {
    const r = await dialog.showOpenDialog(win, {
      filters: kind === "hex"
        ? [{ name: "Intel HEX", extensions: ["hex", "ihx"] }]
        : [{ name: "AVR assembly", extensions: ["asm", "s", "S"] }],
      properties: ["openFile"],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return { path: r.filePaths[0], text: await readFile(r.filePaths[0], "utf8") };
  });

  ipcMain.handle("file:read", async (_e, path: string) => (existsSync(path) ? readFile(path, "utf8") : null));

  ipcMain.handle("examples:list", async () => {
    const dir = join(app.getAppPath(), "examples");
    if (!existsSync(dir)) return [];
    const out: { file: string; project: Project }[] = [];
    for (const f of await readdir(dir)) {
      if (f.endsWith(".dad")) out.push({ file: f, project: JSON.parse(await readFile(join(dir, f), "utf8")) });
    }
    return out;
  });

  ipcMain.handle("datasheet:pick", async () => {
    const r = await dialog.showOpenDialog(win, {
      filters: [{ name: "Datasheet (PDF)", extensions: ["pdf"] }],
      properties: ["openFile"],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return inspectPdf(r.filePaths[0]);
  });

  ipcMain.handle("datasheet:estimate", async (_e, req: ImportRequest) => runEstimate(req));

  ipcMain.handle("datasheet:import", async (_e, req: ImportRequest) => {
    importAbort?.abort();
    importAbort = new AbortController();
    try {
      return await runImport(req, (p) => win.webContents.send("datasheet:progress", p), importAbort.signal);
    } finally {
      importAbort = null;
    }
  });

  ipcMain.handle("datasheet:cancel", () => {
    importAbort?.abort();
    return true;
  });

  // --- design assistant ---------------------------------------------------
  const pending = new Map<string, (v: unknown) => void>();
  const assistant = new Assistant({
    emit: (ev) => win.webContents.send("assistant:event", ev),
    exec: (name, input) => new Promise((resolve) => {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      pending.set(id, resolve);
      win.webContents.send("assistant:exec", { id, name, input });
    }),
    apiKey,
    provider,
    claudeCode: () => ({ workDir: claudeWorkDir(), exe: cachedClaudePath }),
    importDatasheet: runImport,
    estimateImport: runEstimate,
    downloadsDir: () => join(userDir(), "datasheets"),
    saveComponent: savePart,
    inventory: async () => {
      const defs = new Map(BUILTIN_LIBRARY.map((d) => [d.id, d] as const));
      for (const d of await listLibrary()) defs.set(d.id, d);
      return describeInventory(await activeProfile(), defs);
    },
  });
  ipcMain.handle("assistant:send", (_e, text: string, phase: AssistantPhase) => {
    if (assistant.busy) return false;
    void assistant.send(text, phase === "interview" ? "interview" : "build");
    return true;
  });
  ipcMain.handle("assistant:exec-result", (_e, id: string, result: unknown) => {
    pending.get(id)?.(result);
    pending.delete(id);
  });
  const flushPending = () => {
    for (const r of pending.values()) r({ error: "cancelled" });
    pending.clear();
  };
  ipcMain.handle("assistant:cancel", () => { assistant.cancel(); flushPending(); });
  ipcMain.handle("assistant:reset", () => { assistant.reset(); flushPending(); });

  // Keeps the native title bar in step with the renderer's light/dark theme.
  ipcMain.handle("theme:set", (_e, theme: unknown) => {
    if (theme === "light" || theme === "dark" || theme === "system") nativeTheme.themeSource = theme;
  });

  ipcMain.handle("settings:get", async () => {
    const s = await loadSettings();
    cachedClaudePath = s.claudePath;
    const path = findClaudeCode(s.claudePath);
    const dk = await distributorKeys();
    return {
      distributors: { mouser: !!dk.mouser, digikey: !!dk.digikeyId && !!dk.digikeySecret },
      keySource: s.apiKeyEnc ? "settings" : process.env.ANTHROPIC_API_KEY ? "env" : "sdk-default",
      encryption: safeStorage.isEncryptionAvailable(),
      provider: await provider(),
      providerSetting: s.provider ?? "auto",
      claudeCode: { path, version: path ? claudeCodeVersion(path) : null },
    };
  });

  ipcMain.handle("settings:setProvider", async (_e, p: Provider | "auto", claudePath?: string) => {
    const s = await loadSettings();
    if (p === "auto") delete s.provider;
    else s.provider = p;
    if (claudePath !== undefined) {
      if (claudePath) s.claudePath = claudePath;
      else delete s.claudePath;
      cachedClaudePath = claudePath || undefined;
    }
    await mkdir(userDir(), { recursive: true });
    await writeFile(settingsPath(), JSON.stringify(s, null, 2));
    return true;
  });

  ipcMain.handle("bom:stock", async (_e, dist: Distributor, query: string) => lookupStock(dist, query, await distributorKeys()));

  /** Each field: a string saves it, null removes it, undefined leaves it alone. */
  ipcMain.handle("settings:setDistributorKeys", async (_e, k: { mouser?: string | null; digikeyId?: string | null; digikeySecret?: string | null }) => {
    const s = await loadSettings();
    const fields = { mouser: "mouserKeyEnc", digikeyId: "digikeyIdEnc", digikeySecret: "digikeySecretEnc" } as const;
    for (const [from, to] of Object.entries(fields) as [keyof typeof fields, (typeof fields)[keyof typeof fields]][]) {
      const v = k[from];
      if (v === undefined) continue;
      if (!v) { delete s[to]; continue; }
      if (!safeStorage.isEncryptionAvailable()) throw new Error("OS key storage is unavailable; use the MOUSER_API_KEY / DIGIKEY_CLIENT_ID / DIGIKEY_CLIENT_SECRET environment variables instead.");
      s[to] = safeStorage.encryptString(v).toString("base64");
    }
    await saveSettings(s);
    return true;
  });

  ipcMain.handle("settings:setKey", async (_e, key: string | null) => {
    const s = await loadSettings();
    if (!key) delete s.apiKeyEnc;
    else {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("OS key storage is unavailable; set ANTHROPIC_API_KEY instead.");
      s.apiKeyEnc = safeStorage.encryptString(key).toString("base64");
    }
    await mkdir(userDir(), { recursive: true });
    await writeFile(settingsPath(), JSON.stringify(s, null, 2));
    return true;
  });
}

// Window placement is read and written synchronously: it is needed before the
// window exists, and the save runs on close, after which the app may exit at once.
function loadWindowState(): WindowState | undefined {
  try {
    const w = (JSON.parse(readFileSync(settingsPath(), "utf8")) as Settings).window;
    if (!w || ![w.x, w.y, w.width, w.height].every(Number.isFinite)) return undefined;
    // Drop the position if that display is gone (unplugged monitor), keep the size.
    const area = screen.getDisplayMatching(w).workArea;
    const visible = w.x < area.x + area.width && w.x + w.width > area.x && w.y < area.y + area.height && w.y + w.height > area.y;
    return visible ? w : { ...w, x: NaN, y: NaN };
  } catch {
    return undefined;
  }
}

function saveWindowState(win: BrowserWindow): void {
  try {
    let s: Settings = {};
    try { s = JSON.parse(readFileSync(settingsPath(), "utf8")); } catch { /* first run */ }
    s.window = { ...win.getNormalBounds(), maximized: win.isMaximized() || undefined };
    mkdirSync(userDir(), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
  } catch { /* not worth failing the close over */ }
}

function createWindow(): void {
  const saved = loadWindowState();
  const placed = saved && Number.isFinite(saved.x) ? { x: saved.x, y: saved.y } : {};
  const win = new BrowserWindow({
    width: saved?.width ?? 1500,
    height: saved?.height ?? 920,
    ...placed,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#2d2d30" : "#eeeef2",
    title: "Daedalus",
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  if (saved?.maximized) win.maximize();
  win.on("close", () => saveWindowState(win));
  win.setMenuBarVisibility(false);
  registerIpc(win);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(here, "../renderer/index.html"));
}

// One instance per profile. Chromium can only open the Local Storage database
// from one process, so a second instance would silently fall back to in-memory
// storage and lose every setting, layout and theme change on exit.
if (!app.requestSingleInstanceLock()) {
  console.error("Daedalus is already running; focusing that window instead.");
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(createWindow);
}
app.on("window-all-closed", () => app.quit());
// localStorage (theme, tool-window layout, view options) is committed to disk
// lazily; make sure the last changes land before the process exits.
app.on("before-quit", () => { if (app.isReady()) session.defaultSession.flushStorageData(); });
