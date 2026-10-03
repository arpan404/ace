import { EventEmitter } from "node:events";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { expect, test } from "vitest";
import { z } from "zod";
import { SearchQueries, type SearchWorker } from "./index.ts";

/** Only the worker I/O is controlled; admission and cleanup use the public reader. */
class ControlledWorker extends EventEmitter implements SearchWorker {
  onTerminate: (() => void) | undefined;
  private readonly stopped = Promise.withResolvers<number>();
  private id: number | undefined;
  postMessage(message: unknown): void {
    this.id = z.object({ id: z.number().int().positive() }).parse(message).id;
  }
  terminate(): Promise<number> {
    this.onTerminate?.();
    return this.stopped.promise;
  }
  finish(): void {
    this.stopped.resolve(0);
    this.emit("exit", 0);
  }
  failCleanup(): void {
    this.stopped.reject(new Error("termination failed"));
  }
  reply(): void {
    this.emit("message", {
      id: this.id,
      ok: true,
      results: { generation: 0, hits: [], cursor: null },
    });
  }
}

test("worker startup failure rejects a query through its promise and closing still completes", async () => {
  const queries = new SearchQueries("unused.sqlite", () => {
    throw new Error("worker unavailable");
  });
  await expect(queries.query({ text: "needle" })).rejects.toThrow("search_failed");
  await queries.close();
  await expect(queries.query({ text: "needle" })).rejects.toThrow("search_failed");
});

test.each(["close", "malformed"])(
  "reentrant worker shutdown shares the cleanup completion signal after %s",
  async (trigger) => {
    const worker = new ControlledWorker();
    const queries = new SearchQueries("unused.sqlite", () => worker);
    let reentrant: Promise<void> | undefined;
    worker.onTerminate = () => {
      reentrant = queries.close();
    };
    const query = Promise.allSettled([queries.query({ text: "needle" })]);
    if (trigger === "malformed") worker.emit("message", { invalid: true });
    const closing = queries.close();
    let reentrantEnded = false;
    const observer = reentrant?.then(() => {
      reentrantEnded = true;
    });
    await query;
    await yieldTurn();
    expect(reentrantEnded).toBe(false);
    worker.finish();
    await Promise.all([closing, observer]);
    expect(reentrantEnded).toBe(true);
  },
);

test("closing waits for both reader workers while immediately rejecting outstanding queries", async () => {
  const transcript = new ControlledWorker();
  const title = new ControlledWorker();
  const available = [transcript, title];
  const queries = new SearchQueries("unused.sqlite", () => {
    const worker = available.shift();
    if (!worker) throw new Error("Unexpected worker");
    return worker;
  });
  const results = Promise.allSettled([
    queries.query({ text: "needle" }),
    queries.query({ text: "needle", scope: "threads" }),
  ]);
  let closed = false;
  const closing = queries.close().then(() => {
    closed = true;
  });
  expect((await results).every((result) => result.status === "rejected")).toBe(true);
  expect(closed).toBe(false);
  transcript.finish();
  await Promise.resolve();
  expect(closed).toBe(false);
  title.finish();
  await closing;
  expect(closed).toBe(true);
  await queries.close();
  await expect(queries.query({ text: "needle" })).rejects.toThrow("search_failed");
});

test("malformed worker responses reject pending work and recovery waits for cleanup", async () => {
  const failed = new ControlledWorker();
  const replacement = new ControlledWorker();
  const available = [failed, replacement];
  const queries = new SearchQueries("unused.sqlite", () => {
    const worker = available.shift();
    if (!worker) throw new Error("Unexpected worker");
    return worker;
  });
  try {
    const first = queries.query({ text: "needle" });
    failed.emit("message", { invalid: true });
    await expect(first).rejects.toThrow("search_failed");
    await expect(queries.query({ text: "needle" })).rejects.toThrow("search_failed");
    failed.finish();
    await Promise.resolve();
    const recovered = queries.query({ text: "needle" });
    replacement.reply();
    expect(await recovered).toEqual({ generation: 0, hits: [], cursor: null });
  } finally {
    const closing = queries.close();
    replacement.finish();
    await closing;
  }
});

test("worker termination failure is reported only after every reader has finished cleanup", async () => {
  const failed = new ControlledWorker();
  const other = new ControlledWorker();
  const available = [failed, other];
  const queries = new SearchQueries("unused.sqlite", () => {
    const worker = available.shift();
    if (!worker) throw new Error("Unexpected worker");
    return worker;
  });
  const pending = Promise.allSettled([
    queries.query({ text: "needle" }),
    queries.query({ text: "needle", scope: "threads" }),
  ]);
  let ended = false;
  const closing = queries.close().catch((error: unknown) => {
    ended = true;
    throw error;
  });
  const outcome = expect(closing).rejects.toThrow("search_failed");
  failed.failCleanup();
  await pending;
  expect(ended).toBe(false);
  other.finish();
  await outcome;
  expect(ended).toBe(true);
});
