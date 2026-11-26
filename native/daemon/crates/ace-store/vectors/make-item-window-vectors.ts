// SPDX-License-Identifier: Apache-2.0

/*
 * Produces `item-window.json`, the fixture T4's `items.window` read is proved against.
 *
 *   bun native/daemon/crates/ace-store/vectors/make-item-window-vectors.ts
 *
 * A real Store is seeded with a thread of messages, a tool call and a notice; `itemsWindow` is
 * asked around a sequence, the newest, an item id, a missing id, a turn ordinal and with
 * `wholeTurns`, and its response (minus the message's `type`/`requestId`/`seq`) is recorded. The
 * six item tables and the long-thread index rows (`long_items`, `long_turns`) are dumped so the
 * Rust test rebuilds the same home in memory and must produce the same windows.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import type { Event, ThreadId } from "@ace/protocol";
import { createDevThread } from "../../../../../apps/daemon/src/commands.ts";
import { message } from "../../../../../apps/daemon/src/payload-test-support.ts";
import { Store } from "../../../../../apps/daemon/src/store.ts";
import { stable, writeVectors } from "../../../vectors/vectors-io.ts";

const json = (value: unknown): string => JSON.stringify(value);
const home = mkdtempSync(join(tmpdir(), "ace-item-window-"));
const path = join(home, "events.sqlite");
const store = new Store(path);

const workspace = store.createWorkspace("/repo", "Repo", 1);
const thread = createDevThread(store, workspace);
const id = thread.id as ThreadId;
let at = 10;
const append = (payloads: Event["payload"][]) => {
  at += 1;
  store.appendEvents(id, payloads, at);
};
for (let index = 0; index < 12; index += 1)
  append([{ type: "item.created", item: message(`m${index}`, `text of m${index}`) }]);
append([
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
]);
append([
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
]);

const m5 = store.itemCreatedSeq(id, "m5" as never) ?? 0;
const newest = store.itemCreatedSeq(id, "notice" as never) ?? 0;

type Case = {
  name: string;
  aroundSeq?: number;
  itemId?: string;
  turnOrdinal?: number;
  before?: number;
  after?: number;
  wholeTurns?: boolean;
};

const cases: Case[] = [
  { name: "a window around a middle item", aroundSeq: m5, before: 2, after: 2 },
  {
    name: "a window from the thread's start lands on the newest",
    aroundSeq: 0,
    before: 2,
    after: 2,
  },
  {
    name: "a window past the end lands on the newest",
    aroundSeq: newest + 100,
    before: 1,
    after: 1,
  },
  { name: "a window on an item id", itemId: "m3", before: 1, after: 1 },
  { name: "a missing item id is an empty window", itemId: "gone", before: 1, after: 1 },
  { name: "a window in whole turns", aroundSeq: m5, before: 3, after: 1, wholeTurns: true },
  { name: "a window on a turn ordinal", turnOrdinal: 1, before: 2, after: 2 },
];

const recorded = cases.map((query) => {
  const base = { threadId: id } as Record<string, unknown>;
  const input = {
    ...base,
    ...(query.aroundSeq !== undefined ? { aroundSeq: query.aroundSeq } : {}),
    ...(query.itemId !== undefined ? { itemId: query.itemId } : {}),
    ...(query.turnOrdinal !== undefined ? { turnOrdinal: query.turnOrdinal } : {}),
    ...(query.before !== undefined ? { before: query.before } : {}),
    ...(query.after !== undefined ? { after: query.after } : {}),
    ...(query.wholeTurns !== undefined ? { wholeTurns: query.wholeTurns } : {}),
  };
  try {
    const {
      type: _type,
      requestId: _requestId,
      seq: _seq,
      ...window
    } = store.itemsWindow(input as never);
    return {
      name: query.name,
      query: json(query),
      threadId: String(id),
      expected: json(window),
      error: null,
    };
  } catch (thrown) {
    return {
      name: query.name,
      query: json(query),
      threadId: String(id),
      expected: null,
      error: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
});
store.close();

const tables = [
  "items",
  "item_heads",
  "item_previews",
  "item_text_streams",
  "item_source_chunks",
  "item_text_chunks",
  "long_items",
  "long_turns",
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
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
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

writeVectors(
  join(import.meta.dir, "item-window.json"),
  stable({ schema, inserts, cases: recorded }),
);
