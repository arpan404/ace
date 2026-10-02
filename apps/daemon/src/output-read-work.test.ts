import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { Store, createDevThread } from "./index.ts";
import { shell } from "./payload-test-support.ts";
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
