// Component library in Neon Postgres (table defined in db/schema.sql).
// `def` holds the whole ComponentDef; the other columns copy its fields for
// listing and filtering. Datasheet PDFs stay on disk; only `source.path` points at them.

import { neon } from "@neondatabase/serverless";
import { ComponentDef } from "../shared/component";

const TIMEOUT_MS = 8000;
const opts = () => ({ fetchOptions: { signal: AbortSignal.timeout(TIMEOUT_MS) } });

export type PartsDb = ReturnType<typeof partsDb>;

export function partsDb(url: string) {
  const sql = neon(url);

  const upsert = (d: ComponentDef) => sql.query(
    `INSERT INTO parts (id, name, category, manufacturer, description, source, def)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, category = EXCLUDED.category, manufacturer = EXCLUDED.manufacturer,
       description = EXCLUDED.description, source = EXCLUDED.source, def = EXCLUDED.def, updated_at = now()`,
    [d.id, d.name, d.category, d.manufacturer ?? null, d.description, d.source?.kind ?? "builtin", JSON.stringify(d)],
    opts(),
  );

  return {
    sql,

    /** Every part that still validates against the current schema. */
    async list(): Promise<ComponentDef[]> {
      const rows = await sql.query("SELECT def FROM parts ORDER BY id", [], opts()) as { def: unknown }[];
      const out: ComponentDef[] = [];
      for (const r of rows) {
        const parsed = ComponentDef.safeParse(r.def);
        if (parsed.success) out.push(parsed.data);
      }
      return out;
    },

    async save(def: ComponentDef): Promise<void> {
      await upsert(ComponentDef.parse(def));
    },

    /** Upserts many parts in one transaction. */
    async saveAll(defs: ComponentDef[]): Promise<void> {
      await sql.transaction(defs.map((d) => upsert(ComponentDef.parse(d))), opts());
    },

    async remove(id: string): Promise<void> {
      await sql.query("DELETE FROM parts WHERE id = $1", [id], opts());
    },
  };
}
