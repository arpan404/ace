import type { DatabaseSync } from "@ace/provider-kit/sqlite";
import { z } from "zod";

export const SqlitePageSpace = z.object({
  pageBytes: z.number().int().nonnegative(),
  reclaimableBytes: z.number().int().nonnegative(),
  autoVacuum: z.number().int().nonnegative(),
});
export type SqliteSpace = z.infer<typeof SqlitePageSpace> & { walBytes: number };

/** Shared by the read-only doctor worker and the storage owner. */
export function readSqlitePageSpace(db: Pick<DatabaseSync, "prepare">) {
  const pragma = (sql: string) => Number(Object.values(db.prepare(sql).get() ?? {})[0]);
  const page = pragma("PRAGMA page_size");
  return SqlitePageSpace.parse({
    pageBytes: page * pragma("PRAGMA page_count"),
    reclaimableBytes: page * pragma("PRAGMA freelist_count"),
    autoVacuum: pragma("PRAGMA auto_vacuum"),
  });
}
