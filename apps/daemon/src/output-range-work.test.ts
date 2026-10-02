import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { Store, createDevThread } from "./index.ts";
import { shell } from "./payload-test-support.ts";

it("one-byte output reads transfer only the selected byte from a legacy multi-megabyte chunk", () => {
  const db = new DatabaseSync(":memory:");
  const store = new Store(":memory:", undefined, { database: db });
  try {
    const thread = createDevThread(store, store.createWorkspace("/repo", "repo"));
    const item = shell();
    store.appendEvents(thread.id, [
      { type: "item.created", item },
      { type: "item.delta", itemId: item.id, agentId: item.agentId, field: "output", append: "x" },
    ]);
    // A restored database can contain one huge append, even when new writes are chunked.
    db.prepare("UPDATE output_chunks SET bytes = ? WHERE stream_id = ?").run(
      Buffer.from("x".repeat(8 * 1024 * 1024)),
      "output:shell",
    );
    db.prepare("UPDATE output_streams SET size = ? WHERE id = ?").run(
      8 * 1024 * 1024,
      "output:shell",
    );
    const original = db.prepare.bind(db);
    let transferred = 0;
    db.prepare = (sql) => {
      const statement = original(sql);
      const all = statement.all.bind(statement);
      statement.all = (...args) =>
        all(
          ...args.map((value) =>
            z
              .union([z.string(), z.number(), z.bigint(), z.null(), z.instanceof(Uint8Array)])
              .parse(value),
          ),
        ).map((row) => {
          if (row.bytes instanceof Uint8Array) transferred += row.bytes.length;
          return row;
        });
      return statement;
    };
    const result = store.readOutput("output:shell", 7 * 1024 * 1024, 1);
    expect(Buffer.from(result.bytes, "base64").toString()).toBe("x");
    expect(transferred).toBe(1);
    expect(result.nextOffset).toBe(7 * 1024 * 1024 + 1);
  } finally {
    store.close();
  }
});
