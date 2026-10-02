import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Event, Thread, Item, type EventPayload, type SearchQuery } from "@ace/protocol";
import { SearchIndex, type SearchSource } from "./index.ts";

export const thread = Thread.parse({
  id: randomUUID(),
  workspaceId: randomUUID(),
  provider: "codex",
  title: "Compiler project",
  status: { state: "working", agents: 1 },
  createdAt: 10,
  updatedAt: 10,
});
export const agent = randomUUID();
export function message(text: string, complete = true): Item {
  return Item.parse({
    id: randomUUID(),
    agentId: agent,
    createdAt: 20,
    complete,
    type: "message",
    role: "assistant",
    parts: [{ type: "text", text }],
  });
}
/** Test source is an actual durable event log, read in bounded sequence order. */
export class Log implements SearchSource {
  readonly db: DatabaseSync;
  readonly index: SearchIndex;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS log(seq INTEGER PRIMARY KEY, event TEXT NOT NULL)");
    this.index = new SearchIndex(this.db);
  }
  headSeq(): number {
    return Number(this.db.prepare("SELECT coalesce(max(seq),0) n FROM log").get()?.n);
  }
  readEvents(options: { afterSeq: number; limit: number }): Event[] {
    return this.db
      .prepare("SELECT event FROM log WHERE seq>? ORDER BY seq LIMIT ?")
      .all(options.afterSeq, options.limit)
      .map((row) => Event.parse(JSON.parse(String(row.event))));
  }
  append(payloads: EventPayload[], threadId = thread.id): void {
    this.persist(payloads, threadId, (events) => this.index.append(events));
  }
  history(payloads: EventPayload[], threadId = thread.id): void {
    this.persist(payloads, threadId, () => {});
  }
  private persist(
    payloads: EventPayload[],
    threadId: string,
    consume: (events: Event[]) => void,
  ): void {
    this.db.exec("BEGIN");
    try {
      let seq = this.headSeq();
      const events = payloads.map((payload) =>
        Event.parse({ seq: ++seq, id: randomUUID(), threadId, at: 30, payload }),
      );
      const insert = this.db.prepare("INSERT INTO log VALUES (?,?)");
      for (const event of events) insert.run(event.seq, JSON.stringify(event));
      consume(events);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  query(text: string, options: Partial<SearchQuery> = {}) {
    return this.index.query({ text, ...options });
  }
  close(): void {
    this.db.close();
  }
}
