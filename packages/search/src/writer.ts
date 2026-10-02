import type { DatabaseSync, StatementSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import type { Event, Thread } from "@ace/protocol";
import { SearchKind } from "@ace/protocol";
import { acceptsDelta } from "@ace/projection";
import { appendWindow, capText, itemText, windowText } from "./text.ts";
import { outputText, type OutputReader } from "./output.ts";
import { StoredText, storeText } from "./encoding.ts";

const Stage = z.object({
  id: z.number(),
  thread: z.string(),
  item: z.string(),
  agent: z.string().nullable(),
  kind: SearchKind,
  tool_kind: z.string().nullable(),
  at: z.number(),
  title: z.string(),
  head: StoredText,
  tail: StoredText,
  size: z.number(),
});
const Document = Stage.omit({ head: true, tail: true, size: true, tool_kind: true }).extend({
  body: z.string(),
});
const Title = z.object({ title: z.string() });
export class Statements {
  private readonly cache = new Map<string, StatementSync>();
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  get(sql: string): StatementSync {
    let statement = this.cache.get(sql);
    if (!statement) {
      if (this.cache.size >= 64) {
        const first = this.cache.keys().next().value;
        if (first !== undefined) this.cache.delete(first);
      }
      statement = this.db.prepare(sql);
      this.cache.set(sql, statement);
    }
    return statement;
  }
  run(sql: string, ...values: SQLInputValue[]): void {
    this.get(sql).run(...values);
  }
}
export class SearchWriter {
  readonly sql: Statements;
  readonly trigrams: boolean;
  private readonly readOutput: OutputReader | undefined;
  constructor(db: DatabaseSync, trigrams: boolean, readOutput?: OutputReader) {
    this.readOutput = readOutput;
    this.trigrams = trigrams;
    this.sql = new Statements(db);
  }
  stage(event: Event): void {
    const p = event.payload;
    if (p.type === "thread.created") {
      const t = p.thread;
      this.observeThread(t, event.seq);
      this.put(
        event.threadId,
        "",
        null,
        "thread",
        t.createdAt,
        this.currentTitle(event.threadId),
        "",
        "",
        0,
        true,
        event.seq,
        null,
      );
    } else if (p.type === "thread.updated") {
      const changes = this.sql
        .get(
          "UPDATE search_threads SET status=COALESCE(?,status),title=COALESCE(?,title),seq=? WHERE id=? AND seq<?",
        )
        .run(
          p.status?.state ?? null,
          p.title === undefined ? null : capText(p.title),
          event.seq,
          event.threadId,
          event.seq,
        ).changes;
      if (changes && (p.status || p.title !== undefined))
        this.sql.run("UPDATE search_meta SET generation=generation+1 WHERE id=1");
      if (p.title !== undefined) this.stageTitle(event.threadId, event.seq);
    } else if (p.type === "item.created" || p.type === "item.updated") {
      const detail = p.item.type === "tool_call" ? p.item.call.detail : undefined;
      const output =
        detail?.kind === "shell" && detail.output
          ? outputText(this.readOutput, event.threadId, detail.output)
          : undefined;
      const { title, window } = itemText(p.item, output);
      this.put(
        event.threadId,
        p.item.id,
        p.item.agentId,
        p.item.type,
        p.item.createdAt,
        title,
        window.head,
        window.tail,
        window.size,
        p.item.complete,
        event.seq,
        detail?.kind ?? null,
      );
    } else if (p.type === "item.delta") {
      const value = this.sql
        .get("SELECT * FROM search_stage WHERE thread=? AND item=?")
        .get(event.threadId, p.itemId);
      if (!value) return;
      const row = Stage.parse(value);
      if (row.kind === "thread" || !acceptsDelta(row.kind, p.field, row.tool_kind ?? undefined))
        return;
      const window = appendWindow(row, p.append);
      this.sql.run(
        "UPDATE search_stage SET head=?,tail=?,size=?,dirty_since=CASE WHEN dirty=0 THEN ? ELSE dirty_since END,dirty=1 WHERE id=?",
        storeText(window.head),
        storeText(window.tail),
        window.size,
        event.seq,
        row.id,
      );
    } else if (p.type === "item.deleted") this.deleteItem(event.threadId, p.itemId);
  }
  observeThread(thread: Thread, seq: number): void {
    const changes = this.sql
      .get(
        "INSERT INTO search_threads VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET workspace=excluded.workspace,provider=excluded.provider,status=excluded.status,title=excluded.title,seq=excluded.seq WHERE search_threads.seq<excluded.seq",
      )
      .run(
        thread.id,
        thread.workspaceId,
        thread.provider,
        thread.status.state,
        capText(thread.title),
        seq,
      ).changes;
    if (changes) {
      this.sql.run("UPDATE search_meta SET generation=generation+1 WHERE id=1");
      this.stageTitle(thread.id, seq);
    }
  }
  private currentTitle(thread: string): string {
    return Title.parse(this.sql.get("SELECT title FROM search_threads WHERE id=?").get(thread))
      .title;
  }
  private stageTitle(thread: string, seq: number): void {
    const title = this.currentTitle(thread);
    this.sql.run(
      "UPDATE search_stage SET title=?,dirty_since=CASE WHEN dirty=0 THEN ? ELSE dirty_since END,dirty=1 WHERE thread=? AND item='' AND title<>?",
      title,
      seq,
      thread,
      title,
    );
  }
  private put(
    thread: string,
    item: string,
    agent: string | null,
    kind: string,
    at: number,
    title: string,
    head: string,
    tail: string,
    size: number,
    complete: boolean,
    seq: number,
    toolKind: string | null,
  ): void {
    this.sql.run(
      `INSERT INTO search_stage(thread,item,agent,kind,at,title,head,tail,size,dirty,complete,dirty_since,tool_kind) VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)
      ON CONFLICT(thread,item) DO UPDATE SET agent=excluded.agent,kind=excluded.kind,at=excluded.at,title=excluded.title,head=excluded.head,tail=excluded.tail,size=excluded.size,tool_kind=excluded.tool_kind,dirty_since=CASE WHEN search_stage.dirty=0 THEN excluded.dirty_since ELSE search_stage.dirty_since END,dirty=1,complete=excluded.complete`,
      thread,
      item,
      agent,
      kind,
      at,
      title,
      storeText(head),
      storeText(tail),
      size,
      Number(complete),
      seq,
      toolKind,
    );
  }
  private removePostings(row: z.infer<typeof Document>): void {
    this.sql.run(
      "INSERT INTO search_prose(search_prose,rowid,title,body) VALUES ('delete',?,?,?)",
      row.id,
      row.title,
      row.body,
    );
    if (this.trigrams)
      this.sql.run(
        "INSERT INTO search_trigram(search_trigram,rowid,title,body) VALUES ('delete',?,?,?)",
        row.id,
        row.title,
        row.body,
      );
    if (row.kind === "thread") {
      this.sql.run(
        "INSERT INTO search_titles(search_titles,rowid,title) VALUES ('delete',?,?)",
        row.id,
        row.title,
      );
      if (this.trigrams)
        this.sql.run(
          "INSERT INTO search_title_trigram(search_title_trigram,rowid,title) VALUES ('delete',?,?)",
          row.id,
          row.title,
        );
    }
  }
  flush(where: "dirty=1" | "dirty=1 AND complete=1", limit: number): number {
    const rows = this.sql
      .get(`SELECT * FROM search_stage WHERE ${where} ORDER BY dirty_since,id LIMIT ?`)
      .all(limit);
    for (const value of rows) {
      const row = Stage.parse(value);
      const old = this.sql.get("SELECT * FROM search_docs WHERE id=?").get(row.id);
      if (old) this.removePostings(Document.parse(old));
      // Reserve snippet delimiters. They are never emitted as HTML.
      const title = row.title.replaceAll("\u0001", " ").replaceAll("\u0002", " ");
      const body = windowText(row).replaceAll("\u0001", " ").replaceAll("\u0002", " ");
      this.sql.run(
        `INSERT INTO search_docs VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        agent=excluded.agent,kind=excluded.kind,at=excluded.at,title=excluded.title,body=excluded.body`,
        row.id,
        row.thread,
        row.item,
        row.agent,
        row.kind,
        row.at,
        title,
        body,
      );
      this.sql.run(
        "INSERT INTO search_prose(rowid,title,body) VALUES (?,?,?)",
        row.id,
        title,
        body,
      );
      if (this.trigrams)
        this.sql.run(
          "INSERT INTO search_trigram(rowid,title,body) VALUES (?,?,?)",
          row.id,
          title,
          body,
        );
      if (row.kind === "thread") {
        this.sql.run("INSERT INTO search_titles(rowid,title) VALUES (?,?)", row.id, title);
        if (this.trigrams)
          this.sql.run("INSERT INTO search_title_trigram(rowid,title) VALUES (?,?)", row.id, title);
      }
      this.sql.run("UPDATE search_stage SET dirty=0 WHERE id=?", row.id);
    }
    if (rows.length)
      this.sql.run(
        "UPDATE search_meta SET writes=writes+?,generation=generation+1 WHERE id=1",
        rows.length,
      );
    return rows.length;
  }
  deleteItem(thread: string, item: string): void {
    const row = this.sql
      // The stage's unique key resolves directly to the document primary key,
      // including misses for staged items which have never been indexed.
      .get(
        "SELECT * FROM search_docs WHERE id=(SELECT id FROM search_stage WHERE thread=? AND item=?)",
      )
      .get(thread, item);
    if (row) {
      this.removePostings(Document.parse(row));
      this.sql.run("DELETE FROM search_docs WHERE id=?", Document.parse(row).id);
    }
    this.sql.run("DELETE FROM search_stage WHERE thread=? AND item=?", thread, item);
    this.sql.run("UPDATE search_meta SET generation=generation+1 WHERE id=1");
  }
}
