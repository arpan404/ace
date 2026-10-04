import { z } from "zod";
import type { DatabaseSync, StatementSync, SQLInputValue } from "node:sqlite";

export class LongThreadDatabase {
  readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(
      "CREATE TABLE IF NOT EXISTS long_items(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,item_id TEXT NOT NULL,ordinal INTEGER NOT NULL,created_seq INTEGER NOT NULL,role TEXT,preview TEXT NOT NULL DEFAULT '',counters TEXT NOT NULL DEFAULT '{}',agent_id TEXT,PRIMARY KEY(thread_id,item_id))",
    );
    const itemColumns = new Set(
      db
        .prepare("PRAGMA table_info(long_items)")
        .all()
        .map((row) => z.object({ name: z.string() }).parse(row).name),
    );
    if (!itemColumns.has("agent_id")) db.exec("ALTER TABLE long_items ADD COLUMN agent_id TEXT");
    db.exec(`
      CREATE TABLE IF NOT EXISTS long_meta(id INTEGER PRIMARY KEY,seq INTEGER NOT NULL);
      INSERT OR IGNORE INTO long_meta VALUES(1,0);
      CREATE TABLE IF NOT EXISTS long_heads(thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL DEFAULT 0,root TEXT,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS long_turns(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,start_seq INTEGER NOT NULL,end_seq INTEGER NOT NULL,started_at INTEGER NOT NULL,ended_at INTEGER,root_run TEXT,root_outcome TEXT NOT NULL DEFAULT 'active',settled_seq INTEGER,initiating TEXT NOT NULL DEFAULT '',latest TEXT NOT NULL DEFAULT '',PRIMARY KEY(thread_id,ordinal));
      CREATE TABLE IF NOT EXISTS long_runs(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,id TEXT NOT NULL,ordinal INTEGER NOT NULL,root INTEGER NOT NULL,live INTEGER NOT NULL,PRIMARY KEY(thread_id,id));
      CREATE TABLE IF NOT EXISTS long_agents(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,id TEXT NOT NULL,ordinal INTEGER NOT NULL,status TEXT NOT NULL,child_thread TEXT,name TEXT,started_at INTEGER NOT NULL,ended_at INTEGER,last_seq INTEGER NOT NULL,PRIMARY KEY(thread_id,id));
      CREATE INDEX IF NOT EXISTS long_agents_turn ON long_agents(thread_id,ordinal,id);
      CREATE INDEX IF NOT EXISTS long_agents_children ON long_agents(child_thread,thread_id,ordinal) WHERE child_thread IS NOT NULL;
      CREATE TABLE IF NOT EXISTS long_items(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,item_id TEXT NOT NULL,ordinal INTEGER NOT NULL,created_seq INTEGER NOT NULL,role TEXT,preview TEXT NOT NULL DEFAULT '',counters TEXT NOT NULL DEFAULT '{}',agent_id TEXT,PRIMARY KEY(thread_id,item_id));
      CREATE TABLE IF NOT EXISTS long_agent_counts(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,agent_id TEXT NOT NULL,key TEXT NOT NULL,value INTEGER NOT NULL,PRIMARY KEY(thread_id,ordinal,agent_id,key));
      CREATE INDEX IF NOT EXISTS long_items_message_recent ON long_items(thread_id,role,created_seq) WHERE role IS NOT NULL;
      CREATE INDEX IF NOT EXISTS long_items_messages ON long_items(thread_id,ordinal,role,created_seq) WHERE role IS NOT NULL;
      CREATE INDEX IF NOT EXISTS long_items_agent ON long_items(thread_id,ordinal,agent_id,created_seq);
      CREATE TABLE IF NOT EXISTS long_agent_files(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,agent_id TEXT NOT NULL,path TEXT NOT NULL,added INTEGER NOT NULL,removed INTEGER NOT NULL,unknown INTEGER NOT NULL,refs INTEGER NOT NULL,last_seq INTEGER NOT NULL,PRIMARY KEY(thread_id,ordinal,agent_id,path));
      CREATE TABLE IF NOT EXISTS long_file_prefix(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,path TEXT NOT NULL,seq INTEGER NOT NULL,added INTEGER NOT NULL,removed INTEGER NOT NULL,unknown INTEGER NOT NULL,PRIMARY KEY(thread_id,path,seq));
      CREATE INDEX IF NOT EXISTS long_items_turn ON long_items(thread_id,ordinal,created_seq);
      CREATE TABLE IF NOT EXISTS long_entities(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,kind TEXT NOT NULL,id TEXT NOT NULL,ordinal INTEGER NOT NULL,counters TEXT NOT NULL,data TEXT NOT NULL,last_seq INTEGER NOT NULL,PRIMARY KEY(thread_id,kind,id));
      CREATE INDEX IF NOT EXISTS long_entities_turn ON long_entities(thread_id,ordinal,kind,id);
      CREATE INDEX IF NOT EXISTS long_entities_recent ON long_entities(thread_id,kind,last_seq,id);
      CREATE TABLE IF NOT EXISTS long_counts(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,key TEXT NOT NULL,value INTEGER NOT NULL,PRIMARY KEY(thread_id,ordinal,key));
      CREATE TABLE IF NOT EXISTS long_prefix(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,key TEXT NOT NULL,seq INTEGER NOT NULL,at INTEGER NOT NULL,value INTEGER NOT NULL,PRIMARY KEY(thread_id,key,seq));
      CREATE INDEX IF NOT EXISTS long_prefix_time ON long_prefix(thread_id,key,at,seq);
      CREATE TABLE IF NOT EXISTS long_item_files(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,item_id TEXT NOT NULL,path TEXT NOT NULL,ordinal INTEGER NOT NULL,added INTEGER,removed INTEGER,PRIMARY KEY(thread_id,item_id,path));
      CREATE TABLE IF NOT EXISTS long_files(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,path TEXT NOT NULL,added INTEGER NOT NULL,removed INTEGER NOT NULL,unknown INTEGER NOT NULL,refs INTEGER NOT NULL,last_seq INTEGER NOT NULL,PRIMARY KEY(thread_id,ordinal,path));
      CREATE INDEX IF NOT EXISTS long_files_recent ON long_files(thread_id,ordinal,last_seq,path);
      CREATE TABLE IF NOT EXISTS long_commands(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,item_id TEXT NOT NULL,data TEXT NOT NULL,last_seq INTEGER NOT NULL,PRIMARY KEY(thread_id,ordinal,item_id));
      CREATE INDEX IF NOT EXISTS long_commands_recent ON long_commands(thread_id,ordinal,last_seq,item_id);
      CREATE TABLE IF NOT EXISTS long_usage_counters(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(thread_id,id));
      CREATE TABLE IF NOT EXISTS long_read_state(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,device_id TEXT NOT NULL,last_seen_seq INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(thread_id,device_id));
      CREATE INDEX IF NOT EXISTS events_thread_time ON events(thread_id,at,seq);
      CREATE INDEX IF NOT EXISTS long_turns_settled ON long_turns(thread_id,settled_seq,ordinal);
    `);
  }
  sql(text: string): StatementSync {
    let statement = this.statements.get(text);
    if (!statement) {
      if (this.statements.size >= 128) throw new Error("Long-thread statement capacity exceeded");
      statement = this.db.prepare(text);
      this.statements.set(text, statement);
    }
    return statement;
  }
  run(text: string, ...values: SQLInputValue[]): void {
    this.sql(text).run(...values);
  }
  indexedSeq(): number {
    return Number(this.sql("SELECT seq FROM long_meta WHERE id=1").get()?.seq);
  }
}
export const Counters = z.record(z.string(), z.number().int());
export type Counters = z.infer<typeof Counters>;
export function decodeCounters(value: unknown): Counters {
  return Counters.parse(JSON.parse(String(value)));
}
