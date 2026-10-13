import { z } from "zod";
import { AgentConversationRecord, type ThreadId, type McpAttribution } from "@ace/protocol";
import type { Store } from "../store.ts";

/** Conversation ownership is distinct from child edges and never contributes to parent status. */
export class ConversationJournal {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS agent_conversations (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
      owner_thread TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      owner_agent TEXT NOT NULL, root_id TEXT NOT NULL, request_id TEXT NOT NULL, record TEXT NOT NULL,
      UNIQUE(owner_thread,request_id)
    ); CREATE INDEX IF NOT EXISTS agent_conversations_owner ON agent_conversations(owner_thread,thread_id);
    CREATE INDEX IF NOT EXISTS agent_conversations_root ON agent_conversations(root_id,thread_id);`),
    );
  }
  private decode(row: unknown) {
    if (!row) return undefined;
    return AgentConversationRecord.parse(
      JSON.parse(z.object({ record: z.string() }).parse(row).record),
    );
  }
  get(thread: ThreadId) {
    return this.store.atomic((db) =>
      this.decode(
        db.prepare("SELECT record FROM agent_conversations WHERE thread_id=?").get(thread),
      ),
    );
  }
  receipt(caller: McpAttribution, request: string) {
    return this.store.atomic((db) =>
      this.decode(
        db
          .prepare("SELECT record FROM agent_conversations WHERE owner_thread=? AND request_id=?")
          .get(caller.threadId, request),
      ),
    );
  }
  owns(caller: McpAttribution, thread: ThreadId) {
    const record = this.get(thread);
    return record?.ownerThreadId === caller.threadId && record.ownerAgentId === caller.agentId;
  }
  add(record: AgentConversationRecord) {
    this.store.atomic((db) => {
      if (Number(db.prepare("SELECT COUNT(*) AS n FROM agent_conversations").get()?.n) >= 10000)
        throw new Error("Conversation ownership capacity");
      db.prepare("INSERT INTO agent_conversations VALUES (?,?,?,?,?,?)").run(
        record.threadId,
        record.ownerThreadId,
        record.ownerAgentId,
        record.rootId,
        record.request.requestId,
        JSON.stringify(record),
      );
    });
  }
  /** Started conversations still recorded as untouched drafts, which the sidebar leaves out. */
  unlisted(): ThreadId[] {
    return this.store
      .atomic((db) =>
        db
          .prepare(
            `SELECT c.thread_id FROM agent_conversations c JOIN threads t ON t.id=c.thread_id
          WHERE json_extract(t.client,'$.hasSentMessage') = 0 ORDER BY c.thread_id LIMIT 10000`,
          )
          .all(),
      )
      .map(
        (row) =>
          z.object({ thread_id: AgentConversationRecord.shape.threadId }).parse(row).thread_id,
      );
  }
  unenrolledMembers() {
    return this.store
      .atomic((db) =>
        db
          .prepare(
            `SELECT c.thread_id,c.root_id,CASE WHEN json_extract(t.status,'$.state') NOT IN ('done','failed','new')
          AND json_extract(t.client,'$.deletedAt') IS NULL THEN 1 ELSE 0 END AS active
          FROM agent_conversations c JOIN threads t ON t.id=c.thread_id
          WHERE NOT EXISTS (SELECT 1 FROM delegation_participants p WHERE p.thread_id=c.thread_id)
          ORDER BY c.thread_id LIMIT 10000`,
          )
          .all(),
      )
      .map((row) =>
        z
          .object({
            thread_id: AgentConversationRecord.shape.threadId,
            root_id: AgentConversationRecord.shape.rootId,
            active: z.union([z.literal(0), z.literal(1)]),
          })
          .parse(row),
      );
  }
  capacity(parent: ThreadId, root: ThreadId) {
    return this.store.atomic((db) => ({
      concurrent: Number(
        db
          .prepare(`SELECT COUNT(*) AS n FROM agent_conversations c JOIN delegation_participants p ON p.thread_id=c.thread_id JOIN threads t ON t.id=c.thread_id
        WHERE c.owner_thread=? AND p.active=1
        AND json_extract(t.client,'$.deletedAt') IS NULL`)
          .get(parent)?.n,
      ),
      children: Number(
        db.prepare("SELECT COUNT(*) AS n FROM agent_conversations WHERE root_id=?").get(root)?.n,
      ),
    }));
  }
}
