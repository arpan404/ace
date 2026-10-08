import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { BrowserForget, type BrowserForgetPort } from "./browser-forget.ts";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";

async function setup(browser: BrowserForgetPort) {
  const home = await mkdtemp(join(tmpdir(), "ace-browser-forget-"));
  const store = new Store(join(home, "events.sqlite"));
  const workspace = store.createWorkspace(home, "Test");
  const errors: unknown[] = [];
  let forget: BrowserForget | undefined;
  onTestFinished(async () => {
    await forget?.flush();
    await forget?.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    start() {
      forget = new BrowserForget(store, browser, (error) => errors.push(error));
      return forget;
    },
    removeThread() {
      const thread = createDevThread(store, workspace);
      store.appendEvents(thread.id, [{ type: "thread.client.updated", changes: { deletedAt: 5 } }]);
      return thread.id;
    },
    errors,
    workspace,
  };
}

it("replays every pending deletion without exceeding the desktop's request capacity", async () => {
  let desktop = false;
  let active = 0;
  const purged: string[] = [];
  const f = await setup({
    async forgetThread(threadId) {
      active++;
      try {
        if (active > 1) throw new Error("Desktop request capacity exceeded");
        await Promise.resolve();
        if (desktop) purged.push(threadId);
        return { desktop };
      } finally {
        active--;
      }
    },
  });
  const forget = f.start();
  const deleted = Array.from({ length: 300 }, () => f.removeThread());
  await forget.flush();
  expect(purged).toEqual([]);
  desktop = true;
  await forget.flush();
  expect(new Set(purged)).toEqual(new Set(deleted));
  expect(purged).toHaveLength(deleted.length);
  expect(f.errors).toEqual([]);
});

it("recovers a deletion committed before cleanup started and keeps failed purges for retry", async () => {
  const purged: { threadId: string; workspaceId: string }[] = [];
  let available = false;
  const f = await setup({
    async forgetThread(threadId, workspaceId) {
      if (!available) throw new Error("Desktop cannot clear the partition");
      purged.push({ threadId, workspaceId });
      return { desktop: true };
    },
  });
  const deleted = f.removeThread();
  const forget = f.start();
  await forget.flush();
  expect(purged).toEqual([]);
  expect(f.errors).toHaveLength(1);
  available = true;
  await forget.flush();
  expect(purged).toEqual([{ threadId: deleted, workspaceId: f.workspace }]);
  await forget.flush();
  expect(purged).toHaveLength(1);
});

it("retries failed cleanup when a replacement desktop registers during a replay", async () => {
  const started = Promise.withResolvers<void>();
  const previous = Promise.withResolvers<{ desktop: boolean }>();
  const purged: string[] = [];
  let first = true;
  const f = await setup({
    async forgetThread(threadId) {
      if (first) {
        first = false;
        started.resolve();
        return previous.promise;
      }
      purged.push(threadId);
      return { desktop: true };
    },
  });
  const deleted = f.removeThread();
  const forget = f.start();
  const original = forget.flush();
  await started.promise;
  const replacement = forget.flush();
  previous.reject(new Error("Previous desktop disconnected"));
  await Promise.all([original, replacement]);
  expect(purged).toEqual([deleted]);
  expect(f.errors).toHaveLength(1);
});
