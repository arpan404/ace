import { z } from "zod";
import { FIELD_CAP } from "./text.ts";

// A JSON delta may end in half a UTF-16 pair. SQLite TEXT is UTF-8 and would
// replace that half before the following delta can join it. Escape only that
// rare case, with a tag that also distinguishes user text starting with a tag.
export function storeText(value: string): string {
  return value.isWellFormed() ? "t" + value : "j" + JSON.stringify(value);
}
export const StoredText = z
  .string()
  .max(FIELD_CAP * 6 + 3)
  .transform((value) => {
    if (value.startsWith("t")) return value.slice(1);
    if (value.startsWith("j")) return z.string().parse(JSON.parse(value.slice(1)));
    throw new Error("Invalid staged text encoding");
  })
  .pipe(z.string().max(FIELD_CAP));
