// User profiles and their parts inventory.
//
// A profile is a local identity holding the parts the user already owns. Until
// sign-in exists everyone uses the "default" profile; a signed-in account will
// map to its own profile id. The design assistant reads the active profile's
// inventory (get_inventory) and prefers those parts where they fit the design,
// and the parts list shows how many of each line are already on hand.

import { z } from "zod";
import type { ComponentDef } from "./component";
import type { BomLine } from "./bom";
import { parseValue } from "../sim/units";

export const DEFAULT_PROFILE_ID = "default";

export const InventoryItem = z.object({
  id: z.string(),
  /** Library part this is (RES, NE555, LED-RED...); unset for parts the library doesn't have. */
  defId: z.string().optional(),
  /** What the user calls it: a part number or a description. */
  name: z.string(),
  /** Value for passives, e.g. "10k", "100n". */
  value: z.string().optional(),
  /** Package or form factor, e.g. "DIP-8", "0805", "5 mm", "module". */
  package: z.string().optional(),
  qty: z.number().int().min(0),
  /** Where it is kept: "drawer 3", "blue box". */
  location: z.string().optional(),
  notes: z.string().optional(),
});
export type InventoryItem = z.infer<typeof InventoryItem>;

export const Profile = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  inventory: z.array(InventoryItem),
});
export type Profile = z.infer<typeof Profile>;

export interface ProfileSummary {
  id: string;
  name: string;
  items: number;
}

export function newProfile(id: string, name: string): Profile {
  return { id, name, createdAt: new Date().toISOString(), inventory: [] };
}

export function newItemId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Three-way merge of an inventory edited here (`mine`) with what the store has
 * now (`theirs`), both starting from `base`. Changes made elsewhere since
 * `base` (a paired phone adding items or bumping a quantity) are kept: new
 * items are appended and quantity changes are added to mine. Everything else
 * is mine.
 */
export function mergeInventory(base: InventoryItem[], mine: InventoryItem[], theirs: InventoryItem[]): InventoryItem[] {
  const baseById = new Map(base.map((it) => [it.id, it]));
  const mineIds = new Set(mine.map((it) => it.id));
  const theirsById = new Map(theirs.map((it) => [it.id, it]));
  const merged = mine.map((it) => {
    const was = baseById.get(it.id);
    const now = theirsById.get(it.id);
    if (!was || !now || now.qty === was.qty) return it;
    return { ...it, qty: Math.max(0, it.qty + now.qty - was.qty) };
  });
  for (const it of theirs) if (!baseById.has(it.id) && !mineIds.has(it.id)) merged.push(it);
  return merged;
}

/** Profile id from a display name: lower-case, dashes, unique against `taken`. */
export function profileIdFor(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "profile";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** Normalised value so "10k", "10000" and "10K" compare equal (same rule as the parts list). */
export function normValue(raw: string | undefined): string {
  if (!raw?.trim()) return "";
  const v = parseValue(raw);
  return isFinite(v) ? String(+v.toPrecision(6)) : raw.trim().toLowerCase();
}

/** Inventory items that are the part on a parts-list line (same library part, same value). */
export function itemsForLine(line: Pick<BomLine, "key">, inventory: InventoryItem[]): InventoryItem[] {
  const i = line.key.indexOf("|");
  const defId = line.key.slice(0, i);
  const value = line.key.slice(i + 1);
  return inventory.filter((it) => it.defId === defId && it.qty > 0 && (!value || normValue(it.value) === value));
}

export function onHand(line: Pick<BomLine, "key">, inventory: InventoryItem[]): number {
  return itemsForLine(line, inventory).reduce((n, it) => n + it.qty, 0);
}

/** Inventory as the design assistant sees it: compact, with library ids it can place. */
export function describeInventory(profile: Profile, defs: Map<string, ComponentDef>) {
  const items = profile.inventory.filter((it) => it.qty > 0);
  return {
    summary: `${items.length} part${items.length === 1 ? "" : "s"} on hand in profile "${profile.name}"`,
    profile: profile.name,
    items: items.map((it) => {
      const def = it.defId ? defs.get(it.defId) : undefined;
      return {
        name: it.name,
        library_id: def ? def.id : null,
        library_name: def?.name,
        value: it.value || undefined,
        package: it.package || undefined,
        qty: it.qty,
        notes: it.notes || undefined,
      };
    }),
    note: items.length
      ? "library_id null means the library has no matching part yet: use an equivalent library part, an emulated part, or import its datasheet."
      : "The user has not recorded any parts; choose parts freely.",
  };
}
