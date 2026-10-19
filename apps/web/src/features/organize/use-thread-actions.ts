import { useClient } from "@ace/client-react";
import type { CommandPayload, ThreadListEntry } from "@ace/protocol";
import { ThreadId, WorkspaceId } from "@ace/protocol";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useMemo } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { CommandRefused, failureMessage, stillAlive, waitingNote } from "@/lib/daemon-command.ts";
import type { OrganizePatch } from "@ace/ui-core";
import { useArchiveConfirmation, useDeleteConfirmation } from "./delete-confirmation.ts";
import { runningWork } from "./running-work.ts";
import { useOrganizeOverlay } from "./overlay.ts";

/** How long Undo stays on screen for reversible actions. */
export const undoWindowMs = 5_000;

/** What an action needs of a thread: a Home list entry or the open thread's meta. */
export interface ThreadTarget {
  id: string;
  title: string;
  workspaceId: string;
  snoozedUntil?: number | null | undefined;
  pinned?: boolean | undefined;
  /** Its place among pinned threads, so Undo puts an unpinned thread back where it was. */
  pinOrder?: number | undefined;
}

/** A pinned thread's new place, from a drag or a keyboard move (`placePinned`). */
export interface PinPlacement {
  entry: ThreadTarget;
  order: number;
}

export interface ThreadActions {
  settle(entry: ThreadTarget): void;
  unsettle(entry: ThreadTarget): void;
  snooze(entry: ThreadTarget, until: number): void;
  wake(entry: ThreadTarget): void;
  /** Pin (leading the group) or unpin. */
  setPinned(entry: ThreadTarget, pinned: boolean): void;
  /** Pin each thread at its new place: a drop into the Pinned group or a move within it. */
  placePinned(placements: readonly PinPlacement[]): void;
  /** Put each thread at its new place in the hand-sorted Home list. */
  placeListed(placements: readonly PinPlacement[]): void;
  /** Pin (leading the group, in list order) or unpin several at once. */
  setPinnedMany(entries: readonly ThreadTarget[], pinned: boolean): void;
  /** Archive several threads at once, with one Undo. */
  archiveMany(entries: readonly ThreadTarget[]): void;
  /** Delete several threads at once, for good: no Undo, so ask first. */
  removeMany(entries: readonly ThreadTarget[]): void;
  /** Move threads to another project, with one Undo back to where each was. */
  moveMany(entries: readonly ThreadTarget[], to: { id: string; name: string }): void;
  setUnread(entry: ThreadTarget, unread: boolean): void;
  rename(entry: ThreadTarget, title: string): void;
  /**
   * Archive with Undo, which opens the thread again. A thread still working or waiting on the
   * person asks first: stop it too, or keep it running. `leave` runs once it is archived.
   */
  archive(entry: ThreadTarget, leave?: () => void): void;
  /** Back from the archive to Home. */
  restore(entry: ThreadTarget): void;
  remove(entry: ThreadTarget): void;
  /** An archived thread, deleted now: the person confirmed it, so there is no Undo. */
  deleteArchived(entry: ThreadTarget): void;
  /** New thread in the entry's project, from its default branch. */
  newThreadOnMain(entry: ThreadTarget): void;
  copyLink(entry: ThreadTarget): void;
}

type Organize = Extract<
  CommandPayload,
  {
    type:
      | "thread.settle"
      | "thread.unsettle"
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

/**
 * Every list action as a durable daemon command (ADR 0057), so the organization follows the
 * person to every device. Each shows its effect at once and undoes it, with a toast saying why,
 * only when the daemon refuses it; offline it waits and applies on reconnect. Small changes the
 * list already shows (settle, snooze, pin, rename, restore) say nothing more. Actions that take
 * a thread out of sight (archive, move) confirm with a toast offering Undo, which sends the
 * opposite command.
 *
 * Delete submits the permanent command immediately, including to the durable outbox when
 * offline. Its persistence must not depend on a toast or the lifetime of this window.
 * Moving to another project keeps the pin, as the daemon does, and Undo moves it back. Bulk
 * actions offer one Undo for all,
 * except delete. The Home context menu and the thread's ⋯ menu both use these, so
 * labels, toasts and Undo match wherever the person acts.
 */
export function useThreadActions(): ThreadActions {
  const overlay = useOrganizeOverlay();
  const confirmation = useDeleteConfirmation();
  const archiving = useArchiveConfirmation();
  const client = useClient();
  const toast = useToast();
  const navigate = useNavigate();
  const router = useRouter();
  return useMemo(() => {
    const id = (entry: ThreadTarget) => ThreadId.parse(entry.id);
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
    const count = (n: number) => (n === 1 ? "1 thread" : `${n} threads`);
    const settle = (entry: ThreadTarget): Action => ({
      patch: { settled: true },
      payload: { type: "thread.settle", threadId: id(entry) },
      verb: "Settle",
      failed: "settle the thread",
    });
    const unsettle = (entry: ThreadTarget): Action => ({
      patch: { settled: false },
      payload: { type: "thread.unsettle", threadId: id(entry) },
      verb: "Unsettle",
      failed: "unsettle the thread",
    });
    const snooze = (entry: ThreadTarget, until: number | null): Action => ({
      patch: { snoozedUntil: until },
      payload: { type: "thread.snooze", threadId: id(entry), until },
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
    const removeAll = (
      entries: readonly ThreadTarget[],
      done: (count: number) => string,
      force = false,
    ) => {
      void Promise.all(entries.map((entry) => deleteOne(entry, force))).then((outcomes) => {
        const refused = outcomes.filter((outcome) => outcome !== undefined);
        const removed = entries.length - refused.length;
        if (removed) {
          toast.add({ title: done(removed) });
          const activeDeleted = entries.find(
            (entry) =>
              router.state.location.pathname === `/t/${encodeURIComponent(entry.id)}` &&
              !refused.some((refusal) => refusal.entry.id === entry.id),
          );
          if (activeDeleted)
            void navigate({
              to: "/new",
              search: { project: activeDeleted.workspaceId },
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
          running: "Agents or terminals are still running. They will stop before deletion.",
          confirm: () =>
            removeAll(
              live.map((refusal) => refusal.entry),
              done,
              true,
            ),
        });
      });
    };
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
    return {
      settle: (entry) => void act(entry, settle(entry)),
      unsettle: (entry) => void act(entry, unsettle(entry)),
      snooze: (entry, until) => void act(entry, snooze(entry, until)),
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
      archiveMany: (entries) =>
        void reversibleAll(
          entries.map((entry) => ({ entry, action: archive(entry), undo: unarchive(entry) })),
          `Archived ${count(entries.length)}`,
        ),
      removeMany: (entries) => removeAll(entries, (deleted) => `Deleted ${count(deleted)}`),
      moveMany: (entries, to) => {
        const moving = entries.filter((entry) => entry.workspaceId !== to.id);
        if (!moving.length) return;
        void reversibleAll(
          moving.map((entry) => ({
            entry,
            action: move(entry, to.id),
            undo: move({ ...entry, workspaceId: to.id }, entry.workspaceId),
          })),
          moving.length === 1
            ? `Moved to ${to.name}`
            : `Moved ${count(moving.length)} to ${to.name}`,
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
            () => void navigate({ to: "/t/$threadId", params: { threadId: entry.id } }),
          );
          leave?.();
        };
        const lease = client.threads();
        const listed = lease.store.thread(entry.id);
        lease.release();
        const running = listed && runningWork(listed);
        if (!listed || !running) return archiveNow();
        archiving.open({
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
      deleteArchived: (entry) => removeAll([entry], () => `Deleted · ${entry.title}`),
      remove: (entry) => {
        const lease = client.threads();
        const status = lease.store.thread(entry.id)?.status;
        lease.release();
        const running = status && !["done", "failed", "stopped"].includes(status.state);
        confirmation.open({
          title: entry.title,
          running: running
            ? `${status.state === "working" ? status.agents : 1} ${status.state === "working" && status.agents !== 1 ? "agents" : "agent"} running. Running work will stop before deletion.`
            : "",
          confirm: () => removeAll([entry], () => `Deleted · ${entry.title}`, !!running),
        });
      },
      newThreadOnMain: (entry) =>
        // No base: New thread starts from the project's own default branch, whatever it's named.
        void navigate({ to: "/new", search: { project: entry.workspaceId } }),
      copyLink: (entry) => {
        const link = new URL(`/t/${entry.id}`, location.href).href;
        const copied =
          navigator.clipboard?.writeText(link) ?? Promise.reject(new Error("no clipboard"));
        void copied.then(
          () => toast.add({ title: "Link copied" }),
          () => toast.error({ title: "Couldn't copy the link" }),
        );
      },
    };
  }, [overlay, client, toast, navigate, router, confirmation, archiving]);
}
