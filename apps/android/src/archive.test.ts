import { Command, ThreadId, ThreadListEntry, type ThreadStatus } from "@ace/protocol";
import { ClientError } from "@ace/client";
import type { Intent } from "@ace/client";
import { beforeEach, expect, test } from "vitest";
import {
  ArchivePaging,
  archiveFooterKind,
  archiveHasMore,
  archiveIds,
  archiveListLimit,
  canComposeLive,
  canPageArchive,
  closedArchiveList,
  isArchiveWindowWanted,
  orderedArchiveIds,
  readArchiveList,
  requestHomeWindow,
  resetArchiveWindowCoordinationForTests,
  type ArchiveWindowPort,
} from "./archive.ts";
import {
  availableInboxActions,
  canActInbox,
  inboxActionPayload,
  runInboxAction,
  watchInboxReceipt,
} from "./inbox-actions.ts";

const now = 1_700_000_000_000;

// Window coordination is module-shared (one SDK sidebar per phone), so each test
// starts from no owner; otherwise one test's open/close would gate another's.
beforeEach(() => {
  resetArchiveWindowCoordinationForTests();
});

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
    syncing: false,
    errorCode: undefined,
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

test("a read list carries the store sync and error so selections wake on them", () => {
  const rows = [entry("a", { state: "done" }, { archivedAt: now })];
  const store = {
    ...stubStore(rows, true),
    syncing: true,
    error: new ClientError("offline"),
  };
  expect(readArchiveList(store, false, false)).toMatchObject({
    syncing: true,
    errorCode: "offline",
  });
  expect(readArchiveList(stubStore(rows, true), false, false)).toMatchObject({
    syncing: false,
    errorCode: undefined,
  });
});

test("a live thread composes only with an explicit grant; archived never does", () => {
  expect(canComposeLive(true, false)).toBe(true);
  expect(canComposeLive(undefined, false)).toBe(false);
  expect(canComposeLive(false, false)).toBe(false);
  expect(canComposeLive(true, true)).toBe(false);
  expect(canComposeLive(undefined, true)).toBe(false);
});

test("a failed window offers retry instead of masquerading as loading", () => {
  // Rejected archive window: unloaded on a ready connection, but failed.
  expect(
    archiveFooterKind(
      { loading: false, failed: true, loaded: false, ids: [], more: false },
      "ready",
    ),
  ).toBe("failed");
  // A load actually in flight still reads as loading, even when failed is set.
  expect(
    archiveFooterKind(
      { loading: true, failed: false, loaded: false, ids: [], more: false },
      "ready",
    ),
  ).toBe("loading");
  // Initial window still on its way, nothing failed yet.
  expect(
    archiveFooterKind(
      { loading: false, failed: false, loaded: false, ids: [], more: false },
      "ready",
    ),
  ).toBe("loading");
  // Offline with no snapshot: the offline note, not the spinner.
  expect(
    archiveFooterKind(
      { loading: false, failed: false, loaded: false, ids: [], more: false },
      "connecting",
    ),
  ).toBe("offline");
  // Loaded states flow through.
  expect(
    archiveFooterKind(
      { loading: false, failed: false, loaded: true, ids: [], more: false },
      "ready",
    ),
  ).toBe("empty");
  expect(
    archiveFooterKind(
      { loading: false, failed: false, loaded: true, ids: ["a"], more: true },
      "ready",
    ),
  ).toBe("more");
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
  expect(await paging.openArchive(port)).toBe(true);
  expect(port.calls).toEqual(["window"]);
  expect(paging.open).toBe(true);
  expect(paging.failed).toBe(false);

  const failing = new ArchivePaging();
  const down = stubPort({ window: 1 });
  expect(await failing.openArchive(down)).toBe(true);
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
  await paging.closeArchive(port);
  port.releaseHeldMore();
  port.setHolding(false);
  // Stale: the visit moved on at close, so the late landing claims nothing.
  expect(await pending).toBe(false);
  expect(paging.loading).toBe(false);
  expect(paging.failed).toBe(false);
  expect(port.calls.at(-1)).toBe("window");
});

test("a stale open response after close/reopen never touches the new session", async () => {
  const calls: string[] = [];
  let releaseFirst: (() => void) | undefined;
  let firstFails = false;
  const port: ArchiveWindowPort = {
    async threadsWindow(input: { archived?: boolean }) {
      calls.push(input.archived ? "archive" : "home");
      if (
        input.archived &&
        releaseFirst === undefined &&
        calls.filter((call) => call === "archive").length === 1
      ) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        if (firstFails) throw new Error("offline");
      }
    },
    async threadsMore() {
      calls.push("more");
    },
  };
  const paging = new ArchivePaging();
  const first = paging.openArchive(port);
  // Reopen while the first window is still in flight: the second visit wins.
  const second = paging.openArchive(port);
  expect(await second).toBe(true);
  expect(paging.failed).toBe(false);
  // The stale first window rejects after the reopen: it must not fail the new session.
  firstFails = true;
  releaseFirst?.();
  expect(await first).toBe(false);
  expect(paging.open).toBe(true);
  expect(paging.failed).toBe(false);
});

test("closing returns the store to the home window exactly once per visit", async () => {
  const paging = new ArchivePaging();
  const port = stubPort();
  // Never opened: nothing to return, so no window call leaks.
  expect(await paging.closeArchive(port)).toBe(true);
  expect(port.calls).toEqual([]);
});

test("a failed home-window restore reports instead of silently stranding the inbox", async () => {
  const paging = new ArchivePaging();
  const port = stubPort();
  await paging.openArchive(port);
  port.setHolding(false);
  const down: ArchiveWindowPort = {
    async threadsWindow() {
      throw new Error("offline");
    },
    async threadsMore() {},
  };
  // Point the paging at the failing home restore via a fresh open, then close.
  const restorePaging = new ArchivePaging();
  await restorePaging.openArchive(port);
  expect(await restorePaging.closeArchive(down)).toBe(false);
  expect(restorePaging.restoreFailed).toBe(true);
  expect(restorePaging.open).toBe(false);
  // The next open clears the restore flag for the new session.
  expect(await restorePaging.openArchive(port)).toBe(true);
  expect(restorePaging.restoreFailed).toBe(false);
});

test("a stale close after reopen never clears the new session", async () => {
  let releaseHome: (() => void) | undefined;
  const calls: string[] = [];
  const port: ArchiveWindowPort = {
    async threadsWindow(input: { archived?: boolean }) {
      calls.push(input.archived ? "archive" : "home");
      if (!input.archived && releaseHome === undefined) {
        await new Promise<void>((resolve) => {
          releaseHome = resolve;
        });
      }
    },
    async threadsMore() {},
  };
  const paging = new ArchivePaging();
  await paging.openArchive(port);
  const closing = paging.closeArchive(port);
  // Reopen while the home restore is still in flight: the new visit wins.
  expect(await paging.openArchive(port)).toBe(true);
  releaseHome?.();
  expect(await closing).toBe(false);
  expect(paging.open).toBe(true);
  expect(paging.restoreFailed).toBe(false);
});

test("a flaky home restore retries instead of stranding the inbox", async () => {
  const opened = stubPort();
  const paging = new ArchivePaging();
  await paging.openArchive(opened);
  const flaky = stubPort({ window: 2 });
  // Two offline blips, then the home window lands: no strand, no flag.
  expect(await paging.closeArchiveWithRetry(flaky, 3)).toBe(true);
  expect(paging.restoreFailed).toBe(false);
  expect(paging.open).toBe(false);
  expect(flaky.calls).toEqual(["window", "window", "window"]);

  const down = stubPort({ window: 5 });
  const stranded = new ArchivePaging();
  await stranded.openArchive(opened);
  expect(await stranded.closeArchiveWithRetry(down, 2)).toBe(false);
  expect(stranded.restoreFailed).toBe(true);
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

test("an admitted unarchive surfaces a later daemon refusal through its receipt", async () => {
  const snapshots = new Map<string, Intent | undefined>();
  const listeners = new Map<string, Set<() => void>>();
  const port = {
    async enqueue() {
      return "cmd-unarchive-0";
    },
    intent(id: string) {
      return {
        getSnapshot: () => snapshots.get(id),
        subscribe: (listener: () => void) => {
          let group = listeners.get(id);
          if (!group) {
            group = new Set();
            listeners.set(id, group);
          }
          group.add(listener);
          return () => {
            group?.delete(listener);
          };
        },
      };
    },
  };
  const admitted = await runInboxAction(port, "unarchive", "thread-a", now, undefined, true);
  expect(admitted).toEqual({ admitted: true, commandId: "cmd-unarchive-0" });
  const problems: string[] = [];
  const stop = watchInboxReceipt(port, admitted.commandId ?? "", (error) => {
    problems.push(
      error !== undefined && error !== ""
        ? `Your machine refused it (${error}).`
        : "Your machine refused it.",
    );
  });
  // The daemon refuses after admit: the async outcome lands, it is not silent.
  const payload = inboxActionPayload("unarchive", "thread-a", now);
  if (!payload) throw new Error("expected a payload");
  snapshots.set("cmd-unarchive-0", {
    command: Command.parse({
      id: "cmd-unarchive-0",
      deviceId: "android-spike-device",
      payload,
    }),
    state: "failed",
    error: "forbidden",
  });
  for (const listener of listeners.get("cmd-unarchive-0") ?? []) listener();
  expect(problems).toEqual(["Your machine refused it (forbidden)."]);
  stop();
});

test("an acknowledged unarchive settles its receipt instead of leaking it", async () => {
  const snapshots = new Map<string, Intent | undefined>();
  const listeners = new Map<string, Set<() => void>>();
  const port = {
    async enqueue() {
      return "cmd-unarchive-1";
    },
    intent(id: string) {
      return {
        getSnapshot: () => snapshots.get(id),
        subscribe: (listener: () => void) => {
          let group = listeners.get(id);
          if (!group) {
            group = new Set();
            listeners.set(id, group);
          }
          group.add(listener);
          return () => {
            group?.delete(listener);
          };
        },
      };
    },
  };
  const admitted = await runInboxAction(port, "unarchive", "thread-a", now, undefined, true);
  expect(admitted.commandId).toBe("cmd-unarchive-1");
  const live = new Map<string, () => void>();
  const refused: string[] = [];
  live.set(
    admitted.commandId ?? "",
    watchInboxReceipt(
      port,
      admitted.commandId ?? "",
      (error) => {
        refused.push(error ?? "");
      },
      () => {
        live.delete(admitted.commandId ?? "");
      },
    ),
  );
  expect(live.size).toBe(1);
  // The daemon confirms: the entry drops itself, nothing refused, and a second
  // notification cannot report twice.
  const payload = inboxActionPayload("unarchive", "thread-a", now);
  if (!payload) throw new Error("expected a payload");
  snapshots.set("cmd-unarchive-1", {
    command: Command.parse({
      id: "cmd-unarchive-1",
      deviceId: "android-spike-device",
      payload,
    }),
    state: "acked",
  });
  for (const listener of listeners.get("cmd-unarchive-1") ?? []) listener();
  expect(refused).toEqual([]);
  expect(live.size).toBe(0);
  for (const stop of live.values()) stop();
});

test("a reopen owns the window when the old home restore lands late", async () => {
  // The reported cross-mount race: the old screen's cleanup repoints home while
  // its call is still in flight, and a reopen claims the archive window before
  // that home call lands. The latest route's intent must stay the last window
  // call issued, and the late home settlement must change nothing.
  const calls: string[] = [];
  let releaseHome!: () => void;
  const homeGate = new Promise<void>((resolve) => {
    releaseHome = resolve;
  });
  const port: ArchiveWindowPort = {
    async threadsWindow(input: { archived?: boolean }) {
      calls.push(input.archived ? "archive" : "home");
      if (!input.archived) await homeGate;
    },
    async threadsMore() {
      calls.push("more");
    },
  };
  const first = new ArchivePaging();
  await first.openArchive(port);
  expect(isArchiveWindowWanted()).toBe(true);
  const closing = first.closeArchive(port);
  const second = new ArchivePaging();
  const opening = second.openArchive(port);
  expect(await opening).toBe(true);
  // The delayed home restore lands after the reopen: superseded, not failed.
  releaseHome();
  expect(await closing).toBe(false);
  expect(first.superseded).toBe(true);
  expect(first.restoreFailed).toBe(false);
  expect(second.open).toBe(true);
  expect(second.failed).toBe(false);
  expect(second.superseded).toBe(false);
  expect(isArchiveWindowWanted()).toBe(true);
  expect(calls).toEqual(["archive", "home", "archive"]);
  // A superseded session owns nothing further: closing it again issues no call.
  expect(await first.closeArchive(port)).toBe(true);
  expect(calls).toEqual(["archive", "home", "archive"]);
});

test("a home-restore retry stops once a reopen owns the window", async () => {
  // The retry loop must not issue a home call past a reopen's archive window:
  // the attempt in flight settles stale and no further attempt starts.
  const calls: string[] = [];
  let homeAttempts = 0;
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const port: ArchiveWindowPort = {
    async threadsWindow(input: { archived?: boolean }) {
      calls.push(input.archived ? "archive" : "home");
      if (!input.archived) {
        homeAttempts += 1;
        if (homeAttempts === 1) throw new Error("offline");
        if (homeAttempts === 2) await secondGate;
      }
    },
    async threadsMore() {},
  };
  const first = new ArchivePaging();
  await first.openArchive(port);
  const closing = first.closeArchiveWithRetry(port, 3);
  // Let the first attempt fail and the second park before the reopen claims it.
  for (let spin = 0; spin < 100; spin++) {
    if (homeAttempts >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(homeAttempts).toBe(2);
  const second = new ArchivePaging();
  expect(await second.openArchive(port)).toBe(true);
  releaseSecond();
  expect(await closing).toBe(false);
  expect(first.superseded).toBe(true);
  expect(first.restoreFailed).toBe(false);
  expect(second.open).toBe(true);
  // Two home attempts only: the retry never fired a third past the reopen.
  expect(homeAttempts).toBe(2);
  expect(calls).toEqual(["archive", "home", "home", "archive"]);
});

test("a mount heal never repoints home while the archive owns the window", async () => {
  const port = stubPort();
  const first = new ArchivePaging();
  await first.openArchive(port);
  expect(isArchiveWindowWanted()).toBe(true);
  requestHomeWindow(port);
  expect(port.calls).toEqual(["window"]);
  await first.closeArchive(port);
  expect(isArchiveWindowWanted()).toBe(false);
  // The archive is gone: the heal repoints home, idempotent with the close.
  requestHomeWindow(port);
  expect(port.calls).toEqual(["window", "window", "window"]);
});

test("a view-only phone offers no archive actions and admits no unarchive", async () => {
  const row = entry("a", { state: "done" }, { archivedAt: now });
  const none = { settle: false, unsettle: false, snooze: false, wake: false, archive: false };
  expect(availableInboxActions(row, now, undefined)).toEqual(none);
  expect(availableInboxActions(row, now, false)).toEqual(none);
  // Archived threads never compose, even with a genuine grant.
  expect(canComposeLive(true, true)).toBe(false);
  expect(canComposeLive(undefined, true)).toBe(false);
  const enqueued: unknown[] = [];
  const port = {
    async enqueue(payload: unknown) {
      enqueued.push(payload);
      return "cmd-view-only";
    },
    intent() {
      return { getSnapshot: () => undefined, subscribe: () => () => {} };
    },
  };
  const refused = await runInboxAction(port, "unarchive", "thread-a", now, undefined, undefined);
  expect(refused).toEqual({
    admitted: false,
    error: "This phone can only view this machine.",
  });
  expect(enqueued).toEqual([]);
});
