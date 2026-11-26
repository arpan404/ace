// SPDX-License-Identifier: Apache-2.0

/*
 * Produces `item-page-sql.json`, the fixture T4's SQL item page is proved against.
 *
 *   bun native/daemon/crates/ace-store/vectors/make-item-page-sql-vectors.ts
 *
 * It writes a real Store, seeds a thread with finished and streaming text items, a tool call and
 * a notice, records `readBoundedItemPage`'s answers for a few budgets and cursors, then dumps the
 * six tables the Rust page reads (`items`, `item_heads`, `item_previews`, the text streams and
 * chunks). The Rust test builds that schema and data in an in-memory SQLite, runs the same
 * reads and compares the bytes — including a streaming item's newest text and its offset mark.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Event, ThreadId } from "@ace/protocol";
import { createDevThread } from "../../../../../apps/daemon/src/commands.ts";
import { message } from "../../../../../apps/daemon/src/payload-test-support.ts";
import { Store } from "../../../../../apps/daemon/src/store.ts";
import { stable, writeVectors } from "../../../vectors/vectors-io.ts";

const json = (value: unknown): string => JSON.stringify(value);
const home = mkdtempSync(join(tmpdir(), "ace-item-page-sql-"));
const path = join(home, "events.sqlite");
const store = new Store(path);

const workspace = store.createWorkspace("/repo", "Repo", 1);
const thread = createDevThread(store, workspace);
const id = thread.id as ThreadId;

const append = (payloads: Event["payload"][], at: number) =>
  store.appendEvents(id, payloads, at);

// A finished message whose text is longer than a preview: its page shows the first 4096 units.
append(
  [{ type: "item.created", item: message("finished", "line of finished text\n".repeat(300)) }],
  10,
);
// A message still streaming: its preview shows the newest units, marked with an offset.
append(
  [
    {
      type: "item.created",
      item: {
        id: "streaming",
        agentId: "root",
        type: "message",
        role: "assistant",
        complete: false,
        createdAt: 1,
        parts: [{ type: "text", text: "start\n" }],
      } as never,
    },
  ],
  11,
);
for (let index = 0; index < 40; index += 1)
  append(
    [
      {
        type: "item.delta",
        itemId: "streaming" as never,
        agentId: "root" as never,
        field: "text",
        append: `streamed ${index} ${"x".repeat(150)}\n`,
      },
    ],
    12 + index,
  );
// A finished reasoning item, a tool call with raw payloads, and a notice.
append(
  [
    {
      type: "item.created",
      item: {
        id: "thinking",
        agentId: "root",
        type: "reasoning",
        complete: true,
        createdAt: 1,
        text: "thought ".repeat(1200),
      } as never,
    },
  ],
  60,
);
append(
  [
    {
      type: "item.created",
      item: {
        id: "tool",
        agentId: "root",
        type: "tool_call",
        complete: true,
        createdAt: 1,
        call: {
          id: "tool",
          agentId: "root",
          kind: "shell",
          title: "ls",
          status: "succeeded",
          detail: { kind: "shell", command: "ls" },
          startedAt: 1,
          raw: [{ type: "message_stop", data: { blob: "A".repeat(2048) } }],
        },
      } as never,
    },
  ],
  61,
);
append(
  [
    {
      type: "item.created",
      item: {
        id: "notice",
        agentId: "root",
        type: "notice",
        level: "info",
        complete: true,
        createdAt: 1,
        text: "a notice",
      } as never,
    },
  ],
  62,
);
// Some smaller messages after them, so a page has several rows.
for (let index = 0; index < 6; index += 1)
  append(
    [{ type: "item.created", item: message(`m${index}`, `plain ${index}`) }],
    70 + index,
  );

const before = Number.MAX_SAFE_INTEGER;
const cases = [
  { name: "a page of finished and streaming text", limit: 10, byteLimit: 1024 * 1024 },
  { name: "a page cut to a small budget", limit: 10, byteLimit: 900 },
  { name: "a page before the newest rows", limit: 3, byteLimit: 1024 * 1024 },
  { name: "a page too small for its newest item", limit: 10, byteLimit: 600 },
].map(({ name, limit, byteLimit }, index) => {
  const cursor = index === 2 ? 62 : before;
  // `readBoundedItemPage` adds the head cursor; the page itself is what this read shapes.
  const { seq: _seq, ...page } = store.readBoundedItemPage(id, cursor, limit, byteLimit);
  return {
    name,
    threadId: String(id),
    before: cursor,
    limit,
    byteLimit,
    expected: json(page),
  };
});
store.close();

// Dump the schema and rows the Rust page reads.
const tables = [
  "items",
  "item_heads",
  "item_previews",
  "item_text_streams",
  "item_source_chunks",
  "item_text_chunks",
];
const db = new DatabaseSync(path);
const names = tables.map((table) => `'${table}'`).join(",");
const schema = (
  db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index') AND tbl_name IN (${names}) ORDER BY name`,
    )
    .all() as { sql: string }[]
).map((row) => row.sql);

const literal = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (value instanceof Uint8Array)
    return `X'${Buffer.from(value).toString("hex")}'`;
  throw new Error(`unexpected SQL value ${typeof value}`);
};
const inserts: string[] = [];
for (const table of tables) {
  const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  for (const row of rows) {
    const columns = Object.keys(row);
    inserts.push(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map((column) => literal(row[column])).join(",")})`,
    );
  }
}
db.close();
rmSync(home, { recursive: true, force: true });

writeVectors(join(import.meta.dir, "item-page-sql.json"), stable({ schema, inserts, cases }));
