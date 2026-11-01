import type { DatabaseSync } from "node:sqlite";

export const countColumns = ["input", "output", "cached", "reasoning", "write", "write1h", "cost"];
export function migrate(db: DatabaseSync, timezone: string): void {
  const version = db.prepare("SELECT name FROM sqlite_master WHERE name='usage_meta'").get()
    ? db.prepare("SELECT version, timezone FROM usage_meta WHERE id=1").get()
    : undefined;
  if (version?.version === 1 || version?.version === 2) {
    if (version.timezone !== timezone)
      throw new Error("Usage projection timezone changed; rebuild the derived database");
    // Every table is derived. v2 lacks thread ownership in the quota ledger (v1) and the
    // skill, automation and role facts (v2), so the projection replays retained history.
    const tables = [
      ...db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'usage%'")
        .iterate(),
    ].map((row) => String(row.name));
    db.exec(
      `BEGIN IMMEDIATE; ${tables.map((name) => `DROP TABLE "${name.replaceAll('"', '""')}";`).join(" ")} COMMIT;`,
    );
  }
  db.exec(`
    PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-1024; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=16777216;
    CREATE TABLE IF NOT EXISTS usage_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, cursor INTEGER NOT NULL, timezone TEXT NOT NULL, omitted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS usage_threads (
      thread TEXT PRIMARY KEY, workspace TEXT NOT NULL, provider TEXT NOT NULL,
      delegated INTEGER NOT NULL DEFAULT 0, automation TEXT, skills TEXT
    ) WITHOUT ROWID;
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
    CREATE INDEX IF NOT EXISTS usage_daily_provider ON usage_daily(provider, account, day);
    CREATE INDEX IF NOT EXISTS usage_daily_account ON usage_daily(account, day);
    CREATE TABLE IF NOT EXISTS usage_skill_daily (
      day TEXT NOT NULL, skill TEXT NOT NULL, thread TEXT NOT NULL, agent TEXT NOT NULL, provider TEXT NOT NULL,
      account TEXT NOT NULL, model TEXT NOT NULL, workspace TEXT NOT NULL, billing TEXT NOT NULL,
      input INTEGER NOT NULL, output INTEGER NOT NULL, cached INTEGER NOT NULL, reasoning INTEGER NOT NULL,
      write INTEGER NOT NULL, write1h INTEGER NOT NULL, cost REAL NOT NULL,
      PRIMARY KEY(day, skill, thread, agent, provider, account, model, workspace, billing)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS usage_skill_name ON usage_skill_daily(skill, day);
    CREATE INDEX IF NOT EXISTS usage_skill_thread ON usage_skill_daily(thread, day);
    CREATE TABLE IF NOT EXISTS usage_increments (
      seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, thread TEXT NOT NULL, account TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cost REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_increment_thread ON usage_increments(thread);
    CREATE INDEX IF NOT EXISTS usage_window ON usage_increments(account, at);
    CREATE INDEX IF NOT EXISTS usage_increment_at ON usage_increments(at);
    CREATE TEMP TABLE usage_prices (model TEXT PRIMARY KEY, input REAL, cached REAL, write REAL, write1h REAL, output REAL);
  `);
  const existing = db.prepare("SELECT version, timezone FROM usage_meta WHERE id=1").get();
  if (existing && (existing.version !== 3 || existing.timezone !== timezone))
    throw new Error("Usage projection settings changed; rebuild the derived database");
  db.prepare(
    "INSERT OR IGNORE INTO usage_meta(id,version,cursor,timezone,omitted) VALUES (1, 3, 0, ?, 0)",
  ).run(timezone);
  if (
    ![...db.prepare("PRAGMA table_info(usage_meta)").iterate()].some(
      (row) => row.name === "latest_at",
    )
  )
    db.exec(`ALTER TABLE usage_meta ADD COLUMN latest_at INTEGER NOT NULL DEFAULT 0;
      UPDATE usage_meta SET latest_at=(SELECT COALESCE(MAX(at),0) FROM usage_increments);`);
}
const dimensions = ["thread", "agent", "provider", "account", "model", "workspace", "billing"];
const upsert = (table: string, keys: string[]) => `INSERT INTO ${table}
  SELECT ${[...keys, ...countColumns].map((c) => `json_extract(value, '$.${c}')`).join(", ")}
  FROM json_each(?) WHERE true
  ON CONFLICT(${keys.join(", ")})
  DO UPDATE SET ${countColumns.map((c) => `${c} = ${table}.${c} + excluded.${c}`).join(", ")}`;
export const upsertDaily = upsert("usage_daily", ["day", ...dimensions]);
/** A skill turn's increment, once per skill: these rows overlap and don't sum to the total. */
export const upsertSkillDaily = upsert("usage_skill_daily", ["day", "skill", ...dimensions]);
