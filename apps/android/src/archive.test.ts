import { ThreadId, ThreadListEntry, type ThreadStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  ArchivePaging,
  archiveHasMore,
  archiveIds,
  archiveListLimit,
  canPageArchive,
  closedArchiveList,
  orderedArchiveIds,
  readArchiveList,
  type ArchiveWindowPort,
} from "./archive.ts";
import { canActInbox, inboxActionPayload, runInboxAction } from "./inbox-actions.ts";

const now = 1_700_000_000_000;

function entry(
  id: string,
  status: ThreadStatus,
  extra: Record<string, unknown> = {},
): ThreadListEntry {
  return ThreadListEntry.parse({
    workspaceId: "ace",
    title: `Thread ${id}`,
    provider: "codex",
    createdAt: 0,
    ...extra,
    id,
    status,
    updatedAt: now,
  });
}

function stubStore(entries: ThreadListEntry[], loaded = true, before: boolean = false) {
  const cursor = ThreadId.parse("thread-a");
  const byId = new Map(entries.map((row) => [row.id, row]));
  return {
    ids: entries.map((row) => row.id),
    thread: (id: typeof cursor) => byId.get(id),
    window: before
      ? { before: { at: 0, id: cursor }, total: 60, counts: [] }
      : { before: null, total: entries.length, counts: [] },
    loaded,
  };
}

function stubPort(failures: { window?: number; more?: number } = {}) {
  const calls: string[] = [];
  let windowFailures = failures.window ?? 0;
  let moreFailures = failures.more ?? 0;
  let holding = false;
  let releaseMore: (() => void) | undefined;
  const port: ArchiveWindowPort & {
    calls: string[];
    setHolding(value: boolean): void;
    releaseHeldMore(): void;
  } = {
    calls,
    // Park the next threadsMore until released, to prove single-flight.
    setHolding(value: boolean) {
      holding = value;
    },
    releaseHeldMore() {
      releaseMore?.();
      releaseMore = undefined;
    },
    async threadsWindow() {
      calls.push("window");
      if (windowFailures > 0) {
        windowFailures--;
        throw new Error("offline");
      }
    },
    async threadsMore() {
      calls.push("more");
      if (holding) {
        await new Promise<void>((resolve) => {
          releaseMore = resolve;
        });
      }
      if (moreFailures > 0) {
        moreFailures--;
        throw new Error("offline");
      }
    },
  };
  return port;
}

test("archived rows order most-recently-archived-first; home, deleted and draft rows stay out", () => {
  const rows = [
    entry("old", { state: "done" }, { archivedAt: now - 2000 }),
    entry("home", { state: "done" }),
    entry("new", { state: "done" }, { archivedAt: now }),
    entry("gone", { state: "done" }, { archivedAt: now - 1000, deletedAt: now }),
    entry("mid", { state: "done" }, { archivedAt: now - 1000 }),
  ];
  expect(archiveIds(stubStore(rows))).toEqual(["new", "mid", "old"]);
});

test("the list caps at a thousand rows and reports an older page past the cap", () => {
  const rows = Array.from({ length: archiveListLimit + 5 }, (_, index) =>
    entry(`archived-${index}`, { state: "done" }, { archivedAt: now - index }),
  );
  const store = stubStore(rows);
  const ids = archiveIds(store);
  expect(ids).toHaveLength(archiveListLimit);
  expect(ids[0]).toBe("archived-0");
  expect(archiveHasMore(store, orderedArchiveIds(store).length)).toBe(true);
});

test("more follows the daemon cursor only; a landed window with no cursor has none", () => {
  const rows = [entry("a", { state: "done" }, { archivedAt: now })];
  expect(archiveHasMore(stubStore(rows, true, true), 1)).toBe(true);
  expect(archiveHasMore(stubStore(rows, true, false), 1)).toBe(false);
});

test("a closed list carries no rows and a read list carries the window state", () => {
  expect(closedArchiveList()).toEqual({
    open: false,
    ids: [],
    more: false,
    loaded: false,
    loading: false,
    failed: false,
  });
  const rows = [entry("a", { state: "done" }, { archivedAt: now })];
  expect(readArchiveList(stubStore(rows, false), true, false)).toMatchObject({
    open: true,
    ids: ["a"],
    more: false,
    loaded: false,
    loading: true,
    failed: false,
  });
});

test("paging starts one page at a time and only while an older page remains", () => {
  expect(canPageArchive(true, false)).toBe(true);
  expect(canPageArchive(true, true)).toBe(false);
  expect(canPageArchive(false, false)).toBe(false);
  expect(canPageArchive(false, true)).toBe(false);
});

test("opening follows the archive window; a rejected window fails openly, not silently", async () => {
  const paging = new ArchivePaging();
  const port = stubPort();
  await paging.openArchive(port);
  expect(port.calls).toEqual(["window"]);
  expect(paging.open).toBe(true);
  expect(paging.failed).toBe(false);

  const failing = new ArchivePaging();
  const down = stubPort({ window: 1 });
  await failing.openArchive(down);
  expect(failing.open).toBe(true);
  expect(failing.failed).toBe(true);

  // A retry reopens the window; recovery is observable, not stuck failed.
  await failing.openArchive(down);
  expect(down.calls).toEqual(["window", "window"]);
  expect(failing.failed).toBe(false);
});

test("a fast scroll asks for one page at a time; the second tap waits", async () => {
  const paging = new ArchivePaging();
  const port = stubPort();
  port.setHolding(true);
  await paging.openArchive(port);
  const first = paging.loadMore(port, true);
  const second = await paging.loadMore(port, true);
  expect(second).toBe(false);
  port.releaseHeldMore();
  port.setHolding(false);
  expect(await first).toBe(true);
  expect(port.calls.filter((call) => call === "more")).toHaveLength(1);
});

test("a page with no older rows asks for nothing and sends nothing", async () => {
  const paging = new ArchivePaging();
  const port = stubPort();
  await paging.openArchive(port);
  expect(await paging.loadMore(port, false)).toBe(false);
  expect(port.calls).toEqual(["window"]);
});

test("a failed page fails openly and the next page retries cleanly", async () => {
  const paging = new ArchivePaging();
  const port = stubPort({ more: 1 });
  await paging.openArchive(port);
  expect(await paging.loadMore(port, true)).toBe(false);
  expect(paging.loading).toBe(false);
  expect(paging.failed).toBe(true);
  expect(await paging.loadMore(port, true)).toBe(true);
  expect(paging.failed).toBe(false);
});

test("a page that lands after close changes nothing and never reloads", async () => {
  const paging = new ArchivePaging();
  const port = stubPort();
  port.setHolding(true);
  await paging.openArchive(port);
  const pending = paging.loadMore(port, true);
  paging.closeArchive(port);
  port.releaseHeldMore();
  port.setHolding(false);
  // Stale: the visit moved on at close, so the late landing claims nothing.
  expect(await pending).toBe(false);
  expect(paging.loading).toBe(false);
  expect(paging.failed).toBe(false);
  expect(port.calls.at(-1)).toBe("window");
});

test("closing returns the store to the home window exactly once per visit", () => {
  const paging = new ArchivePaging();
  const port = stubPort();
  // Never opened: nothing to return, so no window call leaks.
  paging.closeArchive(port);
  expect(port.calls).toEqual([]);
});

test("unarchive names the archived thread; a view-only phone admits nothing", async () => {
  expect(canActInbox(undefined)).toBe(false);
  expect(inboxActionPayload("unarchive", "thread-a", now)).toEqual({
    type: "thread.unarchive",
    threadId: "thread-a",
  });
  const enqueued: unknown[] = [];
  const port = {
    async enqueue(payload: unknown) {
      enqueued.push(payload);
      return "cmd-0";
    },
    intent() {
      return { getSnapshot: () => undefined, subscribe: () => () => {} };
    },
  };
  const refused = await runInboxAction(port, "unarchive", "thread-a", now, undefined, false);
  expect(refused).toEqual({
    admitted: false,
    error: "This phone can only view this machine.",
  });
  expect(enqueued).toEqual([]);
  const admitted = await runInboxAction(port, "unarchive", "thread-a", now, undefined, true);
  expect(admitted.admitted).toBe(true);
  expect(enqueued).toEqual([{ type: "thread.unarchive", threadId: "thread-a" }]);
});
