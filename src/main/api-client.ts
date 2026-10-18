// Client for daedalus-api (the Cloudflare Worker in ../daedalus-api), which
// holds each install's imported parts and its profiles' inventory.
//
// An install is identified by a random device token from POST /devices,
// requested on first use and kept by the caller (encrypted in settings.json).
// Nothing about the machine or the user is sent.

import { ComponentDef } from "../shared/component";
import { InventoryItem, Profile, ProfileSummary } from "../shared/inventory";

const TIMEOUT_MS = 8000;
/** The API takes at most this many parts per upload. */
const PARTS_PER_UPLOAD = 100;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface TokenStore {
  load(): Promise<string | undefined>;
  save(token: string): Promise<void>;
}

export type Api = ReturnType<typeof apiClient>;

/** A phone paired with this install (see daedalus-inventory-scanner). */
export interface LinkedPhone {
  id: string;
  label: string;
  createdAt: string;
  lastSeen: string;
}

export function apiClient(baseUrl: string, tokens: TokenStore) {
  const base = baseUrl.replace(/\/+$/, "");

  async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json().catch(() => null) as { result?: T; errors?: { message: string }[] } | null;
    if (!res.ok) {
      const msg = json?.errors?.map((e) => e.message).join("; ") || res.statusText;
      throw new ApiError(`${method} ${path}: ${res.status} ${msg}`, res.status);
    }
    return json?.result as T;
  }

  // Registers on first use; concurrent callers share the one registration.
  let tokenPromise: Promise<string> | null = null;
  const token = () => (tokenPromise ??= (async () => {
    const saved = await tokens.load();
    if (saved) return saved;
    const { token } = await call<{ deviceId: string; token: string }>("POST", "/devices");
    await tokens.save(token);
    return token;
  })().catch((e) => { tokenPromise = null; throw e; }));

  const authed = async <T>(method: string, path: string, body?: unknown) => call<T>(method, path, body, await token());
  const enc = encodeURIComponent;

  return {
    /** Gets this install a device token if it has none yet. */
    register: async () => { await token(); },

    parts: {
      /** This install's imported parts that still validate against the current schema. */
      async list(): Promise<ComponentDef[]> {
        const out: ComponentDef[] = [];
        for (const d of await authed<unknown[]>("GET", "/parts")) {
          const parsed = ComponentDef.safeParse(d);
          if (parsed.success) out.push(parsed.data);
        }
        return out;
      },

      async save(def: ComponentDef): Promise<void> {
        await authed("PUT", "/parts", { parts: [ComponentDef.parse(def)] });
      },

      async saveAll(defs: ComponentDef[]): Promise<void> {
        for (let i = 0; i < defs.length; i += PARTS_PER_UPLOAD) {
          await authed("PUT", "/parts", { parts: defs.slice(i, i + PARTS_PER_UPLOAD).map((d) => ComponentDef.parse(d)) });
        }
      },

      async remove(id: string): Promise<void> {
        await authed("DELETE", `/parts/${enc(id)}`);
      },
    },

    pairing: {
      /** A one-time code (XXXX-XXXX) a phone can redeem within a few minutes. */
      code: async () => authed<{ code: string; expiresAt: string }>("POST", "/devices/pairing-code"),
      linked: async () => authed<LinkedPhone[]>("GET", "/devices/linked"),
      revoke: async (id: string) => { await authed("DELETE", `/devices/linked/${enc(id)}`); },
    },

    profiles: {
      list: async () => authed<ProfileSummary[]>("GET", "/profiles"),
      get: async (id: string) => Profile.parse(await authed("GET", `/profiles/${enc(id)}`)),
      create: async (name: string) => Profile.parse(await authed("POST", "/profiles", { name })),
      /** Creates or replaces a profile under its own id (uploading a local one). */
      put: async (p: Profile) => {
        await authed("PUT", `/profiles/${enc(p.id)}`, { name: p.name, createdAt: p.createdAt, inventory: p.inventory });
      },
      rename: async (id: string, name: string) => { await authed("PATCH", `/profiles/${enc(id)}`, { name }); },
      remove: async (id: string) => { await authed("DELETE", `/profiles/${enc(id)}`); },
      setInventory: async (id: string, items: InventoryItem[]) => {
        await authed("PUT", `/profiles/${enc(id)}/inventory`, { items });
      },
    },
  };
}
