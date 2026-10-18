// Writes the built-in parts index the inventory scanner app matches part
// numbers against (../daedalus-inventory-scanner/app/src/main/assets/library.json).
//   npm run scanner:library
// Re-run after adding built-in parts. Imported parts come from the API at runtime.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPurchasable } from "../src/shared/bom";
import { BUILTIN_LIBRARY } from "../src/shared/library";
import { parsePackageId } from "../src/shared/packages";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "daedalus-inventory-scanner", "app", "src", "main", "assets", "library.json");

const parts = BUILTIN_LIBRARY
  .filter((d) => isPurchasable(d) && !parsePackageId(d.id))
  .map((d) => ({
    id: d.id,
    name: d.name,
    category: d.category,
    ...(d.manufacturer ? { manufacturer: d.manufacturer } : {}),
    pins: d.pins.length,
  }));

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ parts }, null, 1) + "\n");
console.log(`Wrote ${parts.length} parts to ${out}`);
