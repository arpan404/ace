import type { ActivityCounts } from "@ace/notify";
import { activityBusy, classifyActivityThread, type ActivityRow } from "@ace/notify";
import { sidebarSettled, stoppedByPerson, threadAttention } from "@ace/projection";
import { ThreadId, type DeviceId, type Event, type Thread } from "@ace/protocol";
import {
  isUnread,
  leftRunningCount,
  rowStatusLook,
  rowStatusState,
  threadCard,
} from "@ace/ui-core";
import type { Store } from "./store.ts";

const page = 128;
const settled = new Set(["new", "done", "failed", "moved"]);
const counted = {
  "needs-you": "needsYou",
  working: "working",
  waiting: "waiting",
  limited: "limited",
  background: "background",
} as const;
type BusyRow = keyof typeof counted;

const visible = (entry: Pick<Thread, "deletedAt" | "host" | "delegatedFrom">) =>
  entry.deletedAt === undefined && entry.host === undefined && entry.delegatedFrom === undefined;

function category(entry: Thread, now: number): ActivityRow {
  const card = threadCard({
    entry,
    details: undefined,
    baseline: 0,
    now,
    settled: sidebarSettled(entry),
  });
  return classifyActivityThread({
    row: rowStatusState(card.attention, rowStatusLook(card.attention, card)),
    status: entry.status.state,
    queued:
      entry.queuedLaunch !== undefined ||
      (entry.queue?.pendingCount ?? 0) > 0 ||
      threadAttention(entry) !== undefined,
    background: leftRunningCount(entry.live) > 0 || (entry.live?.backgroundTaskCount ?? 0) > 0,
  });
}

function activityEvent({ payload }: Event): boolean {
  switch (payload.type) {
    case "thread.updated":
      return payload.status !== undefined || payload.archivedAt !== undefined;
    case "thread.created":
    case "thread.client.updated":
    case "queue.updated":
    case "agent.status":
    case "background_task.started":
    case "background_task.updated":
      return true;
    case "item.created":
    case "item.updated":
      return payload.item.type === "delegation.started";
    default:
      return false;
  }
}

/**
 * Work started, even if it is over before the next read: the quiet grace starts again. A read
 * only sees the state at that moment, so a command that ran between two reads would otherwise
 * leave the old deadline in place.
 */
function busyTransition({ payload }: Event): boolean {
  switch (payload.type) {
    case "thread.updated":
      return payload.status !== undefined && !settled.has(payload.status.state);
    case "queue.updated":
      return (payload.pendingCount ?? 0) > 0;
    case "agent.status":
      return payload.status.state !== "idle" && payload.status.state !== "interrupted";
    case "background_task.started":
      return true;
    case "background_task.updated":
      return payload.status === "running";
    case "item.created":
    case "item.updated":
      return payload.item.type === "delegation.started" && payload.item.phase !== "settled";
    default:
      return false;
  }
}

interface Row {
  entry: Thread;
  category: ActivityRow;
}

function countKey(row: ActivityRow): (typeof counted)[BusyRow] | undefined {
  if (Object.hasOwn(counted, row)) return counted[row as BusyRow];
  return undefined;
}

export interface ActivitySnapshot {
  counts: ActivityCounts;
  settledSince: number | undefined;
  /** Urgent transitions use the snooze of the threads that contributed to them. */
  needsYouSnoozed: boolean;
  failedSnoozed: boolean;
  workSnoozed: boolean;
}

/**
 * Reads the same whole-thread status and live hints as the inbox. Advance the indexed row
 * revisions in short batches so a cold home with long history never blocks startup or a send.
 */
export function activityState(store: Store, now: () => number, finished: (seq: number) => void) {
  const rows = new Map<ThreadId, Row>();
  let revision = 0;
  let removed = 0;
  let settledSince: number | undefined;
  let recentWork = new Set<ThreadId>();
  let quietWork = new Set<ThreadId>();

  function reset() {
    rows.clear();
    revision = 0;
    removed = 0;
    settledSince = undefined;
    recentWork.clear();
    quietWork.clear();
  }

  function changed(events: readonly Event[]): boolean {
    let relevant = false;
    for (const event of events) {
      if (!activityEvent(event)) continue;
      relevant = true;
      const { payload, threadId } = event;
      // A delegated child's work keeps its parent's tree busy, so only a deleted or hosted
      // thread is left out here.
      if (busyTransition(event)) {
        const entry = store.readThread(threadId);
        if (entry && entry.deletedAt === undefined && entry.host === undefined)
          settledSince = undefined;
      }
      if (payload.type === "thread.updated" && payload.status?.state === "done") {
        const entry = store.readThread(threadId);
        if (entry && visible(entry) && !stoppedByPerson(entry)) finished(event.seq);
      }
    }
    return relevant;
  }

  /** Include pending edges even before the engine has folded them into their parent's row. */
  function pendingParents(): ThreadId[] {
    return store.atomic((db) => {
      const local = db.prepare("SELECT 1 FROM sqlite_master WHERE name='delegated_threads'").get();
      const remoteParents = "SELECT parent_thread AS id FROM machine_children WHERE settled=0";
      const localParents = "SELECT parent_id AS id FROM delegated_threads WHERE phase<>'settled'";
      const collect = (query: string) =>
        db
          .prepare(
            `SELECT DISTINCT parents.id FROM (${query}) AS parents JOIN threads ON threads.id=parents.id
          WHERE json_extract(threads.client,'$.deletedAt') IS NULL
          AND json_extract(threads.client,'$.host') IS NULL
          AND json_extract(threads.transitions,'$.delegatedFrom') IS NULL LIMIT 1000`,
          )
          .all()
          .map((row) => ThreadId.parse(row.id));
      return [...new Set([...collect(remoteParents), ...(local ? collect(localParents) : [])])];
    });
  }

  function advance(): boolean {
    const { updated, deleted, deleteCount } = store.atomic((db) => ({
      updated: db
        .prepare(
          "SELECT thread_id, revision FROM sidebar_thread_revisions WHERE revision > ? ORDER BY revision LIMIT ?",
        )
        .all(revision, page),
      deleted: db
        .prepare(
          "SELECT thread_id, revision FROM sidebar_thread_removals WHERE revision > ? ORDER BY revision LIMIT ?",
        )
        .all(removed, page),
      deleteCount: Number(
        db.prepare("SELECT count FROM sidebar_thread_deletes WHERE id=1").get()?.count ?? 0,
      ),
    }));
    // The removal log is bounded. If we missed some, a new scan will rebuild membership.
    if (revision !== 0 && deleteCount - removed > 4096) {
      rows.clear();
      settledSince = undefined;
      revision = 0;
      removed = deleteCount;
      return false;
    }
    const at = now();
    for (const row of deleted) {
      rows.delete(ThreadId.parse(row.thread_id));
      removed = Number(row.revision);
    }
    for (const row of updated) {
      revision = Number(row.revision);
      const id = ThreadId.parse(row.thread_id);
      const entry = store.getThread(id);
      rows.delete(id);
      if (!entry || !visible(entry)) continue;
      const state = category(entry, at);
      if (countKey(state) || state === "failed") rows.set(id, { entry, category: state });
    }
    return updated.length < page && deleted.length < page;
  }

  function read(devices: readonly DeviceId[]): ActivitySnapshot | undefined {
    if (store.isHistoryWriting() || !advance()) return undefined;
    const at = now();
    const counts: ActivityCounts = {
      needsYou: 0,
      working: 0,
      failed: 0,
      waiting: 0,
      limited: 0,
      background: 0,
      done: 0,
    };
    const pending = new Set(pendingParents());
    const working = new Set<ThreadId>();
    let needsYouSnoozed = true;
    let failedSnoozed = true;
    for (const [id, row] of rows) {
      const snoozed = (row.entry.snoozedUntil ?? 0) > at;
      const hasChild = pending.delete(id);
      const state = hasChild && row.category !== "needs-you" ? "working" : row.category;
      const key = countKey(state);
      if (key) {
        counts[key]++;
        working.add(id);
        if (state === "needs-you") needsYouSnoozed &&= snoozed;
      } else if (
        state === "failed" &&
        devices.every((device) => isUnread(row.entry, 0, store.threadReadState(id, device)))
      ) {
        counts.failed++;
        failedSnoozed &&= snoozed;
      }
    }
    for (const id of pending) {
      counts.working++;
      working.add(id);
    }
    if (activityBusy(counts)) {
      settledSince = undefined;
      recentWork = working;
    } else if (settledSince === undefined) {
      settledSince = at;
      quietWork = recentWork;
      recentWork = new Set();
    }
    const work = activityBusy(counts) ? working : quietWork;
    const workSnoozed =
      work.size > 0 && [...work].every((id) => (store.readThread(id)?.snoozedUntil ?? 0) > at);
    return { counts, settledSince, needsYouSnoozed, failedSnoozed, workSnoozed };
  }
  return { changed, read, reset };
}
