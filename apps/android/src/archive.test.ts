import { Command, DeviceId, ThreadId, ThreadListEntry, type ThreadStatus } from "@ace/protocol";
import { ClientCore, ClientError } from "@ace/client";
import type { Intent } from "@ace/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  ArchivePaging,
  archiveFooterKind,
  archiveHasMore,
  archiveIds,
  archiveListLimit,
  archiveOwnerFor,
  canComposeLive,
  canPageArchive,
  closedArchiveList,
  isArchiveWindowWanted,
  orderedArchiveIds,
  readArchiveList,
  recoverStrandedHomeWindow,
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

function stubPort(
  failures: { window?: number; more?: number } = {},
  shared?: { owner?: object | undefined } | undefined,
) {
  const calls: string[] = [];
  let windowFailures = failures.window ?? 0;
  let moreFailures = failures.more ?? 0;
  let holding = false;
  let releaseMore: (() => void) | undefined;
  // An explicit shared owner models two wrappers around the same underlying
  // sidebar: both ports resolve through `cachedThreads` to one claim series.
  const owner = shared?.owner;
  const port: ArchiveWindowPort & {
    calls: string[];
    setHolding(value: boolean): void;
    releaseHeldMore(): void;
    failWindows(count: number): void;
  } = {
    calls,
    // Fail the next `count` window calls, so one port can go offline after a
    // successful open: open and close on the same owner share one claim
    // series, while ports with distinct owners stay isolated.
    ...(owner === undefined ? {} : { cachedThreads: () => owner as never }),
    failWindows(count: number) {
      windowFailures += count;
    },
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
  const restorePaging = new ArchivePaging();
  const port = stubPort();
  await restorePaging.openArchive(port);
  // The same client drops offline for the home restore.
  port.failWindows(1);
  expect(await restorePaging.closeArchive(port)).toBe(false);
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
  // Superseded, not failed: the new session owns the archive window.
  expect(await closing).toBe(true);
  expect(paging.open).toBe(true);
  expect(paging.restoreFailed).toBe(false);
});

test("a flaky home restore retries instead of stranding the inbox", async () => {
  const port = stubPort();
  const paging = new ArchivePaging();
  await paging.openArchive(port);
  // Two offline blips, then the home window lands: no strand, no flag.
  port.failWindows(2);
  expect(await paging.closeArchiveWithRetry(port, 3)).toBe(true);
  expect(paging.restoreFailed).toBe(false);
  expect(paging.open).toBe(false);
  expect(port.calls).toEqual(["window", "window", "window", "window"]);

  const stranded = new ArchivePaging();
  await stranded.openArchive(port);
  port.failWindows(5);
  expect(await stranded.closeArchiveWithRetry(port, 2)).toBe(false);
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
  expect(isArchiveWindowWanted(port)).toBe(true);
  const closing = first.closeArchive(port);
  const second = new ArchivePaging();
  const opening = second.openArchive(port);
  expect(await opening).toBe(true);
  // The delayed home restore lands after the reopen: superseded, which reports
  // success (the new route owns the window, so there is no strand to report).
  releaseHome();
  expect(await closing).toBe(true);
  expect(first.superseded).toBe(true);
  expect(first.restoreFailed).toBe(false);
  expect(second.open).toBe(true);
  expect(second.failed).toBe(false);
  expect(second.superseded).toBe(false);
  expect(isArchiveWindowWanted(port)).toBe(true);
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
  expect(await closing).toBe(true);
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
  expect(isArchiveWindowWanted(port)).toBe(true);
  requestHomeWindow(port);
  expect(port.calls).toEqual(["window"]);
  await first.closeArchive(port);
  expect(isArchiveWindowWanted(port)).toBe(false);
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

test("archive work on one client never supersedes another client's window", async () => {
  const first = stubPort();
  const second = stubPort();
  const pagingA = new ArchivePaging();
  await pagingA.openArchive(first);
  expect(isArchiveWindowWanted(first)).toBe(true);
  expect(isArchiveWindowWanted(second)).toBe(false);
  // A full open/close cycle on another client leaves the first owner alone.
  const pagingB = new ArchivePaging();
  await pagingB.openArchive(second);
  expect(isArchiveWindowWanted(second)).toBe(true);
  expect(isArchiveWindowWanted(first)).toBe(true);
  expect(pagingA.superseded).toBe(false);
  expect(await pagingB.closeArchive(second)).toBe(true);
  expect(isArchiveWindowWanted(second)).toBe(false);
  expect(isArchiveWindowWanted(first)).toBe(true);
  expect(pagingA.superseded).toBe(false);
  expect(pagingA.open).toBe(true);
  expect(first.calls).toEqual(["window"]);
  expect(second.calls).toEqual(["window", "window"]);
  // A heal for the idle client repoints home without touching the owner.
  requestHomeWindow(second);
  expect(second.calls).toEqual(["window", "window", "window"]);
  expect(first.calls).toEqual(["window"]);
  requestHomeWindow(first);
  expect(first.calls).toEqual(["window"]);
  await pagingA.closeArchive(first);
  expect(isArchiveWindowWanted(first)).toBe(false);
});

test("a superseded close reports success so the old screen stays silent", async () => {
  const port = stubPort();
  const first = new ArchivePaging();
  await first.openArchive(port);
  const closing = first.closeArchive(port);
  const second = new ArchivePaging();
  await second.openArchive(port);
  // Superseded is success: the new route owns the window, so there is no
  // strand to report. Only a session's own failed restore returns false.
  expect(await closing).toBe(true);
  expect(first.superseded).toBe(true);
  expect(first.restoreFailed).toBe(false);
  await second.closeArchive(port);

  const other = stubPort();
  const failing = new ArchivePaging();
  await failing.openArchive(other);
  other.failWindows(1);
  expect(await failing.closeArchive(other)).toBe(false);
  expect(failing.superseded).toBe(false);
  expect(failing.restoreFailed).toBe(true);
});

test("strand recovery heals only when ready and never clobbers an open archive", async () => {
  const port = stubPort();
  recoverStrandedHomeWindow(port, "connecting");
  recoverStrandedHomeWindow(port, "offline");
  recoverStrandedHomeWindow(port, "reconnecting");
  recoverStrandedHomeWindow(port, "fatal");
  recoverStrandedHomeWindow(port, undefined);
  expect(port.calls).toEqual([]);
  recoverStrandedHomeWindow(port, "ready");
  expect(port.calls).toEqual(["window"]);
  const paging = new ArchivePaging();
  await paging.openArchive(port);
  const owned = port.calls.length;
  // An open archive owns the window: the heal yields.
  recoverStrandedHomeWindow(port, "ready");
  requestHomeWindow(port);
  expect(port.calls).toHaveLength(owned);
  await paging.closeArchive(port);
  // The archive is gone: the next ready heal repoints home.
  recoverStrandedHomeWindow(port, "connecting");
  expect(port.calls).toHaveLength(owned + 1);
  recoverStrandedHomeWindow(port, "ready");
  expect(port.calls).toHaveLength(owned + 2);
});

test("an offline close strands until a ready heal repoints home", async () => {
  const port = stubPort();
  const paging = new ArchivePaging();
  await paging.openArchive(port);
  // The same owner drops offline for the home restore.
  port.failWindows(1);
  expect(await paging.closeArchive(port)).toBe(false);
  expect(paging.restoreFailed).toBe(true);
  // Offline and pre-snapshot heals stay silent; only ready repoints home.
  const stranded = port.calls.length;
  recoverStrandedHomeWindow(port, "offline");
  recoverStrandedHomeWindow(port, undefined);
  expect(port.calls).toHaveLength(stranded);
  recoverStrandedHomeWindow(port, "ready");
  expect(port.calls).toHaveLength(stranded + 1);
});

test("two wrappers around one sidebar share one window owner", async () => {
  // One canonical sidebar behind two distinct wrapper objects: the owner is
  // the cached sidebar, not the wrapper identity.
  const owner = {};
  const first = stubPort({}, { owner });
  const second = stubPort({}, { owner });
  expect(archiveOwnerFor(first)).toBe(owner);
  expect(archiveOwnerFor(second)).toBe(owner);
  expect(archiveOwnerFor(first)).toBe(archiveOwnerFor(second));

  const paging = new ArchivePaging();
  expect(await paging.openArchive(first)).toBe(true);
  // The second wrapper sees the same wanted flag through the shared owner.
  expect(isArchiveWindowWanted(first)).toBe(true);
  expect(isArchiveWindowWanted(second)).toBe(true);
  // A heal through the other wrapper yields to the open archive.
  requestHomeWindow(second);
  expect(first.calls).toEqual(["window"]);
  expect(second.calls).toEqual([]);
  // Closing through the other wrapper restores home: not a superseded
  // early-return, a real home call on that wrapper.
  expect(await paging.closeArchive(second)).toBe(true);
  expect(paging.superseded).toBe(false);
  expect(paging.restoreFailed).toBe(false);
  expect(second.calls).toEqual(["window"]);
  expect(first.calls).toEqual(["window"]);
  expect(isArchiveWindowWanted(first)).toBe(false);
  expect(isArchiveWindowWanted(second)).toBe(false);
});

test("a client switch isolates owners and restores each sidebar", async () => {
  // Two canonical sidebars (a client change mints a new one): an open on the
  // new owner never supersedes the old owner's session, and each close
  // restores its own sidebar home.
  const portA = stubPort({}, { owner: {} });
  const portB = stubPort({}, { owner: {} });
  const pagingA = new ArchivePaging();
  await pagingA.openArchive(portA);
  const pagingB = new ArchivePaging();
  await pagingB.openArchive(portB);
  expect(pagingA.superseded).toBe(false);
  expect(pagingB.superseded).toBe(false);
  expect(isArchiveWindowWanted(portA)).toBe(true);
  expect(isArchiveWindowWanted(portB)).toBe(true);
  // Closing the new owner restores only its sidebar.
  expect(await pagingB.closeArchive(portB)).toBe(true);
  expect(isArchiveWindowWanted(portB)).toBe(false);
  expect(isArchiveWindowWanted(portA)).toBe(true);
  expect(portB.calls).toEqual(["window", "window"]);
  expect(portA.calls).toEqual(["window"]);
  // The old owner still restores its own home afterwards.
  expect(await pagingA.closeArchive(portA)).toBe(true);
  expect(isArchiveWindowWanted(portA)).toBe(false);
  expect(portA.calls).toEqual(["window", "window"]);
});

const sdkClients: ClientCore[] = [];

afterEach(async () => {
  for (const client of sdkClients.splice(0)) await client.close();
});

/** A real SDK client as the window port: `threadsWindow` runs the actual `Sidebar`. */
function realClient(): ClientCore {
  const client = new ClientCore({
    deviceId: DeviceId.parse("android-archive-test"),
    transport: () => ({
      open: () => {},
      send: () => {},
      close: () => {},
    }),
    credential: async () => ({ token: "t" }),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set: (delay: number, callback: () => void) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    id: () => crypto.randomUUID(),
    random: () => 0.5,
  });
  sdkClients.push(client);
  return client;
}

test("the real SDK scopes window ownership per client", async () => {
  const first = realClient();
  const second = realClient();
  const leaseA = first.threads();
  const leaseB = second.threads();
  try {
    const pagingA = new ArchivePaging();
    expect(await pagingA.openArchive(first)).toBe(true);
    expect(isArchiveWindowWanted(first)).toBe(true);
    expect(isArchiveWindowWanted(second)).toBe(false);
    const pagingB = new ArchivePaging();
    expect(await pagingB.openArchive(second)).toBe(true);
    // The second machine's open never supersedes the first.
    expect(pagingA.superseded).toBe(false);
    expect(isArchiveWindowWanted(first)).toBe(true);
    expect(isArchiveWindowWanted(second)).toBe(true);
    expect(await pagingB.closeArchive(second)).toBe(true);
    expect(isArchiveWindowWanted(second)).toBe(false);
    expect(isArchiveWindowWanted(first)).toBe(true);
    expect(pagingA.open).toBe(true);
    expect(await pagingA.closeArchive(first)).toBe(true);
    expect(isArchiveWindowWanted(first)).toBe(false);
  } finally {
    leaseA.release();
    leaseB.release();
  }
});

test("a reopen owns the window on the real SDK when the old restore lands late", async () => {
  const client = realClient();
  const lease = client.threads();
  try {
    // Park the real home restore behind a gate while keeping one owner: the
    // wrapper forwards the client's cached sidebar, so open and close share
    // the canonical claim series and the calls still land in the actual
    // sidebar in issue order.
    const calls: string[] = [];
    let releaseHome!: () => void;
    const homeGate = new Promise<void>((resolve) => {
      releaseHome = resolve;
    });
    const gated: ArchiveWindowPort = {
      async threadsWindow(input: { archived?: boolean }) {
        calls.push(input.archived ? "archive" : "home");
        if (!input.archived) await homeGate;
        await client.threadsWindow(input);
      },
      async threadsMore() {},
      cachedThreads: () => client.cachedThreads() as never,
    };
    const first = new ArchivePaging();
    await first.openArchive(gated);
    const closing = first.closeArchive(gated);
    const second = new ArchivePaging();
    expect(await second.openArchive(gated)).toBe(true);
    releaseHome();
    // Superseded, not failed: the new route owns the window.
    expect(await closing).toBe(true);
    expect(first.superseded).toBe(true);
    expect(first.restoreFailed).toBe(false);
    expect(second.open).toBe(true);
    expect(isArchiveWindowWanted(gated)).toBe(true);
    expect(calls).toEqual(["archive", "home", "archive"]);
    expect(await second.closeArchive(gated)).toBe(true);
    expect(isArchiveWindowWanted(gated)).toBe(false);
  } finally {
    lease.release();
  }
});

test("two wrappers around one real client share one window owner", async () => {
  const client = realClient();
  const lease = client.threads();
  try {
    // Two distinct wrapper objects forwarding the same cached sidebar: one
    // canonical owner, so a close through the other wrapper restores home
    // instead of reporting superseded with no call.
    const wrap = (tag: string): ArchiveWindowPort & { calls: string[] } => {
      const calls: string[] = [];
      return {
        calls,
        async threadsWindow(input: { archived?: boolean }) {
          calls.push(input.archived ? tag : "home");
          await client.threadsWindow(input);
        },
        async threadsMore(options) {
          await client.threadsMore(options);
        },
        cachedThreads: () => client.cachedThreads() as never,
      };
    };
    const first = wrap("archive-a");
    const second = wrap("archive-b");
    expect(archiveOwnerFor(first)).toBe(archiveOwnerFor(second));
    const paging = new ArchivePaging();
    expect(await paging.openArchive(first)).toBe(true);
    expect(isArchiveWindowWanted(second)).toBe(true);
    // A heal through the other wrapper yields to the open archive.
    requestHomeWindow(second);
    expect(second.calls).toEqual([]);
    expect(await paging.closeArchive(second)).toBe(true);
    expect(paging.superseded).toBe(false);
    expect(paging.restoreFailed).toBe(false);
    expect(second.calls).toEqual(["home"]);
    expect(isArchiveWindowWanted(first)).toBe(false);
  } finally {
    lease.release();
  }
});
