import type { DatabaseSync } from "node:sqlite";

/** Additive tables have their own replay cursor; existing global indexes stay usable. */
export function migrateThreadSearch(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_full_meta(id INTEGER PRIMARY KEY CHECK(id=1),seq INTEGER NOT NULL,pending INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO search_full_meta VALUES(1,0,0);
    CREATE TABLE IF NOT EXISTS search_full_items(
      thread TEXT NOT NULL,item TEXT NOT NULL,seq INTEGER NOT NULL,kind TEXT NOT NULL,
      tool_kind TEXT,delta_segment INTEGER,PRIMARY KEY(thread,item)
    );
    CREATE TABLE IF NOT EXISTS search_full_segments(
      id INTEGER PRIMARY KEY AUTOINCREMENT,thread TEXT NOT NULL,item TEXT NOT NULL,
      name TEXT NOT NULL,category TEXT NOT NULL,stream TEXT,encoding TEXT,
      target INTEGER NOT NULL DEFAULT 0,offset INTEGER NOT NULL DEFAULT 0,
      tail TEXT NOT NULL DEFAULT 't',chunk_id INTEGER,dirty INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL,
      UNIQUE(thread,item,name)
    );
    CREATE TRIGGER IF NOT EXISTS search_full_pending_insert AFTER INSERT ON search_full_segments WHEN NEW.offset<NEW.target OR NEW.dirty=1 BEGIN
      UPDATE search_full_meta SET pending=pending+1 WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS search_full_pending_update AFTER UPDATE OF offset,target,dirty ON search_full_segments BEGIN
      UPDATE search_full_meta SET pending=pending+(NEW.offset<NEW.target OR NEW.dirty=1)-(OLD.offset<OLD.target OR OLD.dirty=1) WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS search_full_pending_delete AFTER DELETE ON search_full_segments WHEN OLD.offset<OLD.target OR OLD.dirty=1 BEGIN
      UPDATE search_full_meta SET pending=pending-1 WHERE id=1; END;
    CREATE INDEX IF NOT EXISTS search_full_pending ON search_full_segments(id) WHERE offset<target;
    CREATE INDEX IF NOT EXISTS search_full_dirty ON search_full_segments(id) WHERE dirty=1;
    CREATE TABLE IF NOT EXISTS search_full_chunks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,segment INTEGER NOT NULL,
      thread TEXT NOT NULL,item TEXT NOT NULL,seq INTEGER NOT NULL,category TEXT NOT NULL,body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS search_full_chunk_segment ON search_full_chunks(segment,id);
    CREATE INDEX IF NOT EXISTS search_full_chunk_item ON search_full_chunks(thread,item,id);
    CREATE VIRTUAL TABLE IF NOT EXISTS search_full_fts USING fts5(body,thread,category,content='search_full_chunks',content_rowid='id',tokenize='unicode61');
    CREATE TRIGGER IF NOT EXISTS search_full_insert AFTER INSERT ON search_full_chunks BEGIN
      INSERT INTO search_full_fts(rowid,body,thread,category) VALUES(NEW.id,NEW.body,NEW.thread,NEW.category); END;
    CREATE TRIGGER IF NOT EXISTS search_full_delete AFTER DELETE ON search_full_chunks BEGIN
      INSERT INTO search_full_fts(search_full_fts,rowid,body,thread,category) VALUES('delete',OLD.id,OLD.body,OLD.thread,OLD.category); END;
    CREATE TRIGGER IF NOT EXISTS search_full_update AFTER UPDATE OF body ON search_full_chunks BEGIN
      INSERT INTO search_full_fts(search_full_fts,rowid,body,thread,category) VALUES('delete',OLD.id,OLD.body,OLD.thread,OLD.category);
      INSERT INTO search_full_fts(rowid,body,thread,category) VALUES(NEW.id,NEW.body,NEW.thread,NEW.category); END;
  `);
}
