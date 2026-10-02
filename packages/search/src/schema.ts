import type { DatabaseSync } from "node:sqlite";

export function migrateSearch(db: DatabaseSync, trigrams: boolean): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_meta (
      id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL,
      seq INTEGER NOT NULL, generation INTEGER NOT NULL, writes INTEGER NOT NULL, trigrams INTEGER NOT NULL,
      pending INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS search_threads (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS search_stage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT NOT NULL, item TEXT NOT NULL,
      agent TEXT, kind TEXT NOT NULL, at INTEGER NOT NULL, title TEXT NOT NULL, tool_kind TEXT,
      head TEXT NOT NULL, tail TEXT NOT NULL, size INTEGER NOT NULL,
      dirty INTEGER NOT NULL, complete INTEGER NOT NULL, dirty_since INTEGER NOT NULL,
      UNIQUE(thread,item)
    );
    CREATE INDEX IF NOT EXISTS search_dirty ON search_stage(dirty_since,id) WHERE dirty=1;
    CREATE INDEX IF NOT EXISTS search_ready ON search_stage(complete,dirty_since,id) WHERE dirty=1;
    CREATE INDEX IF NOT EXISTS search_stage_thread ON search_stage(thread);
    CREATE TABLE IF NOT EXISTS search_docs (
      id INTEGER PRIMARY KEY, thread TEXT NOT NULL, item TEXT NOT NULL,
      agent TEXT, kind TEXT NOT NULL, at INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS search_docs_thread ON search_docs(thread);
    CREATE INDEX IF NOT EXISTS search_recent_titles ON search_docs(kind,at DESC,id);
    CREATE VIRTUAL TABLE IF NOT EXISTS search_prose USING fts5(title,body,content='search_docs',content_rowid='id',tokenize='unicode61');
    CREATE VIRTUAL TABLE IF NOT EXISTS search_titles USING fts5(title,content='search_docs',content_rowid='id',tokenize='unicode61',prefix='2 3 4');
  `);
  const row = db.prepare("SELECT version,trigrams FROM search_meta WHERE id=1").get();
  if (row && (row.version !== 3 || row.trigrams !== Number(trigrams)))
    throw new Error("Search configuration differs from database");
  db.prepare("INSERT OR IGNORE INTO search_meta VALUES (1,3,0,0,0,?,0)").run(Number(trigrams));
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS search_pending_insert AFTER INSERT ON search_stage WHEN NEW.dirty=1
      BEGIN UPDATE search_meta SET pending=pending+1 WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS search_pending_update AFTER UPDATE OF dirty ON search_stage WHEN NEW.dirty<>OLD.dirty
      BEGIN UPDATE search_meta SET pending=pending+NEW.dirty-OLD.dirty WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS search_pending_delete AFTER DELETE ON search_stage WHEN OLD.dirty=1
      BEGIN UPDATE search_meta SET pending=pending-1 WHERE id=1; END;
  `);
  if (trigrams)
    db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS search_trigram USING fts5(title,body,content='search_docs',content_rowid='id',tokenize='trigram');
    CREATE VIRTUAL TABLE IF NOT EXISTS search_title_trigram USING fts5(title,content='search_docs',content_rowid='id',tokenize='trigram');
  `);
}
