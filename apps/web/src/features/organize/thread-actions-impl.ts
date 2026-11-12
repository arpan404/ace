import type { CommandPayload, ThreadListEntry } from "@ace/protocol";
import { ThreadId, WorkspaceId } from "@ace/protocol";
import { CommandRefused, failureMessage, stillAlive, waitingNote } from "@/lib/daemon-command.ts";
import {
  deleteQuestion,
  isChatEntry,
  runningWork,
  stopAndDeleteQuestion,
  type OrganizePatch,
} from "@ace/ui-core";
import { askBeforeArchive } from "./delete-confirmation.ts";
import { chatChoice } from "@/lib/chat-choice.ts";
import { leftRunningOn } from "./left-running.ts";
import type {
  SnoozeWakeOn,
  ThreadActions,
  ThreadActionsDeps,
  ThreadTarget,
} from "./thread-action-types.ts";
import { undoWindowMs } from "./undo-window.ts";

/*
 * What every organize action does (ADR 0057), loaded after the first paint
 * (`use-thread-actions.ts` hands calls here once it has arrived).
 */

type Organize = Extract<
  CommandPayload,
  {
    type:
      | "thread.settle"
      | "thread.unsettle"
      | "thread.autoSettle"
      | "thread.snooze"
      | "thread.pin"
      | "thread.read"
      | "thread.rename"
      | "thread.archive"
      | "thread.unarchive"
      | "thread.delete"
      | "thread.place"
      | "thread.move";
  }
>;

/** A delete the daemon refused, and whether it was refused only for work still running. */
interface Refusal {
  entry: ThreadTarget;
  error: unknown;
  live: boolean;
}

/** One organize action: what it shows at once, the command, and words for its list and toast. */
interface Action {
  patch: OrganizePatch;
  payload: Organize;
  /** "Archive", for the list of what waits for the daemon. */
  verb: string;
  /** "archive the thread", after "Couldn't". */
  failed: string;
}

const id = (entry: ThreadTarget) => ThreadId.parse(entry.id);
const count = (n: number) => (n === 1 ? "1 thread" : `${n} threads`);

const pin = (entry: ThreadTarget, order?: number): Action => ({
  patch: order === undefined ? { pinned: true } : { pinned: true, pinOrder: order },
  payload: {
    type: "thread.pin",
    threadId: id(entry),
    pinned: true,
    ...(order === undefined ? {} : { order }),
  },
  verb: "Pin",
  failed: "pin the thread",
});

const unpin = (entry: ThreadTarget): Action => ({
  patch: { pinned: false },
  payload: { type: "thread.pin", threadId: id(entry), pinned: false },
  verb: "Unpin",
  failed: "unpin the thread",
});

const settle = (entry: ThreadTarget): Action => ({
  patch: { settled: true },
  payload: { type: "thread.settle", threadId: id(entry) },
  verb: "Settle",
  failed: "settle the thread",
});

/** Taking a settle back: only the settle goes (`thread.unsettle` with `undo`). */
const undoSettle = (entry: ThreadTarget): Action => ({
  patch: { undoSettle: true },
  payload: { type: "thread.unsettle", threadId: id(entry), undo: true },
  verb: "Undo settle",
  failed: "take the settle back",
});

const unsettle = (entry: ThreadTarget): Action => ({
  patch: { settled: false, autoSettle: false },
  payload: { type: "thread.unsettle", threadId: id(entry) },
  verb: "Unsettle",
  failed: "unsettle the thread",
});

const autoSettle = (entry: ThreadTarget, enabled: boolean): Action => ({
  patch: { autoSettle: enabled },
  payload: { type: "thread.autoSettle", threadId: id(entry), enabled },
  verb: enabled ? "Turn on auto-settle" : "Turn off auto-settle",
  failed: enabled ? "turn on auto-settle" : "turn off auto-settle",
});

const snooze = (entry: ThreadTarget, until: number | null, wake?: SnoozeWakeOn): Action => ({
  patch: { snoozedUntil: until, snoozeWake: wake ?? null },
  payload: { type: "thread.snooze", threadId: id(entry), until, ...(wake ? { wake } : {}) },
  verb: until === null ? "Wake" : "Snooze",
  failed: until === null ? "wake the thread" : "snooze the thread",
});

const archive = (entry: ThreadTarget): Action => ({
  patch: { archived: true },
  payload: { type: "thread.archive", threadId: id(entry) },
  verb: "Archive",
  failed: "archive the thread",
});

const unarchive = (entry: ThreadTarget): Action => ({
  patch: { archived: false },
  payload: { type: "thread.unarchive", threadId: id(entry) },
  verb: "Unarchive",
  failed: "unarchive it",
});

/** Taking an archived thread back into the list. */
const restore = (entry: ThreadTarget): Action => ({
  ...unarchive(entry),
  verb: "Restore",
  failed: "restore it",
});

const move = (entry: ThreadTarget, to: string): Action => {
  const workspaceId = WorkspaceId.parse(to);
  return {
    patch: { workspaceId },
    payload: { type: "thread.move", threadId: id(entry), workspaceId },
    verb: "Move",
    failed: "move the thread",
  };
};

const rename = (entry: ThreadTarget, title: string): Action => ({
  patch: { title },
  payload: { type: "thread.rename", threadId: id(entry), title },
  verb: "Rename",
  failed: "rename the thread",
});

/** The organize actions against one machine's client, once their code has loaded. */
export function threadActionsNow(deps: ThreadActionsDeps): ThreadActions {
  const { overlay, confirmation, archiving, client, toast, navigate, router, machine } = deps;
  /** Apply now, send, and say so if the daemon refuses. False after a refusal. */
  const act = (entry: ThreadTarget, action: Action) =>
    overlay
      .run(entry.id, action.patch, action.payload, `${action.verb} · ${entry.title}`, Date.now())
      .then(
        () => true,
        (error: unknown) => {
          toast.error({ title: `Couldn't ${action.failed}`, description: failureMessage(error) });
          return false;
        },
      );
  /** Offline, the done toast says when it will apply. */
  const waiting = () => {
    const note = waitingNote({ online: client.state === "ready", slow: false });
    return note ? { description: note } : {};
  };
  /** Apply each now with one toast offering Undo, which runs every `undo`. */
  const reversibleAll = (
    steps: readonly { entry: ThreadTarget; action: Action; undo: Action }[],
    done: string,
    afterUndo?: () => void,
  ): Promise<boolean> => {
    const toastId = toast.add({
      title: done,
      ...waiting(),
      timeout: undoWindowMs,
      // The button or ⌘Z (`undoLatest`), while the toast shows.
      undo: () => {
        for (const step of steps) void act(step.entry, step.undo);
        afterUndo?.();
      },
    });
    return Promise.all(steps.map((step) => act(step.entry, step.action))).then((results) => {
      const applied = results.some(Boolean);
      if (!applied) toast.close(toastId);
      return applied;
    });
  };
  const leftRunning = (entries: readonly ThreadTarget[]) => leftRunningOn(client, entries);
  const archiveManyNow = (entries: readonly ThreadTarget[]) =>
    void reversibleAll(
      entries.map((entry) => ({ entry, action: archive(entry), undo: unarchive(entry) })),
      `Archived ${count(entries.length)}`,
    );
  /** Stop the whole tree and the commands it watches, as Stop & archive promises. */
  const stopTree = (listed: ThreadListEntry) => {
    const runId = listed.live?.rootRunId ?? undefined;
    const sends = [
      client.enqueue(
        {
          type: "thread.interrupt",
          threadId: listed.id,
          cascade: true,
          ...(runId ? { runId } : {}),
        },
        crypto.randomUUID(),
      ),
      ...(listed.live?.watching ?? []).map((task) =>
        client.enqueue({ type: "background_task.stop", taskId: task.id }, crypto.randomUUID()),
      ),
    ];
    void Promise.all(sends).catch((error: unknown) =>
      toast.error({ title: "Couldn't stop the thread", description: failureMessage(error) }),
    );
  };
  const deleteOne = (entry: ThreadTarget, force: boolean) =>
    overlay
      .run(
        entry.id,
        { deleted: true },
        { type: "thread.delete", threadId: id(entry), ...(force ? { force } : {}) },
        `${force ? "Stop and delete" : "Delete"} · ${entry.title}`,
        Date.now(),
      )
      .then(
        (): Refusal | undefined => undefined,
        (error: unknown): Refusal => ({
          entry,
          error,
          live: !force && error instanceof CommandRefused && stillAlive(error.alive),
        }),
      );
  /**
   * Delete each now: the permanent command goes out at once (to the durable outbox when
   * offline), never waiting on a toast. There is no Undo; the caller asked first. Threads
   * refused only because their agents or terminals are still running are offered together
   * as one Stop and delete, which stops that work on the daemon and then deletes.
   */
  const removeAll = (entries: readonly ThreadTarget[], force = false) => {
    // Read before the delete: a chat's hidden project goes with its last thread (ADR 0099).
    const lease = client.threads();
    const chats = new Set(
      entries.flatMap((entry) => {
        const listed = lease.store.thread(entry.id);
        return listed && isChatEntry(listed) ? [entry.id] : [];
      }),
    );
    lease.release();
    void Promise.all(entries.map((entry) => deleteOne(entry, force))).then((outcomes) => {
      const refused = outcomes.filter((outcome) => outcome !== undefined);
      const removed = entries.length - refused.length;
      // The rows leaving the list are the confirmation.
      if (removed) {
        // The open thread is one of them only on its own machine.
        const shown: { machine?: unknown } = router.state.location.search;
        const activeDeleted = entries.find(
          (entry) =>
            router.state.location.pathname === `/t/${encodeURIComponent(entry.id)}` &&
            (shown.machine ?? undefined) === machine.machine &&
            !refused.some((refusal) => refusal.entry.id === entry.id),
        );
        // A deleted chat opens a new chat, not its hidden project, which may be gone.
        if (activeDeleted)
          void navigate({
            to: "/new",
            search: {
              project: chats.has(activeDeleted.id) ? chatChoice : activeDeleted.workspaceId,
              ...machine,
            },
            replace: true,
          });
      }
      const live = refused.filter((refusal) => refusal.live);
      for (const refusal of refused.filter((each) => !each.live))
        toast.add({
          title: force ? "Couldn't stop and delete the thread" : "Couldn't delete the thread",
          description: failureMessage(refusal.error),
        });
      const only = live.length === 1 ? live[0] : undefined;
      if (!live.length) return;
      confirmation.open({
        title: only ? only.entry.title : count(live.length),
        running: stopAndDeleteQuestion(live.map((refusal) => refusal.entry.title)).running,
        confirm: () =>
          removeAll(
            live.map((refusal) => refusal.entry),
            true,
          ),
      });
    });
  };
  return {
    settle: (entry) =>
      void reversibleAll(
        [{ entry, action: settle(entry), undo: undoSettle(entry) }],
        `Settled · ${entry.title}`,
      ),
    unsettle: (entry) => void act(entry, unsettle(entry)),
    setAutoSettle: (entry, enabled) => void act(entry, autoSettle(entry, enabled)),
    snooze: (entry, until, wake, label) => {
      // Undo puts back the snooze it had, if one was still ahead, else wakes it.
      const before =
        entry.snoozedUntil != null && entry.snoozedUntil > Date.now()
          ? snooze(entry, entry.snoozedUntil, entry.snoozeWake?.on)
          : snooze(entry, null);
      void reversibleAll(
        [{ entry, action: snooze(entry, until, wake), undo: before }],
        `Snoozed${label ? ` ${label}` : ""} · ${entry.title}`,
      );
    },
    wake: (entry) => void act(entry, snooze(entry, null)),
    setPinned: (entry, pinned) => void act(entry, pinned ? pin(entry) : unpin(entry)),
    placePinned: (placements) => {
      for (const { entry, order } of placements) void act(entry, pin(entry, order));
    },
    placeListed: (placements) => {
      for (const { entry, order } of placements)
        void act(entry, {
          patch: { listOrder: order },
          payload: { type: "thread.place", threadId: id(entry), order },
          verb: "Move",
          failed: "move the thread",
        });
    },
    setPinnedMany: (entries, pinned) => {
      const changing = entries.filter((entry) => (entry.pinned === true) !== pinned);
      if (!changing.length) return;
      if (pinned) {
        // They lead the group together, in the order they were listed.
        const top = Date.now();
        changing.forEach((entry, index) => {
          void act(entry, pin(entry, top + changing.length - index));
        });
        return;
      }
      for (const entry of changing) void act(entry, unpin(entry));
    },
    archiveMany: (entries, archived) =>
      askBeforeArchive(archiving, leftRunning(entries), () => {
        archiveManyNow(entries);
        archived?.();
      }),
    archiveManyNow,
    leftRunning,
    removeMany: (entries) => removeAll(entries),
    moveMany: (entries, to) => {
      const moving = entries.filter((entry) => entry.workspaceId !== to.id);
      if (!moving.length) return;
      void reversibleAll(
        moving.map((entry) => ({
          entry,
          action: move(entry, to.id),
          undo: move({ ...entry, workspaceId: to.id }, entry.workspaceId),
        })),
        moving.length === 1 ? `Moved to ${to.name}` : `Moved ${count(moving.length)} to ${to.name}`,
      );
    },
    setUnread: (entry, unread) =>
      void act(entry, {
        patch: { unread },
        payload: { type: "thread.read", threadId: id(entry), unread },
        verb: unread ? "Mark unread" : "Mark read",
        failed: unread ? "mark the thread unread" : "mark the thread read",
      }),
    rename: (entry, title) => {
      const trimmed = title.trim();
      if (!trimmed || trimmed === entry.title) return;
      overlay.takeRefusedTitle(entry.id);
      void act(entry, rename(entry, trimmed)).then((renamed) => {
        // The rename field opens again with what the person typed.
        if (!renamed) overlay.refuseTitle(entry.id, title);
      });
    },
    archive: (entry, leave) => {
      const archiveNow = () => {
        void reversibleAll(
          [{ entry, action: archive(entry), undo: unarchive(entry) }],
          `Archived · ${entry.title}`,
          // Undo takes the person back to the thread they archived, wherever they went.
          () =>
            void navigate({ to: "/t/$threadId", params: { threadId: entry.id }, search: machine }),
        );
        leave?.();
      };
      const lease = client.threads();
      const listed = lease.store.thread(entry.id);
      lease.release();
      const running = listed && runningWork(listed);
      if (!listed || !running) {
        // Done, but with commands left running: Undo brings the thread back, not them.
        return askBeforeArchive(archiving, leftRunning([entry]), archiveNow);
      }
      archiving.open({
        kind: "running",
        title: entry.title,
        running,
        archive: archiveNow,
        stopAndArchive: () => {
          stopTree(listed);
          archiveNow();
        },
      });
    },
    restore: (entry) => void act(entry, restore(entry)),
    deleteArchived: (entry) => removeAll([entry]),
    remove: (entry) => {
      const lease = client.threads();
      const status = lease.store.thread(entry.id)?.status;
      lease.release();
      const question = status ? deleteQuestion([{ title: entry.title, status }]) : undefined;
      confirmation.open({
        title: entry.title,
        running: question?.running ?? "",
        confirm: () => removeAll([entry], question?.force === true),
      });
    },
    newThreadOnMain: (entry) =>
      // No base: New thread starts from the project's own default branch, whatever it's named.
      void navigate({ to: "/new", search: { project: entry.workspaceId, ...machine } }),
    copyLink: (entry) => {
      const link = new URL(`/t/${entry.id}`, location.href);
      if (machine.machine) link.searchParams.set("machine", machine.machine);
      const copied =
        navigator.clipboard?.writeText(link.href) ?? Promise.reject(new Error("no clipboard"));
      void copied.catch(() => toast.error({ title: "Couldn't copy the link" }));
    },
  };
}
