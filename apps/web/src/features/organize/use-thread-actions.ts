import { useClient } from "@ace/client-react";
import type { CommandPayload } from "@ace/protocol";
import { ThreadId } from "@ace/protocol";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { failureMessage, waitingNote } from "@/lib/daemon-command.ts";
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
}

export interface ThreadActions {
  settle(entry: ThreadTarget): void;
  unsettle(entry: ThreadTarget): void;
  snooze(entry: ThreadTarget, until: number, now: number): void;
  wake(entry: ThreadTarget): void;
  setPinned(entry: ThreadTarget, pinned: boolean): void;
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
 * Delete submits the permanent command immediately, including to the durable outbox when
 * offline. Its persistence must not depend on a toast or the lifetime of this window.
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
    /** Apply now with a toast offering Undo, which runs `undo`. */
    const reversible = (
      entry: ThreadTarget,
      action: Action,
      done: string,
      undo: Action,
    ): Promise<boolean> => {
      const toastId = toast.add({
        title: done,
        ...waiting(),
        timeout: undoWindowMs,
        actionProps: {
          children: "Undo",
          onClick: () => {
            toast.close(toastId);
            void act(entry, undo);
          },
        },
      });
      return act(entry, action).then((applied) => {
        if (!applied) toast.close(toastId);
        return applied;
      });
    };
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
        void act(entry, {
          patch: { pinned },
          payload: { type: "thread.pin", threadId: id(entry), pinned },
          verb: pinned ? "Pin" : "Unpin",
          failed: pinned ? "pin the thread" : "unpin the thread",
        }),
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
      deleteArchived: (entry) =>
        void act(entry, {
          patch: { deleted: true },
          payload: { type: "thread.delete", threadId: id(entry) },
          verb: "Delete",
          failed: "delete the thread",
        }).then((deleted) => {
          if (deleted) toast.add({ title: `Deleted · ${entry.title}` });
        }),
      remove: (entry) => {
        void act(entry, {
          patch: { deleted: true },
          payload: { type: "thread.delete", threadId: id(entry) },
          verb: "Delete",
          failed: "delete the thread",
        }).then((deleted) => {
          if (deleted) toast.add({ title: `Deleted · ${entry.title}` });
        });
      },
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
