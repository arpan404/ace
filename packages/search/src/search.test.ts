import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Event, Item, Thread } from "@ace/protocol";
import { FIELD_CAP } from "./index.ts";
import { summarizeOutput } from "@ace/projection";
import { Log, message, thread, agent, shell } from "./test-support.ts";

let directory: string;
let log: Log;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ace-search-"));
  log = new Log(join(directory, "events.sqlite"));
  log.append([{ type: "thread.created", thread }]);
});
afterEach(() => {
  log.close();
  rmSync(directory, { recursive: true, force: true });
});

test("append, authoritative update and deletion change the searchable transcript", () => {
  const item = message("scarlet compiler");
  log.append([{ type: "item.created", item }]);
  expect(log.query("scarlet").hits.map((h) => h.itemId)).toEqual([item.id]);
  const changed = Item.parse({ ...item, parts: [{ type: "text", text: "emerald compiler" }] });
  log.append([{ type: "item.updated", item: changed }]);
  expect(log.query("scarlet").hits).toEqual([]);
  expect(log.query("emerald").hits[0]?.itemId).toBe(item.id);
  log.append([{ type: "item.deleted", itemId: item.id }]);
  expect(log.query("emerald").hits).toEqual([]);
});

test("stream deltas write one index document per flush batch and completion", () => {
  const item = message("prefix", false);
  log.append([{ type: "item.created", item }]);
  const writes = log.index.status(log.headSeq()).indexWrites;
  for (const append of [" foo", "Bar", " tail"])
    log.append([
      { type: "item.delta", itemId: item.id, agentId: item.agentId, field: "text", append },
    ]);
  expect(log.index.status(log.headSeq()).indexWrites).toBe(writes);
  expect(log.query("fooBar").hits).toEqual([]);
  expect(log.index.flush()).toBe(1);
  expect(log.index.status(log.headSeq()).indexWrites).toBe(writes + 1);
  expect(log.query("fooBar").hits[0]?.itemId).toBe(item.id);
  log.index.flush();
  expect(log.index.status(log.headSeq()).indexWrites).toBe(writes + 1);
  log.append([
    {
      type: "item.delta",
      itemId: item.id,
      agentId: item.agentId,
      field: "text",
      append: " finalword",
    },
  ]);
  log.append([
    {
      type: "item.updated",
      item: Item.parse({
        ...item,
        complete: true,
        parts: [{ type: "text", text: "prefix fooBar tail finalword" }],
      }),
    },
  ]);
  expect(log.index.status(log.headSeq()).indexWrites).toBe(writes + 2);
  expect(log.query("finalword").hits[0]?.itemId).toBe(item.id);
});

test("huge completed and streamed outputs retain head and tail while omitting the middle", () => {
  const text =
    "headneedle " +
    "x".repeat(FIELD_CAP * 3) +
    " middleneedle " +
    "x".repeat(FIELD_CAP * 3) +
    " tailneedle";
  const item = shell(text);
  log.append([{ type: "item.created", item }]);
  expect(log.query("headneedle").hits[0]?.itemId).toBe(item.id);
  expect(log.query("tailneedle").hits[0]?.itemId).toBe(item.id);
  expect(log.query("middleneedle").hits).toEqual([]);
  const streamed = shell("headstream ", false);
  log.append([{ type: "item.created", item: streamed }]);
  for (const append of [
    "x".repeat(FIELD_CAP * 4),
    " middlelost ",
    "x".repeat(FIELD_CAP * 4),
    " tailstream",
  ])
    log.append([
      {
        type: "item.delta",
        itemId: streamed.id,
        agentId: streamed.agentId,
        field: "output",
        append,
      },
    ]);
  log.index.flush();
  expect(log.query("headstream").hits[0]?.itemId).toBe(streamed.id);
  expect(log.query("tailstream").hits[0]?.itemId).toBe(streamed.id);
  expect(log.query("middlelost").hits).toEqual([]);
});

test("tool commands, paths, changes and outputs are searchable but raw payloads are excluded", () => {
  const id = randomUUID();
  const item = Item.parse({
    id,
    agentId: agent,
    createdAt: 50,
    complete: true,
    type: "tool_call",
    call: {
      id,
      agentId: agent,
      kind: "shell",
      title: "Build widget",
      status: "succeeded",
      startedAt: 50,
      detail: {
        kind: "shell",
        command: "run snake_case fooBar",
        cwd: "/src/widget.ts",
        output: summarizeOutput(id, "uniqueoutput"),
      },
      raw: [{ type: "secret", data: "credentialneedle" }],
    },
  });
  log.append([{ type: "item.created", item }]);
  for (const text of ["snake_case", "fooBar", "uniqueoutput", "widget"])
    expect(log.query(text).hits[0]?.itemId).toBe(id);
  expect(log.query("/src/widget.ts", { mode: "substring" }).hits[0]?.itemId).toBe(id);
  expect(log.query("credentialneedle").hits).toEqual([]);
  if (item.type !== "tool_call") throw new Error("Expected tool call");
  const edit = Item.parse({
    ...item,
    call: {
      ...item.call,
      detail: {
        kind: "file.edit",
        changes: [{ path: "src/rename.ts", kind: "update", newText: "newIdentifier" }],
      },
    },
  });
  log.append([{ type: "item.updated", item: edit }]);
  expect(log.query("newIdentifier").hits[0]?.itemId).toBe(id);
  expect(log.query("uniqueoutput").hits).toEqual([]);
});

test("workspace, provider, date, status, agent and kind filters constrain hits", () => {
  const other = Thread.parse({
    ...thread,
    id: randomUUID(),
    workspaceId: randomUUID(),
    provider: "claude",
    status: { state: "done" },
  });
  log.append([{ type: "thread.created", thread: other }], other.id);
  const first = message("filterword");
  const second = Item.parse({
    ...message("filterword"),
    agentId: randomUUID(),
    createdAt: 80,
    type: "notice",
    level: "info",
    text: "filterword",
  });
  log.append([{ type: "item.created", item: first }]);
  log.append([{ type: "item.created", item: second }], other.id);
  for (const filters of [
    { workspaceId: thread.workspaceId },
    { provider: thread.provider },
    { before: 20 },
    { after: 20, before: 20 },
    { status: "working" as const },
    { agentId: first.agentId },
    { kind: "message" as const },
  ])
    expect(log.query("filterword", { filters }).hits.map((h) => h.itemId)).toEqual([first.id]);
  expect(log.query("filterword", { filters: { after: 21 } }).hits.map((h) => h.itemId)).toEqual([
    second.id,
  ]);
  log.append([{ type: "thread.updated", status: { state: "done" } }]);
  expect(log.query("filterword", { filters: { status: "working" } }).hits).toEqual([]);
  expect(
    log.query("filterword", { filters: { workspaceId: thread.workspaceId, status: "done" } })
      .hits[0]?.itemId,
  ).toBe(first.id);
});

test("pagination keeps tied ranks ordered, binds filters and rejects changed generations", () => {
  const items = Array.from({ length: 7 }, () => message("pageneedle"));
  log.append(items.map((item) => ({ type: "item.created", item })));
  const first = log.query("pageneedle", { limit: 2 });
  expect(first.cursor).toBeTruthy();
  const collected = [...first.hits];
  let cursor = first.cursor;
  while (cursor) {
    const page = log.query("pageneedle", { limit: 2, cursor });
    collected.push(...page.hits);
    cursor = page.cursor;
  }
  expect(collected.map((h) => h.itemId)).toEqual(items.map((i) => i.id));
  const firstCursor = first.cursor;
  if (!firstCursor) throw new Error("Expected page cursor");
  expect(() => log.query("different", { cursor: firstCursor })).toThrow("search_invalid_query");
  expect(() => log.query("pageneedle", { cursor: "broken" })).toThrow("search_invalid_query");
  log.append([{ type: "item.created", item: message("pageneedle") }]);
  expect(() => log.query("pageneedle", { cursor: firstCursor })).toThrow("search_cursor_stale");
});

test("title matches rank above body matches and the palette searches only titles with prefixes", () => {
  const titled = Thread.parse({ ...thread, id: randomUUID(), title: "needle" });
  log.append([{ type: "item.created", item: message("needle") }]);
  log.append([{ type: "thread.created", thread: titled }], titled.id);
  const results = log.query("needle");
  expect(results.hits[0]?.threadId).toBe(titled.id);
  expect(log.query("nee", { scope: "threads" }).hits.map((h) => h.threadId)).toEqual([titled.id]);
  log.append([{ type: "thread.updated", title: "renamed" }], titled.id);
  expect(log.query("needle", { scope: "threads" }).hits).toEqual([]);
  expect(log.query("renamed", { scope: "threads" }).hits[0]?.threadId).toBe(titled.id);
  expect(log.query("", { scope: "threads" }).hits).toHaveLength(2);
});

test("Unicode, diacritics, CJK substrings and identifier fragments return literal highlight offsets", () => {
  const item = message("😀 café naïve 東京開発者 snake_case fooBar /src/widget.ts");
  log.append([{ type: "item.created", item }]);
  for (const text of ["cafe", "naive", "snake_case", "fooBar"])
    expect(log.query(text).hits[0]?.itemId).toBe(item.id);
  for (const text of ["京開発", "ake_c", "oBar", "/src/widget"])
    expect(log.query(text, { mode: "substring" }).hits[0]?.itemId).toBe(item.id);
  const hit = log.query("cafe").hits[0];
  expect(hit?.snippet.highlights.map((h) => hit.snippet.text.slice(h.start, h.end))).toEqual([
    "café",
  ]);
  expect(() => log.query("東京", { mode: "substring" })).toThrow("search_invalid_query");
  const literal = message("evil\u0001 markup <script>alert</script>");
  log.append([{ type: "item.created", item: literal }]);
  expect(log.query("evil").hits[0]?.snippet.highlights[0]).toEqual({ start: 0, end: 4 });
});

test("FTS operators and SQL text cannot broaden a literal search or execute statements", () => {
  log.append([
    { type: "item.created", item: message("alpha") },
    { type: "item.created", item: message("beta") },
    { type: "item.created", item: message("alpha OR beta") },
  ]);
  expect(log.query("alpha OR beta").hits).toHaveLength(1);
  expect(log.query('alpha" OR "beta').hits).toHaveLength(1);
  expect(log.query("alpha NOT beta").hits).toEqual([]);
  expect(log.query("x'; DROP TABLE search_docs; --").hits).toEqual([]);
  expect(log.query("alpha").hits).toHaveLength(2);
  expect(() => log.query("***")).toThrow("search_invalid_query");
  expect(() => log.query("x".repeat(513))).toThrow("search_invalid_query");
});

test("backfill yields in bounded batches and resumes durable staging after a simulated crash", async () => {
  const items = Array.from({ length: 600 }, (_, i) => message(`historyword unique${i}`));
  log.history(items.map((item) => ({ type: "item.created", item })));
  const partial = message("recover", false);
  log.history([
    { type: "item.created", item: partial },
    {
      type: "item.delta",
      itemId: partial.id,
      agentId: partial.agentId,
      field: "text",
      append: "able",
    },
  ]);
  let yields = 0;
  await expect(
    log.index.backfill(log, {
      signal: new AbortController().signal,
      yield: async () => {
        yields++;
        throw new Error("simulated crash");
      },
    }),
  ).rejects.toThrow("simulated crash");
  expect(yields).toBe(1);
  expect(log.index.status(log.headSeq()).indexedSeq).toBe(257);
  expect(log.index.status(log.headSeq()).ready).toBe(false);
  log.close();
  log = new Log(join(directory, "events.sqlite"));
  const progress: number[] = [];
  await log.index.backfill(log, {
    signal: new AbortController().signal,
    onProgress: (status) => progress.push(status.indexedSeq),
  });
  expect(progress[0]).toBe(513);
  expect(log.index.status(log.headSeq()).ready).toBe(true);
  expect(log.query("historyword", { limit: 100 }).hits).toHaveLength(100);
  expect(log.query("unique599").hits[0]?.itemId).toBe(items[599]?.id);
  expect(log.query("recoverable").hits[0]?.itemId).toBe(partial.id);
});

test("rollback removes search changes and its checkpoint together with the event append", () => {
  const before = log.index.status(log.headSeq());
  log.db.exec("BEGIN");
  const payload = { type: "item.created" as const, item: message("rollbackneedle") };
  const event = Event.parse({
    seq: log.headSeq() + 1,
    id: randomUUID(),
    threadId: thread.id,
    at: 30,
    payload,
  });
  log.index.append([event]);
  log.db.exec("ROLLBACK");
  expect(log.query("rollbackneedle").hits).toEqual([]);
  expect(log.index.status(log.headSeq())).toEqual(before);
});

test("thread retention removes transcript and title postings without affecting other threads", () => {
  const other = Thread.parse({ ...thread, id: randomUUID(), title: "retentionword" });
  log.append([{ type: "thread.created", thread: other }], other.id);
  log.append([{ type: "item.created", item: message("retentionword") }]);
  log.index.deleteThread(thread.id);
  expect(log.query("retentionword").hits.map((h) => h.threadId)).toEqual([other.id]);
  expect(log.query("Compiler", { scope: "threads" }).hits).toEqual([]);
});

test("committed dirty stream text survives restart before the next flush", () => {
  const item = message("durable", false);
  log.append([
    { type: "item.created", item },
    { type: "item.delta", itemId: item.id, agentId: item.agentId, field: "text", append: "window" },
  ]);
  expect(log.query("durablewindow").hits).toEqual([]);
  const writes = log.index.status(log.headSeq()).indexWrites;
  log.close();
  log = new Log(join(directory, "events.sqlite"));
  expect(log.index.status(log.headSeq()).pending).toBe(1);
  log.index.flush();
  expect(log.query("durablewindow").hits[0]?.itemId).toBe(item.id);
  expect(log.index.status(log.headSeq()).indexWrites).toBe(writes + 1);
});

test("live appends during backfill stay queued until their predecessors are committed", async () => {
  const past = message("pastneedle");
  log.history([{ type: "item.created", item: past }]);
  const live = message("liveneedle");
  log.append([{ type: "item.created", item: live }]);
  expect(log.index.status(log.headSeq()).indexedSeq).toBe(1);
  expect(log.query("liveneedle").hits).toEqual([]);
  await log.index.backfill(log, { signal: new AbortController().signal });
  expect(log.query("pastneedle").hits[0]?.itemId).toBe(past.id);
  expect(log.query("liveneedle").hits[0]?.itemId).toBe(live.id);
});

test("current thread metadata wins over older backfill so active threads never appear done", async () => {
  const item = message("statusneedle");
  log.append([{ type: "item.created", item }]);
  log.history([{ type: "thread.updated", status: { state: "done" }, title: "Old title" }]);
  log.history(
    Array.from({ length: 300 }, () => ({
      type: "item.created" as const,
      item: message("statusneedle"),
    })),
  );
  log.index.observeThread(
    Thread.parse({ ...thread, title: "Current title", status: { state: "working", agents: 1 } }),
    log.headSeq() + 1,
  );
  log.index.backfillBatch(log);
  const results = log.query("statusneedle", { filters: { status: "working" } });
  expect(results.hits[0]?.status).toBe("working");
  expect(results.hits[0]?.statusSeq).toBe(log.headSeq() + 1);
  expect(results.hits[0]?.threadTitle).toBe("Current title");
  expect(log.query("Curr", { scope: "threads" }).hits[0]?.threadId).toBe(thread.id);
  expect(log.query("Old", { scope: "threads" }).hits).toEqual([]);
  expect(log.query("statusneedle", { filters: { status: "done" } }).hits).toEqual([]);
});

test("rebuild repairs lost FTS postings from history and invalidates old cursors", async () => {
  const items = Array.from({ length: 3 }, () => message("rebuildword"));
  log.append(items.map((item) => ({ type: "item.created", item })));
  const before = log.query("rebuildword", { limit: 1 });
  if (!before.cursor) throw new Error("Expected cursor");
  log.db.exec("INSERT INTO search_prose(search_prose) VALUES ('delete-all')");
  expect(log.query("rebuildword").hits).toEqual([]);
  await log.index.rebuild(log, { signal: new AbortController().signal });
  expect(log.query("rebuildword").hits.map((hit) => hit.itemId)).toEqual(
    items.map((item) => item.id),
  );
  expect(() => log.query("rebuildword", { cursor: before.cursor ?? undefined })).toThrow(
    "search_cursor_stale",
  );
});

test("a continuously dirty stream cannot starve an older waiting document", () => {
  const first = message("firststream", false);
  const second = message("secondstream", false);
  log.append([
    { type: "item.created", item: first },
    { type: "item.created", item: second },
  ]);
  log.index.flush(1);
  expect(log.query("firststream").hits[0]?.itemId).toBe(first.id);
  log.append([
    {
      type: "item.delta",
      itemId: first.id,
      agentId: first.agentId,
      field: "text",
      append: " more",
    },
  ]);
  log.index.flush(1);
  expect(log.query("secondstream").hits[0]?.itemId).toBe(second.id);
});
