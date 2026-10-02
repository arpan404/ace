import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Event, Thread } from "@ace/protocol";
import { SearchIndex } from "./index.ts";
import { Log, message, shell, thread } from "./test-support.ts";

let directory: string;
let log: Log;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ace-search-review-"));
  log = new Log(join(directory, "events.sqlite"));
});
afterEach(() => {
  log.close();
  rmSync(directory, { recursive: true, force: true });
});

test.each([false, true])(
  "partial backfill publishes only the authoritative title with an early historical rename: %s",
  async (earlyRename) => {
    log.history([{ type: "thread.created", thread: { ...thread, title: "Original title" } }]);
    if (earlyRename) log.history([{ type: "thread.updated", title: "Intermediate title" }]);
    for (let i = 0; i < 300; i++)
      log.history([{ type: "item.created", item: message("historyword") }]);
    log.history([{ type: "thread.updated", title: "Current title" }]);
    const source = {
      headSeq: () => log.headSeq(),
      readEvents: (options: { afterSeq: number; limit: number }) => log.readEvents(options),
      getThread: () => Thread.parse({ ...thread, title: "Current title" }),
    };
    log.index.backfillBatch(source);
    expect(log.index.status(log.headSeq()).ready).toBe(false);
    for (const text of ["Orig", "Inter"])
      expect(log.query(text, { scope: "threads" }).hits).toEqual([]);
    expect(log.query("Curr", { scope: "threads" }).hits).toMatchObject([
      { threadId: thread.id, threadTitle: "Current title", title: { text: "Current title" } },
    ]);
    log.close();
    log = new Log(join(directory, "events.sqlite"));
    expect(log.query("Curr", { scope: "threads" }).hits[0]?.threadId).toBe(thread.id);
    await log.index.backfill(source, { signal: new AbortController().signal });
    for (const text of ["Orig", "Inter"])
      expect(log.query(text, { scope: "threads" }).hits).toEqual([]);
    expect(log.query("Curr", { scope: "threads" }).hits[0]?.threadId).toBe(thread.id);
  },
);

test("mixed pending and indexed retention removes late items without publishing pending text", () => {
  log.append([{ type: "thread.created", thread }]);
  const pending = Array.from({ length: 300 }, () => message("pendingword", false));
  const indexed = Array.from({ length: 300 }, (_, i) =>
    message(i === 299 ? "indexedword lateindexedneedle" : "indexedword"),
  );
  for (const items of [pending, indexed])
    for (let i = 0; i < items.length; i += 100)
      log.append(items.slice(i, i + 100).map((item) => ({ type: "item.created", item })));
  const latePending = pending.at(-1);
  const lateIndexed = indexed.at(-1);
  if (!latePending || !lateIndexed) throw new Error("Missing late items");
  const writes = log.index.status(log.headSeq()).indexWrites;
  log.append([
    { type: "item.deleted", itemId: latePending.id },
    { type: "item.deleted", itemId: lateIndexed.id },
  ]);
  expect(log.index.status(log.headSeq()).pending).toBe(299);
  expect(log.index.status(log.headSeq()).indexWrites).toBe(writes);
  expect(log.query("pendingword").hits).toEqual([]);
  expect(log.query("lateindexedneedle").hits).toEqual([]);
  expect(log.query("indexedword", { filters: { agentId: lateIndexed.agentId } }).hits.length).toBe(
    30,
  );
  const other = Thread.parse({ ...thread, id: "survivor", title: "Survivor title" });
  log.append([{ type: "thread.created", thread: other }], other.id);
  log.append([{ type: "item.created", item: lateIndexed }], other.id);
  log.index.deleteThread(thread.id);
  expect(log.index.status(log.headSeq()).pending).toBe(0);
  expect(log.query("indexedword").hits.map((hit) => hit.threadId)).toEqual([other.id]);
  expect(log.query("Compiler", { scope: "threads" }).hits).toEqual([]);
  log.index.flush();
  expect(log.query("pendingword").hits).toEqual([]);
});

test("a failed standalone append rolls back staged text before a later flush", () => {
  log.append([{ type: "thread.created", thread }]);
  const index = new SearchIndex(log.db, {
    readOutput: () => {
      throw new Error("output unavailable");
    },
  });
  const before = index.status(log.headSeq());
  const events = [message("rollbackstaging"), shell("outputword")].map((item, i) =>
    Event.parse({
      id: `failure${i}`,
      seq: log.headSeq() + i + 1,
      threadId: thread.id,
      at: 30,
      payload: { type: "item.created", item },
    }),
  );
  expect(() => index.append(events)).toThrow("output unavailable");
  expect(index.status(log.headSeq())).toEqual(before);
  index.flush();
  expect(index.query({ text: "rollbackstaging" }).hits).toEqual([]);
  expect(index.status(log.headSeq())).toEqual(before);
});

test("thread titles and snippets stop before a surrogate pair that crosses their response caps", () => {
  const short = Thread.parse({ ...thread, title: "x".repeat(1023) + "😀 remainder" });
  const long = Thread.parse({
    ...thread,
    id: "longtitle",
    title: "x".repeat(4095) + "😀 remainder",
  });
  log.append([{ type: "thread.created", thread: short }]);
  log.append([{ type: "thread.created", thread: long }], long.id);
  const titles = log.query("", { scope: "threads" }).hits;
  expect(titles.find((hit) => hit.threadId === short.id)?.threadTitle).toBe("x".repeat(1023));
  expect(titles.find((hit) => hit.threadId === long.id)?.title.text).toBe("x".repeat(4095));
  const item = message("needle " + "x".repeat(4088) + "😀 remainder");
  log.append([{ type: "item.created", item }]);
  const hit = log.query("needle").hits[0];
  expect(hit?.snippet.text).toBe("needle " + "x".repeat(4088));
  expect(hit?.snippet.highlights).toEqual([{ start: 0, end: 6 }]);
  for (const value of [
    ...titles.flatMap((title) => [title.threadTitle, title.title.text]),
    hit?.snippet.text,
  ])
    expect(value?.isWellFormed()).toBe(true);
});
