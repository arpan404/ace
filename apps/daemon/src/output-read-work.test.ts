import { DatabaseSync, type PrepareOptions } from "node:sqlite";
import { expect, it } from "vitest";
import { Store, createDevThread } from "./index.ts";
import { shell } from "./payload-test-support.ts";

class ByteBudgetDatabase extends DatabaseSync {
  private remaining: number | undefined;
  constructor() {
    super(":memory:");
    this.function("read_budget", (value) => {
      if (!(value instanceof Uint8Array)) throw new Error("Invalid body");
      if (this.remaining !== undefined) {
        if (this.remaining === 0) throw new Error("Fetched output at EOF");
        this.remaining -= value.byteLength;
        if (this.remaining < 0) throw new Error("Fetched more output bytes than requested");
      }
      return value;
    });
  }
  budget(bytes: number): void {
    this.remaining = bytes;
  }
  override prepare(sql: string, options?: PrepareOptions) {
    // Meter the query's projected BLOB, after SQLite slicing and before JS materialization.
    // Keep the real database, range predicates and indexes.
    if (sql.includes("FROM output_chunks") && sql.includes("bytes"))
      sql = `SELECT offset, read_budget(bytes) AS bytes FROM (${sql}) ORDER BY offset`;
    return super.prepare(sql, options);
  }
}

it("reads only the requested bytes from an existing oversized output chunk", () => {
  const db = new ByteBudgetDatabase();
  const store = new Store(":memory:", undefined, { database: db });
  try {
    const thread = createDevThread(store, store.createWorkspace("/repo", "repo"));
    const item = shell();
    const output = "x".repeat(8 * 1024 * 1024) + "😀end";
    store.appendEvents(thread.id, [
      { type: "item.created", item },
      {
        type: "item.delta",
        itemId: item.id,
        agentId: item.agentId,
        field: "output",
        append: output,
      },
      { type: "item.delta", itemId: item.id, agentId: item.agentId, field: "output", append: "!" },
    ]);
    db.budget(1);
    const first = store.readOutput("output:shell", 0, 1);
    expect(first).toEqual({
      bytes: Buffer.from("x").toString("base64"),
      nextOffset: 1,
      eof: false,
    });
    const offset = 8 * 1024 * 1024 + 1;
    db.budget(7);
    const ending = store.readOutput("output:shell", offset, 7);
    expect(Buffer.from(ending.bytes, "base64")).toEqual(Buffer.from("😀end!").subarray(1));
    expect(ending).toMatchObject({ nextOffset: offset + 7, eof: true });
    db.budget(0);
    expect(store.readOutput("output:shell", offset + 7, 1)).toEqual({
      bytes: "",
      nextOffset: offset + 7,
      eof: true,
    });
    expect(store.readOutput("output:shell", offset + 100, 1)).toEqual({
      bytes: "",
      nextOffset: offset + 100,
      eof: true,
    });
  } finally {
    store.close();
  }
});

it("reads a late output range without touching preceding chunk bodies", () => {
  const db = new DatabaseSync(":memory:");
  const store = new Store(":memory:", undefined, { database: db });
  try {
    const thread = createDevThread(store, store.createWorkspace("/repo", "repo"));
    const item = shell();
    store.appendEvents(thread.id, [
      { type: "item.created", item },
      ...Array.from({ length: 200 }, () => ({
        type: "item.delta" as const,
        itemId: item.id,
        agentId: item.agentId,
        field: "output" as const,
        append: "x",
      })),
    ]);
    // Keep real SQLite indexing, but meter body accesses through a SQL view.
    // A read budget is deterministic; no elapsed-time assertion is involved.
    let bodyReads = 0;
    db.function("read_body", (value) => {
      if (++bodyReads > 2) throw new Error("read preceding chunk bodies");
      if (!(value instanceof Uint8Array)) throw new Error("Invalid body");
      return value;
    });
    db.exec(
      "ALTER TABLE output_chunks RENAME TO metered_chunks; CREATE VIEW output_chunks AS SELECT stream_id, offset, read_body(bytes) AS bytes FROM metered_chunks",
    );
    const result = store.readOutput("output:shell", 199, 1);
    expect(Buffer.from(result.bytes, "base64").toString()).toBe("x");
    expect(result).toMatchObject({ nextOffset: 200, eof: true });
  } finally {
    store.close();
  }
});
