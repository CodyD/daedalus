// Seeds the Neon `parts` table with the built-in library.
//   npm run db:seed
// Reads DATABASE_URL from .env. Re-running upserts, so it is safe to repeat.

import { readFileSync } from "node:fs";
import { partsDb } from "../src/main/parts-db";
import { BUILTIN_LIBRARY } from "../src/shared/library";

process.loadEnvFile?.(".env");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (add it to .env).");

const db = partsDb(url);

const schema = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
for (const stmt of schema.split(";").map((s) => s.trim()).filter(Boolean)) {
  await db.sql.query(stmt);
}

await db.saveAll(BUILTIN_LIBRARY);

const [{ count }] = await db.sql`SELECT count(*)::int AS count FROM parts`;
console.log(`Seeded ${BUILTIN_LIBRARY.length} built-in parts; parts table now has ${count} rows.`);
