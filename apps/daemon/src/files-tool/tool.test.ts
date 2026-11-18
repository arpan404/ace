import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { FilesWatch } from "@ace/files-native";
import { FilesTool, type FilesToolClient } from "./tool.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "ace-files-tool-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function watchHandle(dispose: () => void): FilesWatch {
  return {
    subscription: 1,
    dispose: async () => dispose(),
    [Symbol.asyncDispose]: async () => dispose(),
  };
}

class FakeClient implements FilesToolClient {
  watchStarted = false;
  processesDisposed = 0;
  watchesDisposed = 0;
  listLimits: number[] = [];
  indexLimits: number[] = [];
  answerListings = false;
  readonly #watch = Promise.withResolvers<void>();
  readonly #listings = Promise.withResolvers<void>();

  start(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {
    this.processesDisposed++;
  }

  openRoot(): Promise<number> {
    return Promise.resolve(1);
  }

  closeRoot(): Promise<void> {
    return Promise.resolve();
  }

  list(
    _root: number,
    _dir: string,
    options: { limit?: number | undefined; signal?: AbortSignal | undefined },
  ) {
    this.listLimits.push(options.limit ?? 0);
    this.#listings.resolve();
    if (this.answerListings)
      return Promise.resolve({ type: "page" as const, entries: [], total: 0 });
    return new Promise<never>((_resolve, reject) => {
      options.signal?.addEventListener("abort", () =>
        reject(new DOMException("cancelled", "AbortError")),
      );
    });
  }

  indexQuery(_root: number, _query: string, limit: number) {
    this.indexLimits.push(limit);
    return Promise.resolve({
      type: "index" as const,
      hits: [],
      total: 0,
      truncated: false,
      ready: true,
    });
  }

  watch(): Promise<FilesWatch> {
    this.watchStarted = true;
    return this.#watch.promise.then(() => watchHandle(() => this.watchesDisposed++));
  }

  /** Resolve the watch request a close interrupted. */
  landWatch(): void {
    this.#watch.resolve();
  }

  get listingStarted(): Promise<void> {
    return this.#listings.promise;
  }
}

it("fails folder features retryably when this machine has no ace-files", async () => {
  const tool = new FilesTool({ binary: undefined });
  expect(tool.available).toBe(false);
  await expect(tool.client()).rejects.toMatchObject({
    code: "FILES_RESTARTING",
    retryable: true,
  });
  await expect(tool.listFolder("/w", "")).rejects.toMatchObject({
    code: "FILES_RESTARTING",
    retryable: true,
  });
  expect(await tool.quickOpen("/w", "main", 20)).toBeUndefined();
  await tool.close();
});

it("names a folder ace-files cannot open as not found", async () => {
  const tool = new FilesTool({ binary: undefined });
  await expect(tool.canonical("/definitely/not/here/at/all")).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await tool.close();
});

it("does nothing to watch on a machine with no ace-files", async () => {
  const tool = new FilesTool({ binary: undefined });
  await expect(tool.watch("/definitely/not/here/at/all", () => {})).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(await tool.sweep()).toEqual([]);
  await tool.close();
});

it("disposes a subscription that lands after the tool closed", async () => {
  const client = new FakeClient();
  const tool = new FilesTool({ binary: "/fake/ace-files", open: () => client });
  const opening = tool.watch(checkout(), () => {});
  await until(() => client.watchStarted);
  await tool.close();
  client.landWatch();
  await expect(opening).resolves.toBeTypeOf("function");
  expect(client.watchesDisposed).toBe(1);
});

it("asks for no more than ace-files' caps", async () => {
  const client = new FakeClient();
  client.answerListings = true;
  const tool = new FilesTool({ binary: "/fake/ace-files", open: () => client });
  await tool.listFolder(checkout(), "", { limit: 9_000 });
  await tool.quickOpen(checkout(), "main", 5_000);
  expect(client.listLimits).toEqual([5_000]);
  expect(client.indexLimits).toEqual([1_000]);
  await tool.close();
});

it("passes a listing's abort switch through to ace-files", async () => {
  const client = new FakeClient();
  const tool = new FilesTool({ binary: "/fake/ace-files", open: () => client });
  const controller = new AbortController();
  const listing = tool.listFolder(checkout(), "", { signal: controller.signal });
  await client.listingStarted;
  controller.abort();
  await expect(listing).rejects.toMatchObject({ name: "AbortError" });
  await tool.close();
});

async function until(condition: () => boolean, ms = 1_000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
