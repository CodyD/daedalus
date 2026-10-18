// Profile stores. Without daedalus-api, one JSON file per profile in
// <userData>/profiles; with it, the API holds them (remoteProfileStore). The
// "default" profile always exists and cannot be deleted. Which profile is
// active is kept in settings.json by the caller.

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiError, type Api } from "./api-client";
import { DEFAULT_PROFILE_ID, InventoryItem, Profile, ProfileSummary, newProfile, profileIdFor } from "../shared/inventory";

export type ProfileStore = ReturnType<typeof profileStore>;

export function profileStore(dir: string) {
  const file = (id: string) => join(dir, `${id.replace(/[^\w.-]+/g, "_")}.json`);

  async function read(id: string): Promise<Profile | null> {
    try {
      const parsed = Profile.safeParse(JSON.parse(await readFile(file(id), "utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async function write(p: Profile): Promise<void> {
    await mkdir(dir, { recursive: true });
    // Write then rename, so a crash mid-save never leaves a truncated inventory.
    const tmp = `${file(p.id)}.tmp`;
    await writeFile(tmp, JSON.stringify(p, null, 2));
    await rename(tmp, file(p.id));
  }

  async function get(id: string): Promise<Profile> {
    const p = await read(id);
    if (p) return p;
    if (id !== DEFAULT_PROFILE_ID) return get(DEFAULT_PROFILE_ID);
    const fresh = newProfile(DEFAULT_PROFILE_ID, "Default");
    await write(fresh);
    return fresh;
  }

  async function list(): Promise<ProfileSummary[]> {
    await get(DEFAULT_PROFILE_ID);
    const out: ProfileSummary[] = [];
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      const p = await read(f.slice(0, -5));
      if (p) out.push({ id: p.id, name: p.name, items: p.inventory.length });
    }
    return out.sort((a, b) => (a.id === DEFAULT_PROFILE_ID ? -1 : b.id === DEFAULT_PROFILE_ID ? 1 : a.name.localeCompare(b.name)));
  }

  return {
    get,
    list,

    async create(name: string): Promise<Profile> {
      const taken = new Set((await list()).map((p) => p.id));
      const p = newProfile(profileIdFor(name, taken), name.trim() || "Profile");
      await write(p);
      return p;
    },

    async rename(id: string, name: string): Promise<void> {
      const p = await get(id);
      if (name.trim()) await write({ ...p, name: name.trim() });
    },

    async remove(id: string): Promise<void> {
      if (id === DEFAULT_PROFILE_ID) throw new Error("The default profile cannot be deleted.");
      await rm(file(id), { force: true });
    },

    async setInventory(id: string, items: unknown): Promise<void> {
      const p = await get(id);
      await write({ ...p, inventory: InventoryItem.array().parse(items) });
    },
  };
}

/**
 * Profiles kept by daedalus-api. On first use the profiles in `localDir` are
 * uploaded and the folder is renamed, so that happens once. The last copy of
 * every profile read is cached in `cacheFile` so the inventory can still be
 * read while the API is unreachable; changes need the API.
 */
export function remoteProfileStore(api: Api, localDir: string, cacheFile: string): ProfileStore {
  let uploaded: Promise<void> | null = null;
  const uploadLocal = () => (uploaded ??= (async () => {
    if (!existsSync(localDir)) return;
    const local = profileStore(localDir);
    for (const s of await local.list()) await api.profiles.put(await local.get(s.id));
    await rename(localDir, `${localDir}-uploaded-${Date.now()}`);
  })().catch((e) => { uploaded = null; throw e; }));

  interface Cache { list?: ProfileSummary[]; profiles: Record<string, Profile> }

  async function readCache(): Promise<Cache> {
    try {
      return JSON.parse(await readFile(cacheFile, "utf8")) as Cache;
    } catch {
      return { profiles: {} };
    }
  }

  async function updateCache(fn: (c: Cache) => void): Promise<void> {
    const c = await readCache();
    fn(c);
    await writeFile(cacheFile, JSON.stringify(c)).catch(() => { /* cache only */ });
  }

  /** Runs `fresh` against the API; on a network failure (not an API error) answers from the cache. */
  async function orCached<T>(fresh: () => Promise<T>, fromCache: (c: Cache) => T | undefined): Promise<T> {
    try {
      await uploadLocal();
      return await fresh();
    } catch (e) {
      if (e instanceof ApiError) throw e;
      const v = fromCache(await readCache());
      if (v === undefined) throw e;
      console.warn(`Profile service unreachable, using the cached copy: ${e}`);
      return v;
    }
  }

  const write = async <T>(fn: () => Promise<T>) => { await uploadLocal(); return fn(); };

  async function get(id: string): Promise<Profile> {
    try {
      const p = await orCached(() => api.profiles.get(id), (c) => c.profiles[id]);
      await updateCache((c) => { c.profiles[p.id] = p; });
      return p;
    } catch (e) {
      // Like the local store: a missing profile falls back to the default one.
      if (e instanceof ApiError && e.status === 404 && id !== DEFAULT_PROFILE_ID) return get(DEFAULT_PROFILE_ID);
      throw e;
    }
  }

  return {
    get,

    async list(): Promise<ProfileSummary[]> {
      const list = await orCached(() => api.profiles.list(), (c) => c.list);
      await updateCache((c) => { c.list = list; });
      return list;
    },

    create: (name: string) => write(() => api.profiles.create(name)),

    async rename(id: string, name: string): Promise<void> {
      if (name.trim()) await write(() => api.profiles.rename(id, name.trim()));
    },

    async remove(id: string): Promise<void> {
      if (id === DEFAULT_PROFILE_ID) throw new Error("The default profile cannot be deleted.");
      await write(() => api.profiles.remove(id));
      await updateCache((c) => { delete c.profiles[id]; });
    },

    async setInventory(id: string, items: unknown): Promise<void> {
      const inventory = InventoryItem.array().parse(items);
      await write(() => api.profiles.setInventory(id, inventory));
      await updateCache((c) => { if (c.profiles[id]) c.profiles[id] = { ...c.profiles[id], inventory }; });
    },
  };
}
