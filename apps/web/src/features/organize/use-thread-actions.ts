import { useClient } from "@ace/client-react";
import type { CommandPayload } from "@ace/protocol";
import { ThreadId } from "@ace/protocol";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { failureMessage, waitingNote } from "@/lib/daemon-command.ts";
import { describeWake, type OrganizePatch } from "@ace/ui-core";
import { useOrganizeOverlay } from "./overlay.ts";

/** How long Undo stays on screen; a delete becomes permanent only after it. */
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
  /** Delete several threads at once, with one Undo (see `remove`). */
  removeMany(entries: readonly ThreadTarget[]): void;
  setUnread(entry: ThreadTarget, unread: boolean): void;
  rename(entry: ThreadTarget, title: string): void;
  archive(entry: ThreadTarget): void;
  remove(entry: ThreadTarget): void;
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
      | "thread.delete";
  }
>;

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
 * Delete is permanent on the daemon and there is no restore command, so it archives at once
 * (hidden on every device, and recoverable), Undo unarchives, and the delete itself is sent
 * when the Undo toast closes. A window closed in between leaves the thread archived, never
 * half deleted. Unpinning offers Undo too, back to the place the thread had. The Home context menu and the thread's ⋯ menu both use these, so labels,
 * toasts and Undo match wherever the person acts.
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
    const count = (entries: readonly unknown[]) =>
      entries.length === 1 ? "1 thread" : `${entries.length} threads`;
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
    /** Undoing a delete, or taking back one the daemon refused. */
    const restore = (entry: ThreadTarget): Action => ({
      ...unarchive(entry),
      verb: "Restore",
      failed: "restore it",
    });
    /**
     * Delete is permanent on the daemon and there is no restore command, so it archives at
     * once (hidden on every device, and recoverable), Undo unarchives, and the delete itself is
     * sent when the Undo toast closes.
     */
    const removeAll = (entries: readonly ThreadTarget[], done: string) => {
      let undone = false;
      const toastId = toast.add({
        title: done,
        ...waiting(),
        timeout: undoWindowMs,
        actionProps: {
          children: "Undo",
          onClick: () => {
            undone = true;
            toast.close(toastId);
            for (const entry of entries) void act(entry, restore(entry));
          },
        },
        onClose: () => {
          if (undone) return;
          for (const entry of entries)
            void act(entry, {
              patch: { deleted: true },
              payload: { type: "thread.delete", threadId: id(entry) },
              verb: "Delete",
              failed: "delete the thread",
            }).then((deleted) => {
              // Refused (its agents still work, say): bring it back rather than leave it hidden.
              if (!deleted) void act(entry, restore(entry));
            });
        },
      });
      void Promise.all(
        entries.map((entry) =>
          act(entry, { ...archive(entry), verb: "Delete", failed: "delete the thread" }),
        ),
      ).then((hidden) => {
        if (hidden.some(Boolean)) return;
        undone = true;
        toast.close(toastId);
      });
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
        void reversibleAll(changing.map(unpinStep), `Unpinned ${count(changing)}`);
      },
      archiveMany: (entries) =>
        void reversibleAll(
          entries.map((entry) => ({ entry, action: archive(entry), undo: unarchive(entry) })),
          `Archived ${count(entries)}`,
        ),
      removeMany: (entries) => removeAll(entries, `Deleted ${count(entries)}`),
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
      remove: (entry) => removeAll([entry], `Deleted · ${entry.title}`),
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
