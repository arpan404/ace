import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SearchQueries } from "./index.ts";
import { Log, message, thread } from "./test-support.ts";

test("worker reads committed WAL snapshots and validates changed cursor generations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ace-search-worker-"));
  const path = join(directory, "events.sqlite");
  const log = new Log(path);
  const queries = new SearchQueries(path);
  try {
    log.append([
      { type: "thread.created", thread },
      ...Array.from({ length: 3 }, () => ({
        type: "item.created" as const,
        item: message("workerword"),
      })),
    ]);
    const first = await queries.query({ text: "workerword", limit: 1 });
    expect(first.hits).toHaveLength(1);
    if (!first.cursor) throw new Error("Expected cursor");
    const latest = message("workerword freshword");
    log.append([{ type: "item.created", item: latest }]);
    await expect(queries.query({ text: "workerword", cursor: first.cursor })).rejects.toThrow(
      "search_cursor_stale",
    );
    expect((await queries.query({ text: "freshword" })).hits[0]?.itemId).toBe(latest.id);
    expect((await queries.query({ text: "work", scope: "threads" })).hits).toEqual([]);
  } finally {
    await queries.close();
    log.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("query admission is bounded and closing rejects outstanding work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ace-search-worker-"));
  const path = join(directory, "events.sqlite");
  const log = new Log(path);
  log.append([{ type: "thread.created", thread }]);
  const queries = new SearchQueries(path);
  try {
    const accepted = Array.from({ length: 16 }, () =>
      queries.query({ text: "Compiler", scope: "threads" }),
    );
    // Attach rejection handlers before closing the reader.
    const completed = Promise.allSettled(accepted);
    await expect(queries.query({ text: "Compiler", scope: "threads" })).rejects.toThrow(
      "search_failed",
    );
    await queries.close();
    expect((await completed).every((result) => result.status === "rejected")).toBe(true);
    await expect(queries.query({ text: "Compiler", scope: "threads" })).rejects.toThrow(
      "search_failed",
    );
  } finally {
    await queries.close();
    log.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("palette requests remain available when transcript query admission is full", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ace-search-worker-"));
  const path = join(directory, "events.sqlite");
  const log = new Log(path);
  log.append([{ type: "thread.created", thread }]);
  const queries = new SearchQueries(path);
  try {
    const transcripts = Promise.allSettled(
      Array.from({ length: 16 }, () => queries.query({ text: "Compiler" })),
    );
    await expect(queries.query({ text: "Compiler" })).rejects.toThrow("search_failed");
    const palette = await queries.query({ text: "Comp", scope: "threads" });
    expect(palette.hits.map((hit) => hit.threadId)).toEqual([thread.id]);
    expect((await transcripts).every((result) => result.status === "fulfilled")).toBe(true);
  } finally {
    await queries.close();
    log.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
