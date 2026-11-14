import type { DatabaseSync } from "node:sqlite";

/**
 * Tables a write may change while declaring it changes nothing any thread read returns
 * (`Store.writeOutsideThreadReads`): which stored rows are read as stored, never their values.
 * A table joins only when no thread read's result depends on it.
 */
export const threadReadNeutralTables: ReadonlySet<string> = new Set([
  "stored_event_confirmed",
  "stored_event_rejected",
  "thread_row_trust",
]);

// An upsert's `ON CONFLICT ... DO UPDATE SET` updates the row its INSERT names, not a table.
const written =
  /\b(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into|(?<!\bdo\s+)update(?:\s+or\s+\w+)?|delete\s+from)\s+["`[]?(\w+)/gi;

/** The tables a statement writes, by name. */
export function tablesWritten(sql: string): string[] {
  return [...sql.matchAll(written)].map((match) => (match[1] ?? "").toLowerCase());
}

/**
 * `db` for a write declared neutral to thread reads: every statement it prepares or runs is
 * checked first, and one that writes any other table throws before it runs. The declaration is
 * otherwise unenforced; this keeps a later caller from breaking it silently.
 */
function check(sql: string): void {
  for (const table of tablesWritten(sql))
    if (!threadReadNeutralTables.has(table))
      throw new Error(`A write declared neutral to thread reads writes ${table}`);
}
export function threadReadNeutral(db: DatabaseSync): DatabaseSync {
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          check(sql);
          return target.prepare(sql);
        };
      if (key === "exec")
        return (sql: string) => {
          check(sql);
          target.exec(sql);
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
