import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The part of D1 the account backend's stores use (prepare, bind, first, run, batch), over a real
 * in-memory SQLite with the Worker's migrations applied. A batch is one transaction, as in D1, and
 * every call yields to the event loop first, so concurrent requests interleave between them.
 */
export function sqliteD1(): { db: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(import.meta.dirname, "../../migrations");
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .toSorted())
    sqlite.exec(readFileSync(join(dir, file), "utf8"));
  type Value = null | number | bigint | string | Uint8Array;

  class Statement {
    readonly sql: string;
    readonly params: Value[];
    constructor(sql: string, params: Value[] = []) {
      this.sql = sql;
      this.params = params;
    }
    bind(...params: unknown[]) {
      return new Statement(this.sql, params as Value[]);
    }
    rows(): Record<string, unknown>[] {
      return sqlite.prepare(this.sql).all(...this.params) as Record<string, unknown>[];
    }
    async first<T>(): Promise<T | null> {
      await turn();
      return (this.rows()[0] as T | undefined) ?? null;
    }
    async all<T>() {
      await turn();
      return { results: this.rows() as T[], success: true, meta: {} };
    }
    async run() {
      await turn();
      const { changes } = sqlite.prepare(this.sql).run(...this.params);
      return { results: [], success: true, meta: { changes: Number(changes) } };
    }
  }

  const db = {
    prepare: (sql: string) => new Statement(sql),
    async batch(statements: Statement[]) {
      await turn();
      sqlite.exec("BEGIN");
      try {
        const out = statements.map((statement) => ({
          results: statement.rows(),
          success: true,
          meta: {},
        }));
        sqlite.exec("COMMIT");
        return out;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { db: db as unknown as D1Database, sqlite };
}
