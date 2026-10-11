import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { EmbeddedBackend } from "@ace/browser";
import { BrowserOpen } from "@ace/protocol";
import { BrowserBackend, type ViewHost } from "./backend.ts";
import { FakePage } from "./test-support.ts";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "ace-open-cancel-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const pages = new Map<string, FakePage>();
  const timers = new Map<() => void, number>();
  const creation = Promise.withResolvers<void>();
  let started = false;
  let purged = false;
  const host: ViewHost = {
    async open({ options }) {
      if (pages.has(options.threadId)) throw new Error("Thread already open");
      const page = new FakePage();
      pages.set(options.threadId, page);
      const close = page.close.bind(page);
      page.close = async () => {
        await close();
        pages.delete(options.threadId);
      };
      if (options.threadId === "thread" && !started) {
        started = true;
        await creation.promise;
      }
      return page;
    },
    async purge() {
      if (pages.has("thread")) throw new Error("Purge before view cleanup");
      purged = true;
    },
  };
  const desktop = new BrowserBackend(host, { log() {} });
  const relay = new EmbeddedBackend(
    "backend",
    {
      send(message) {
        desktop.handle(message);
        return true;
      },
      close() {
        desktop.detach();
      },
    },
    () => {},
    {
      now: () => 0,
      set(delay, work) {
        timers.set(work, delay);
        return () => {
          timers.delete(work);
        };
      },
    },
  );
  desktop.attach({
    backendId: "backend",
    connectionId: "desktop",
    send(text) {
      relay.handle(JSON.parse(text));
      return true;
    },
  });
  cleanups.push(() => {
    creation.resolve();
    relay.disconnect("test finished");
  });
  const open = (threadId: string, signal = new AbortController().signal) =>
    relay.open({
      options: BrowserOpen.parse({ threadId, workspaceId: "workspace" }),
      profileDir: home,
      signal,
      allowed: async () => true,
      navigation() {},
      log() {},
      lost() {},
    });
  return { open, desktop, relay, pages, timers, release: creation.resolve, purged: () => purged };
}

test.each(["abort", "deadline"])(
  "a native open canceled by %s closes its late page and permits reopening",
  async (cause) => {
    const t = await setup();
    const sibling = await t.open("sibling");
    const abort = new AbortController();
    const pending = t.open("thread", abort.signal);
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(t.pages.has("thread")).toBe(true));
    const page = t.pages.get("thread");
    if (cause === "abort") abort.abort();
    else for (const [work, delay] of t.timers) if (delay === 60_000) work();
    await rejected;
    t.release();
    await vi.waitFor(() => expect(page?.closed).toBe(true));
    expect(t.desktop.controller("thread")).toBeUndefined();
    const reopened = await t.open("thread");
    await reopened.press("Enter");
    await sibling.press("Escape");
    expect(t.pages.get("thread")?.calls).toContainEqual({
      method: "press",
      params: { key: "Enter" },
    });
    expect(t.pages.get("sibling")?.calls).toContainEqual({
      method: "press",
      params: { key: "Escape" },
    });
    await reopened.close();
    await sibling.close();
  },
);

test("purging a thread waits for pending native creation to close before clearing its partition", async () => {
  const t = await setup();
  const pending = t.open("thread");
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(t.pages.has("thread")).toBe(true));
  const page = t.pages.get("thread");
  const purge = t.relay.purge("thread", "workspace");
  const outcome = purge.then(
    () => "purged",
    () => "failed",
  );
  await Promise.resolve();
  expect(t.purged()).toBe(false);
  t.release();
  expect(await outcome).toBe("purged");
  await rejected;
  expect(page?.closed).toBe(true);
  expect(t.desktop.controller("thread")).toBeUndefined();
});
