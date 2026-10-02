import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AgentId, Event, Thread, Item, type EventPayload, type SearchQuery } from "@ace/protocol";
import { SearchIndex, type SearchSource } from "./index.ts";
import { summarizeOutput } from "@ace/projection";

const outputFixtures = new WeakMap<Item, string>();

export const thread = Thread.parse({
  id: randomUUID(),
  workspaceId: randomUUID(),
  provider: "codex",
  title: "Compiler project",
  status: { state: "working", agents: 1 },
  createdAt: 10,
  updatedAt: 10,
});
export const agent = AgentId.parse(randomUUID());
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
    this.db.exec("CREATE TABLE IF NOT EXISTS outputs(id TEXT PRIMARY KEY, bytes BLOB NOT NULL)");
    this.index = new SearchIndex(this.db, {
      readOutput: (_threadId, streamId, offset, limit) => {
        const bytes = this.db
          .prepare("SELECT substr(bytes,?,?) AS bytes FROM outputs WHERE id=?")
          .get(offset + 1, limit, streamId)?.bytes;
        if (bytes === undefined) return undefined;
        if (!(bytes instanceof Uint8Array)) throw new Error("Invalid fixture bytes");
        return bytes;
      },
    });
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
      for (const payload of payloads) {
        if (payload.type === "item.created" || payload.type === "item.updated") {
          const output = outputFixtures.get(payload.item);
          if (
            output !== undefined &&
            payload.item.type === "tool_call" &&
            payload.item.call.detail.kind === "shell"
          )
            this.db
              .prepare(
                "INSERT INTO outputs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET bytes=excluded.bytes",
              )
              .run(payload.item.call.detail.output?.streamId ?? "", Buffer.from(output));
        }
      }
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

export function shell(output: string, complete = true): Item {
  const id = randomUUID();
  const item = Item.parse({
    id,
    agentId: agent,
    createdAt: 20,
    complete,
    type: "tool_call",
    call: {
      id,
      agentId: agent,
      kind: "shell",
      title: "Build output",
      status: complete ? "succeeded" : "running",
      startedAt: 20,
      detail: { kind: "shell", command: "build", output: summarizeOutput(id, output) },
      raw: [],
    },
  });
  outputFixtures.set(item, output);
  return item;
}
