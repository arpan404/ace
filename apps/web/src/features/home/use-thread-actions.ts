import { useClient } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import type { ThreadMark } from "./organizer.ts";
import { describeWake } from "./snooze.ts";
import { useOrganizer } from "./use-organizer.ts";

/** How long Undo stays on screen; an archive is sent to the daemon only after it. */
export const undoWindowMs = 6_000;

export interface ThreadActions {
  settle(entry: ThreadListEntry): void;
  unsettle(entry: ThreadListEntry): void;
  snooze(entry: ThreadListEntry, until: number, now: number): void;
  wake(entry: ThreadListEntry): void;
  setPinned(entry: ThreadListEntry, pinned: boolean): void;
  setUnread(entry: ThreadListEntry, unread: boolean): void;
  rename(entry: ThreadListEntry, title: string): void;
  archive(entry: ThreadListEntry): void;
  remove(entry: ThreadListEntry): void;
  newThreadOnMain(entry: ThreadListEntry): void;
}

/**
 * Every list action, each reversible from its toast. Undo restores the thread's previous
 * mark exactly, so actions never need their own inverse.
 */
export function useThreadActions(): ThreadActions {
  const organizer = useOrganizer();
  const client = useClient();
  const toast = useToast();
  const navigate = useNavigate();
  return useMemo(() => {
    const titleOf = (entry: ThreadListEntry) => organizer.mark(entry.id)?.title ?? entry.title;
    /** Apply a change and offer Undo back to the mark as it was. */
    const change = (
      entry: ThreadListEntry,
      next: (mark: ThreadMark) => ThreadMark,
      message?: string,
    ) => {
      const before = organizer.mark(entry.id) ?? {};
      organizer.update(entry.id, next);
      if (!message) return;
      const id = toast.add({
        title: message,
        timeout: undoWindowMs,
        actionProps: {
          children: "Undo",
          onClick: () => {
            organizer.update(entry.id, () => before);
            toast.close(id);
          },
        },
      });
    };
    return {
      settle: (entry) =>
        change(
          entry,
          (mark) => ({
            ...mark,
            settledAt: entry.updatedAt,
            unsettledAt: undefined,
            snoozedUntil: undefined,
          }),
          `Settled · ${titleOf(entry)}`,
        ),
      unsettle: (entry) =>
        change(
          entry,
          (mark) => ({ ...mark, settledAt: undefined, unsettledAt: entry.updatedAt }),
          `Back in the list · ${titleOf(entry)}`,
        ),
      snooze: (entry, until, now) =>
        change(
          entry,
          (mark) => ({ ...mark, snoozedUntil: until }),
          `Snoozed until ${describeWake(until, now)}`,
        ),
      wake: (entry) => change(entry, (mark) => ({ ...mark, snoozedUntil: undefined })),
      setPinned: (entry, pinned) => change(entry, (mark) => ({ ...mark, pinned })),
      setUnread: (entry, unread) =>
        change(entry, (mark) =>
          unread ? { ...mark, unread: true } : { ...mark, unread: false, seenAt: entry.updatedAt },
        ),
      rename: (entry, title) => {
        const trimmed = title.trim();
        if (!trimmed || trimmed === titleOf(entry)) return;
        change(
          entry,
          (mark) => ({ ...mark, title: trimmed === entry.title ? undefined : trimmed }),
          `Renamed · ${trimmed}`,
        );
      },
      archive: (entry) => {
        let undone = false;
        organizer.setArchiving(entry.id, true);
        const id = toast.add({
          title: `Archived · ${titleOf(entry)}`,
          timeout: undoWindowMs,
          actionProps: {
            children: "Undo",
            onClick: () => {
              undone = true;
              organizer.setArchiving(entry.id, false);
              toast.close(id);
            },
          },
          // The daemon has no unarchive, so the command waits out the undo window.
          onClose: () => {
            if (!undone) void client.enqueue({ type: "thread.archive", threadId: entry.id });
          },
        });
      },
      remove: (entry) =>
        change(entry, (mark) => ({ ...mark, deleted: true }), `Deleted · ${titleOf(entry)}`),
      newThreadOnMain: (entry) =>
        void navigate({ to: "/new", search: { project: entry.workspaceId, base: "main" } }),
    };
  }, [organizer, client, toast, navigate]);
}
