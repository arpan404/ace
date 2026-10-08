import { useClient } from "@ace/client-react";
import type { CommandPayload } from "@ace/protocol";
import { ThreadId, WorkspaceId } from "@ace/protocol";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { CommandRefused, failureMessage, stillAlive, waitingNote } from "@/lib/daemon-command.ts";
import { describeWake, type OrganizePatch } from "@ace/ui-core";
import { useOrganizeOverlay } from "./overlay.ts";

/** How long Undo stays on screen for reversible actions. */
export const undoWindowMs = 6_000;

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
  snooze(entry: ThreadTarget, until: number, now: number): void;
  wake(entry: ThreadTarget): void;
  /** Pin (leading the group) or unpin (with Undo). */
  setPinned(entry: ThreadTarget, pinned: boolean): void;
  /** Pin each thread at its new place: a drop into the Pinned group or a move within it. */
  placePinned(placements: readonly PinPlacement[]): void;
  /** Pin (leading the group, in list order) or unpin several at once, with one Undo. */
  setPinnedMany(entries: readonly ThreadTarget[], pinned: boolean): void;
  /** Archive several threads at once, with one Undo. */
  archiveMany(entries: readonly ThreadTarget[]): void;
  /** Delete several threads at once, for good: no Undo, so ask first. */
  removeMany(entries: readonly ThreadTarget[]): void;
  /** Move threads to another project, with one Undo back to where each was. */
  moveMany(entries: readonly ThreadTarget[], to: { id: string; name: string }): void;
  setUnread(entry: ThreadTarget, unread: boolean): void;
  rename(entry: ThreadTarget, title: string): void;
  archive(entry: ThreadTarget): void;
  /** Back from the archive to Home, with Undo. */
  restore(entry: ThreadTarget): void;
  remove(entry: ThreadTarget): void;
  /** An archived thread, deleted now: the person confirmed it, so there is no Undo. */
  deleteArchived(entry: ThreadTarget): void;
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
 * only when the daemon refuses it; offline it waits and applies on reconnect. The reversible
 * ones offer Undo, which sends the opposite command.
 *
 * Delete submits the permanent command immediately, including to the durable outbox when
 * offline. Its persistence must not depend on a toast or the lifetime of this window.
 * Unpinning offers Undo too, back to the place the thread had. Moving to another project keeps
 * the pin, as the daemon does, and Undo moves it back. Bulk actions offer one Undo for all,
 * except delete. The Home context menu and the thread's ⋯ menu both use these, so
 * labels, toasts and Undo match wherever the person acts.
 */
export function useThreadActions(): ThreadActions {
  const overlay = useOrganizeOverlay();
  const client = useClient();
  const toast = useToast();
  const navigate = useNavigate();
  return useMemo(() => {
    const id = (entry: ThreadTarget) => ThreadId.parse(entry.id);
    /** Apply now, send, and say so if the daemon refuses. False after a refusal. */
    const act = (entry: ThreadTarget, action: Action) =>
      overlay
        .run(entry.id, action.patch, action.payload, `${action.verb} · ${entry.title}`, Date.now())
        .then(
          () => true,
          (error: unknown) => {
            toast.add({ title: `Couldn't ${action.failed}`, description: failureMessage(error) });
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
    ): Promise<boolean> => {
      const toastId = toast.add({
        title: done,
        ...waiting(),
        timeout: undoWindowMs,
        actionProps: {
          children: "Undo",
          onClick: () => {
            toast.close(toastId);
            for (const step of steps) void act(step.entry, step.undo);
          },
        },
      });
      return Promise.all(steps.map((step) => act(step.entry, step.action))).then((results) => {
        const applied = results.some(Boolean);
        if (!applied) toast.close(toastId);
        return applied;
      });
    };
    /** Apply now with a toast offering Undo, which runs `undo`. */
    const reversible = (entry: ThreadTarget, action: Action, done: string, undo: Action) =>
      reversibleAll([{ entry, action, undo }], done);
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
    /** Unpinning, undone by pinning again in the place it had. */
    const unpinStep = (entry: ThreadTarget) => ({
      entry,
      action: unpin(entry),
      undo: pin(entry, entry.pinOrder),
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
        if (removed) toast.add({ title: done(removed) });
        const live = refused.filter((refusal) => refusal.live);
        for (const refusal of refused.filter((each) => !each.live))
          toast.add({
            title: force ? "Couldn't stop and delete the thread" : "Couldn't delete the thread",
            description: failureMessage(refusal.error),
          });
        const only = live.length === 1 ? live[0] : undefined;
        if (!live.length) return;
        const toastId = toast.add({
          title: only
            ? `Couldn't delete · ${only.entry.title}`
            : `Couldn't delete ${count(live.length)}`,
          description: only
            ? failureMessage(only.error)
            : "Their agents or terminals are still running.",
          actionProps: {
            children: "Stop and delete",
            onClick: () => {
              toast.close(toastId);
              removeAll(
                live.map((refusal) => refusal.entry),
                done,
                true,
              );
            },
          },
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
      settle: (entry) =>
        void reversible(entry, settle(entry), `Settled · ${entry.title}`, unsettle(entry)),
      unsettle: (entry) =>
        void reversible(entry, unsettle(entry), `Back in the list · ${entry.title}`, settle(entry)),
      snooze: (entry, until, now) =>
        void reversible(
          entry,
          snooze(entry, until),
          `Snoozed until ${describeWake(until, now)}`,
          snooze(entry, entry.snoozedUntil ?? null),
        ),
      wake: (entry) => void act(entry, snooze(entry, null)),
      setPinned: (entry, pinned) =>
        void (pinned
          ? act(entry, pin(entry))
          : reversibleAll([unpinStep(entry)], `Unpinned · ${entry.title}`)),
      placePinned: (placements) => {
        for (const { entry, order } of placements) void act(entry, pin(entry, order));
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
        void reversibleAll(changing.map(unpinStep), `Unpinned ${count(changing.length)}`);
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
        void reversible(
          entry,
          rename(entry, trimmed),
          `Renamed · ${trimmed}`,
          rename({ ...entry, title: trimmed }, entry.title),
        ).then((renamed) => {
          // The rename field opens again with what the person typed.
          if (!renamed) overlay.refuseTitle(entry.id, title);
        });
      },
      archive: (entry) =>
        void reversible(entry, archive(entry), `Archived · ${entry.title}`, unarchive(entry)),
      restore: (entry) =>
        void reversible(entry, restore(entry), `Restored · ${entry.title}`, archive(entry)),
      deleteArchived: (entry) => removeAll([entry], () => `Deleted · ${entry.title}`),
      remove: (entry) => removeAll([entry], () => `Deleted · ${entry.title}`),
      newThreadOnMain: (entry) =>
        void navigate({ to: "/new", search: { project: entry.workspaceId, base: "main" } }),
      copyLink: (entry) => {
        const link = new URL(`/t/${entry.id}`, location.href).href;
        const copied =
          navigator.clipboard?.writeText(link) ?? Promise.reject(new Error("no clipboard"));
        void copied.then(
          () => toast.add({ title: "Link copied" }),
          () => toast.add({ title: "Couldn't copy the link" }),
        );
      },
    };
  }, [overlay, client, toast, navigate]);
}
