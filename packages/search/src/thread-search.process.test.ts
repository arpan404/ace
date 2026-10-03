import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "vitest";
import { AgentId, Event, Item, Thread, type ThreadSearchRequest } from "@ace/protocol";
import { Log, agent, message, shell, thread } from "./test-support.ts";

let directory: string;
let log: Log;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ace-thread-search-"));
  log = new Log(join(directory, "events.sqlite"));
  log.append([{ type: "thread.created", thread }]);
});
afterEach(() => {
  log.close();
  rmSync(directory, { recursive: true, force: true });
});
function query(text: string, options: Partial<ThreadSearchRequest> = {}, threadIds?: string[]) {
  return log.index.threadQuery(
    { type: "thread.search", requestId: "search", threadId: thread.id, text, ...options },
    {
      headSeq: log.headSeq(),
      ...(threadIds ? { threadIds } : {}),
      turnOrdinalForItem: () => 7,
    },
  );
}

test("search finds full message interiors and returns creation sequence, turn and literal highlights", () => {
  const item = message(
    "prefix " + "padding ".repeat(4000) + "😀 café middleneedle " + "padding ".repeat(4000),
  );
  log.append([{ type: "item.created", item }]);
  const page = query("cafe middleneedle", { filter: "messages" });
  expect(page.hits).toHaveLength(1);
  expect(page.hits[0]?.itemId).toBe(item.id);
  expect(page.hits[0]?.seq).toBe(2);
  expect(page.hits[0]?.turnOrdinal).toBe(7);
  const snippet = page.hits[0]?.snippet;
  expect(snippet?.highlights.map((mark) => snippet.text.slice(mark.start, mark.end))).toEqual([
    "café",
    "middleneedle",
  ]);
  expect(page.ready).toBe(true);
});

test("a long whitespace prefix cannot push the highlighted hit outside the snippet budget", () => {
  const item = message(" ".repeat(6000) + "whitespaceneedle");
  log.append([{ type: "item.created", item }]);
  const hit = query("whitespaceneedle").hits[0];
  expect(hit?.snippet.text.length).toBeLessThanOrEqual(4096);
  expect(
    hit?.snippet.highlights.map((mark) => hit.snippet.text.slice(mark.start, mark.end)),
  ).toEqual(["whitespaceneedle"]);
});

test("all query terms can occur in separate chunks of the same item", () => {
  const item = message("firstneedle " + "padding ".repeat(4000) + "lastneedle");
  log.append([
    { type: "item.created", item },
    { type: "item.created", item: message("firstneedle") },
    { type: "item.created", item: message("lastneedle") },
  ]);
  expect(query("firstneedle lastneedle").hits.map((hit) => hit.itemId)).toEqual([item.id]);
});

test("words split across deltas and chunk boundaries remain searchable without duplicate item hits", () => {
  const item = message("padding ".repeat(1023) + " bound", false);
  log.append([{ type: "item.created", item }]);
  log.append([
    {
      type: "item.delta",
      itemId: item.id,
      agentId: AgentId.parse(item.agentId),
      field: "text",
      append: "aryneedle " + "padding ".repeat(2000) + " boundaryneedle",
    },
  ]);
  expect(query("boundaryneedle").hits.map((hit) => hit.itemId)).toEqual([item.id]);
  // A field that the canonical projection rejects must never enter search.
  log.append([
    {
      type: "item.delta",
      itemId: item.id,
      agentId: AgentId.parse(item.agentId),
      field: "output",
      append: "invalidneedle",
    },
  ]);
  expect(query("invalidneedle").hits).toEqual([]);
});

test("full shell output indexing resumes after restart and advertises its unfinished byte backlog", () => {
  const item = shell(
    "startneedle " + "padding ".repeat(590000) + " interiorneedle " + "padding ".repeat(100000),
  );
  log.append([{ type: "item.created", item }]);
  expect(query("startneedle", { filter: "tool_output" }).hits[0]?.itemId).toBe(item.id);
  expect(query("interiorneedle").ready).toBe(false);
  log.close();
  log = new Log(join(directory, "events.sqlite"));
  for (let batch = 0; batch < 8; batch++) log.index.flush();
  expect(query("interiorneedle", { filter: "tool_output" }).hits[0]?.itemId).toBe(item.id);
  expect(query("interiorneedle").ready).toBe(true);
});

test("a newer short tool output is searchable while an older large source remains queued", () => {
  const old = shell("padding ".repeat(1_200_000));
  log.append([{ type: "item.created", item: old }]);
  const recent = shell("recentneedle");
  log.append([{ type: "item.created", item: recent }]);
  expect(query("recentneedle", { filter: "tool_output" }).hits[0]?.itemId).toBe(recent.id);
  expect(query("recentneedle").ready).toBe(false);
});

test("missing source bytes stay pending without trapping backfill and resume when storage recovers", async () => {
  const streamId = "temporarily-missing-source";
  const text = "recoverneedle " + " ".repeat(498);
  const item = Item.parse({
    ...message("preview"),
    parts: [
      {
        type: "text",
        text: "preview",
        source: { streamId, bytes: text.length * 2, encoding: "utf-16le" },
      },
    ],
  });
  log.append([{ type: "item.created", item }]);
  await log.index.backfill(log, {
    signal: new AbortController().signal,
    yield: async () => {
      throw new Error("busy loop");
    },
  });
  expect(query("recoverneedle").ready).toBe(false);
  expect(query("recoverneedle").pending).toBe(1);
  log.db.prepare("INSERT INTO outputs VALUES (?,?)").run(streamId, Buffer.from(text, "utf16le"));
  log.index.flush();
  expect(query("recoverneedle").hits[0]?.itemId).toBe(item.id);
  expect(query("recoverneedle").ready).toBe(true);
});

test("search filters distinguish command text, tool output, changed files and failures", () => {
  const command = shell("outputneedle");
  if (command.type !== "tool_call" || command.call.detail.kind !== "shell")
    throw new Error("Expected shell");
  const failed = Item.parse({
    ...command,
    call: {
      ...command.call,
      status: "failed",
      detail: { ...command.call.detail, command: "commandneedle", exitCode: 1 },
    },
  });
  const changed = Item.parse({
    id: randomUUID(),
    agentId: agent,
    createdAt: 30,
    complete: true,
    type: "tool_call",
    call: {
      id: randomUUID(),
      agentId: agent,
      kind: "file.edit",
      title: "Edit",
      status: "succeeded",
      startedAt: 30,
      raw: [],
      detail: {
        kind: "file.edit",
        changes: [{ path: "src/fileneedle.ts", kind: "update", newText: "interiorfile" }],
      },
    },
  });
  log.append([{ type: "item.created", item: command }]);
  log.append([
    { type: "item.updated", item: failed },
    { type: "item.created", item: changed },
    { type: "item.created", item: message("messageneedle") },
  ]);
  for (const [text, filter, id] of [
    ["commandneedle", "commands", failed.id],
    ["outputneedle", "tool_output", failed.id],
    ["fileneedle", "files", changed.id],
    ["commandneedle", "errors", failed.id],
  ] as const)
    expect(query(text, { filter }).hits.map((hit) => hit.itemId)).toEqual([id]);
  expect(query("outputneedle", { filter: "commands" }).hits).toEqual([]);
  expect(query("messageneedle", { filter: "tool_output" }).hits).toEqual([]);
});

test("UTF-16 source chunks preserve astral characters across bounded reads", () => {
  const text = " ".repeat(16383) + "😀 sourceneedle " + "padding ".repeat(10000);
  const streamId = "message-source";
  log.db.prepare("INSERT INTO outputs VALUES (?,?)").run(streamId, Buffer.from(text, "utf16le"));
  const item = Item.parse({
    ...message("preview"),
    parts: [
      {
        type: "text",
        text: "preview",
        source: { streamId, bytes: text.length * 2, encoding: "utf-16le" },
      },
    ],
  });
  log.append([{ type: "item.created", item }]);
  const hit = query("sourceneedle", { filter: "messages" }).hits[0];
  expect(hit?.itemId).toBe(item.id);
  expect(hit?.snippet.text).toContain("😀");
  expect(hit?.snippet.text).not.toContain("�");
});

test("thread identifiers that share FTS tokens cannot disclose another thread", () => {
  const parent = Thread.parse({ ...thread, id: "parent" });
  const unrelated = Thread.parse({ ...thread, id: "parent.child" });
  log.append([{ type: "thread.created", thread: parent }], parent.id);
  log.append([{ type: "thread.created", thread: unrelated }], unrelated.id);
  const own = message("scopeneedle");
  const hidden = message("scopeneedle");
  log.append([{ type: "item.created", item: own }], parent.id);
  log.append([{ type: "item.created", item: hidden }], unrelated.id);
  expect(query("scopeneedle", { threadId: parent.id }).hits.map((hit) => hit.itemId)).toEqual([
    own.id,
  ]);
});

test("tree search uses only supplied descendants and rejects cursors for another scope", () => {
  const child = Thread.parse({ ...thread, id: randomUUID() });
  log.append([{ type: "thread.created", thread: child }], child.id);
  const rootItem = message("scopeword");
  const childItem = message("scopeword");
  log.append([{ type: "item.created", item: rootItem }]);
  log.append([{ type: "item.created", item: childItem }], child.id);
  expect(query("scopeword").hits.map((hit) => hit.itemId)).toEqual([rootItem.id]);
  const page = query("scopeword", { scope: "tree", limit: 1 }, [thread.id, child.id]);
  expect(page.hits[0]?.itemId).toBe(rootItem.id);
  if (!page.cursor) throw new Error("Expected page cursor");
  expect(
    query("scopeword", { scope: "tree", limit: 1, cursor: page.cursor }, [thread.id, child.id])
      .hits[0]?.threadId,
  ).toBe(child.id);
  expect(() => query("scopeword", { cursor: page.cursor ?? undefined })).toThrow(
    "search_invalid_query",
  );
  log.index.deleteThread(child.id);
  expect(
    query("scopeword", { scope: "tree" }, [thread.id, child.id]).hits.map((hit) => hit.itemId),
  ).toEqual([rootItem.id]);
});

test("keyset pages emit each matching item once and leave later append rows to a fresh search", () => {
  const items = Array.from({ length: 5 }, () =>
    message("pageword " + "padding ".repeat(2500) + "pageword"),
  );
  log.append(items.map((item) => ({ type: "item.created", item })));
  const first = query("pageword", { limit: 2 });
  log.append([{ type: "item.created", item: message("pageword") }]);
  const found = first.hits.map((hit) => hit.itemId);
  let cursor = first.cursor;
  while (cursor) {
    const page = query("pageword", { limit: 2, cursor });
    found.push(...page.hits.map((hit) => hit.itemId));
    cursor = page.cursor;
  }
  expect(found).toEqual(items.map((item) => item.id));
  expect(query("pageword").hits).toHaveLength(6);
});

test("replacement and rollback cannot leave stale or uncommitted full-text matches", () => {
  const item = message("oldneedle " + "padding ".repeat(10000));
  log.append([{ type: "item.created", item }]);
  log.append([
    {
      type: "item.updated",
      item: Item.parse({ ...item, parts: [{ type: "text", text: "newneedle" }] }),
    },
  ]);
  expect(query("oldneedle").hits).toEqual([]);
  expect(query("newneedle").hits[0]?.itemId).toBe(item.id);
  log.db.exec("BEGIN");
  log.index.append([
    Event.parse({
      seq: log.headSeq() + 1,
      id: randomUUID(),
      threadId: thread.id,
      at: 30,
      payload: { type: "item.created", item: message("rollbackneedle") },
    }),
  ]);
  log.db.exec("ROLLBACK");
  expect(query("rollbackneedle").hits).toEqual([]);
  expect(query("newneedle").ready).toBe(true);
  log.append([{ type: "item.deleted", itemId: item.id }]);
  expect(query("newneedle").hits).toEqual([]);
});

test("the additive full-text index backfills independently of an already current global index", async () => {
  const item = message("upgradeneedle " + "padding ".repeat(10000));
  log.append([{ type: "item.created", item }]);
  log.db.exec(
    "DROP TABLE search_full_fts;DROP TABLE search_full_chunks;DROP TABLE search_full_segments;DROP TABLE search_full_items;DROP TABLE search_full_meta",
  );
  log.close();
  log = new Log(join(directory, "events.sqlite"));
  expect(query("upgradeneedle").ready).toBe(false);
  await log.index.backfill(log, { signal: new AbortController().signal });
  expect(query("upgradeneedle").hits[0]?.itemId).toBe(item.id);
  expect(query("upgradeneedle").ready).toBe(true);
});

test("live retention acknowledges its eventless sequence before a later append without restart", () => {
  const other = Thread.parse({ ...thread, id: "retained-child" });
  log.append([{ type: "thread.created", thread: other }], other.id);
  log.append([{ type: "item.created", item: message("deletedneedle") }], other.id);
  log.append([{ type: "item.created", item: message("survivingneedle") }]);
  const deletionSeq = log.headSeq() + 1;
  log.db.exec("BEGIN");
  log.index.deleteThread(other.id);
  log.db.prepare("DELETE FROM log WHERE json_extract(event,'$.threadId')=?").run(other.id);
  log.index.acknowledgeDeletion(deletionSeq);
  log.db.exec("COMMIT");
  const item = message("afterretentionneedle");
  const event = Event.parse({
    seq: deletionSeq + 1,
    id: randomUUID(),
    threadId: thread.id,
    at: 40,
    payload: { type: "item.created", item },
  });
  log.db.exec("BEGIN");
  log.db.prepare("INSERT INTO log VALUES (?,?)").run(event.seq, JSON.stringify(event));
  log.index.append([event]);
  log.db.exec("COMMIT");
  expect(query("afterretentionneedle").hits[0]?.itemId).toBe(item.id);
  expect(query("afterretentionneedle").ready).toBe(true);
  expect(log.query("afterretentionneedle").hits[0]?.itemId).toBe(item.id);
  expect(log.index.status(log.headSeq()).ready).toBe(true);
});

test("retention acknowledgement cannot skip history that is still waiting for backfill", async () => {
  const item = message("pendinghistoryneedle");
  log.history([{ type: "item.created", item }]);
  log.index.acknowledgeDeletion(log.headSeq() + 1);
  expect(query("pendinghistoryneedle").hits).toEqual([]);
  expect(log.index.status(log.headSeq()).indexedSeq).toBe(1);
  await log.index.backfill(log, { signal: new AbortController().signal });
  expect(query("pendinghistoryneedle").hits[0]?.itemId).toBe(item.id);
});

test("a selective multi-term cursor keeps its anchor when live appends change term frequency", () => {
  const first = message("earlyword " + "padding ".repeat(2500) + "lateword");
  const second = message("lateword " + "padding ".repeat(2500) + "earlyword");
  log.append([
    { type: "item.created", item: first },
    { type: "item.created", item: second },
    ...Array.from({ length: 3 }, () => ({
      type: "item.created" as const,
      item: message("lateword"),
    })),
  ]);
  const page = query("earlyword lateword", { limit: 1 });
  expect(page.hits[0]?.itemId).toBe(first.id);
  if (!page.cursor) throw new Error("Expected continuation");
  log.append(
    Array.from({ length: 7 }, () => ({
      type: "item.created" as const,
      item: message("earlyword"),
    })),
  );
  expect(
    query("earlyword lateword", { limit: 1, cursor: page.cursor }).hits.map((hit) => hit.itemId),
  ).toEqual([second.id]);
});
