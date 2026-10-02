import type { DatabaseSync } from "node:sqlite";

export const countColumns = ["input", "output", "cached", "reasoning", "write", "write1h", "cost"];
export function migrate(db: DatabaseSync, timezone: string): void {
  const version = db.prepare("SELECT name FROM sqlite_master WHERE name='usage_meta'").get()
    ? db.prepare("SELECT version, timezone FROM usage_meta WHERE id=1").get()
    : undefined;
  if (version?.version === 1) {
    if (version.timezone !== timezone)
      throw new Error("Usage projection timezone changed; rebuild the derived database");
    db.exec(`BEGIN IMMEDIATE;
      DROP TABLE usage_increments; DROP TABLE usage_counters; DROP TABLE usage_daily;
      DROP TABLE usage_agents; DROP TABLE usage_threads;
      ALTER TABLE usage_meta ADD COLUMN omitted INTEGER NOT NULL DEFAULT 0;
      UPDATE usage_meta SET version=2, cursor=0; COMMIT;`);
  }
  db.exec(`
    PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS usage_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, cursor INTEGER NOT NULL, timezone TEXT NOT NULL, omitted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS usage_threads (thread TEXT PRIMARY KEY, workspace TEXT NOT NULL, provider TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS usage_agents (agent TEXT PRIMARY KEY, thread TEXT NOT NULL, parent TEXT, model TEXT, provider TEXT, run TEXT NOT NULL DEFAULT 'legacy');
    CREATE INDEX IF NOT EXISTS usage_agent_thread ON usage_agents(thread);
    CREATE INDEX IF NOT EXISTS usage_parent ON usage_agents(parent, thread);
    CREATE TABLE IF NOT EXISTS usage_counters (agent TEXT NOT NULL, scope TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cached INTEGER NOT NULL, reasoning INTEGER NOT NULL, write INTEGER NOT NULL, write1h INTEGER NOT NULL, cost REAL NOT NULL, PRIMARY KEY(agent, scope)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS usage_daily (
      day TEXT NOT NULL, thread TEXT NOT NULL, agent TEXT NOT NULL, provider TEXT NOT NULL,
      account TEXT NOT NULL, model TEXT NOT NULL, workspace TEXT NOT NULL, billing TEXT NOT NULL,
      input INTEGER NOT NULL, output INTEGER NOT NULL, cached INTEGER NOT NULL, reasoning INTEGER NOT NULL,
      write INTEGER NOT NULL, write1h INTEGER NOT NULL, cost REAL NOT NULL,
      PRIMARY KEY(day, thread, agent, provider, account, model, workspace, billing)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS usage_daily_thread ON usage_daily(thread, day);
    CREATE INDEX IF NOT EXISTS usage_daily_agent ON usage_daily(agent, day);
    CREATE INDEX IF NOT EXISTS usage_daily_account ON usage_daily(account, day);
    CREATE TABLE IF NOT EXISTS usage_increments (
      seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, thread TEXT NOT NULL, account TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cost REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_increment_thread ON usage_increments(thread);
    CREATE INDEX IF NOT EXISTS usage_window ON usage_increments(account, at);
    CREATE TEMP TABLE usage_prices (model TEXT PRIMARY KEY, input REAL, cached REAL, write REAL, write1h REAL, output REAL);
  `);
  const existing = db.prepare("SELECT version, timezone FROM usage_meta WHERE id=1").get();
  if (existing && (existing.version !== 2 || existing.timezone !== timezone))
    throw new Error("Usage projection settings changed; rebuild the derived database");
  db.prepare("INSERT OR IGNORE INTO usage_meta VALUES (1, 2, 0, ?, 0)").run(timezone);
}
export const upsertDaily = `INSERT INTO usage_daily
  SELECT json_extract(value, '$.day'), json_extract(value, '$.thread'), json_extract(value, '$.agent'),
    json_extract(value, '$.provider'), json_extract(value, '$.account'), json_extract(value, '$.model'),
    json_extract(value, '$.workspace'), json_extract(value, '$.billing'),
    ${countColumns.map((c) => `json_extract(value, '$.${c}')`).join(", ")}
  FROM json_each(?) WHERE true
  ON CONFLICT(day, thread, agent, provider, account, model, workspace, billing)
  DO UPDATE SET ${countColumns.map((c) => `${c} = usage_daily.${c} + excluded.${c}`).join(", ")}`;
