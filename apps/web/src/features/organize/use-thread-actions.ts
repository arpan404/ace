import { useClient } from "@ace/client-react";
import type { CommandPayload, ThreadListEntry } from "@ace/protocol";
import { ThreadId } from "@ace/protocol";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { failureMessage, runCommand } from "@/lib/daemon-command.ts";
import { describeWake } from "@ace/ui-core";
import { useOrganizer } from "./use-organizer.ts";

/** How long Undo stays on screen; a delete is sent to the daemon only after it. */
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

/**
 * Every list action as a daemon command (ADR 0057), so the organization follows the person to
 * every device. Each reports a refusal in a toast; the reversible ones offer Undo, which sends
 * the opposite command. Delete is permanent on the daemon, so it waits out the Undo window
 * first, with the thread hidden meanwhile.
 */
export function useThreadActions(): ThreadActions {
  const organizer = useOrganizer();
  const client = useClient();
  const toast = useToast();
  const navigate = useNavigate();
  return useMemo(() => {
    const id = (entry: ThreadListEntry) => ThreadId.parse(entry.id);
    const send = (payload: Organize, failed: string) =>
      runCommand(client, payload).then(
        () => true,
        (error: unknown) => {
          toast.add({ title: `Couldn't ${failed}`, description: failureMessage(error) });
          return false;
        },
      );
    /** Run, then offer Undo with the opposite command. */
    const reversible = async (payload: Organize, failed: string, done: string, undo: Organize) => {
      if (!(await send(payload, failed))) return;
      const toastId = toast.add({
        title: done,
        timeout: undoWindowMs,
        actionProps: {
          children: "Undo",
          onClick: () => {
            toast.close(toastId);
            void send(undo, "undo that");
          },
        },
      });
    };
    return {
      settle: (entry) =>
        void reversible(
          { type: "thread.settle", threadId: id(entry) },
          "settle the thread",
          `Settled · ${entry.title}`,
          { type: "thread.unsettle", threadId: id(entry) },
        ),
      unsettle: (entry) =>
        void reversible(
          { type: "thread.unsettle", threadId: id(entry) },
          "unsettle the thread",
          `Back in the list · ${entry.title}`,
          { type: "thread.settle", threadId: id(entry) },
        ),
      snooze: (entry, until, now) =>
        void reversible(
          { type: "thread.snooze", threadId: id(entry), until },
          "snooze the thread",
          `Snoozed until ${describeWake(until, now)}`,
          { type: "thread.snooze", threadId: id(entry), until: entry.snoozedUntil ?? null },
        ),
      wake: (entry) =>
        void send({ type: "thread.snooze", threadId: id(entry), until: null }, "wake the thread"),
      setPinned: (entry, pinned) =>
        void send(
          { type: "thread.pin", threadId: id(entry), pinned },
          pinned ? "pin the thread" : "unpin the thread",
        ),
      setUnread: (entry, unread) =>
        void send(
          { type: "thread.read", threadId: id(entry), unread },
          unread ? "mark the thread unread" : "mark the thread read",
        ),
      rename: (entry, title) => {
        const trimmed = title.trim();
        if (!trimmed || trimmed === entry.title) return;
        void reversible(
          { type: "thread.rename", threadId: id(entry), title: trimmed },
          "rename the thread",
          `Renamed · ${trimmed}`,
          { type: "thread.rename", threadId: id(entry), title: entry.title },
        );
      },
      archive: (entry) => {
        // Hidden at once; the daemon's archivedAt keeps it hidden once it arrives.
        organizer.setHiding(entry.id, true);
        void send({ type: "thread.archive", threadId: id(entry) }, "archive the thread").then(
          (archived) => {
            if (!archived) return organizer.setHiding(entry.id, false);
            const toastId = toast.add({
              title: `Archived · ${entry.title}`,
              timeout: undoWindowMs,
              actionProps: {
                children: "Undo",
                onClick: () => {
                  toast.close(toastId);
                  organizer.setHiding(entry.id, false);
                  void send({ type: "thread.unarchive", threadId: id(entry) }, "unarchive it");
                },
              },
            });
          },
        );
      },
      remove: (entry) => {
        let undone = false;
        organizer.setHiding(entry.id, true);
        const toastId = toast.add({
          title: `Deleted · ${entry.title}`,
          timeout: undoWindowMs,
          actionProps: {
            children: "Undo",
            onClick: () => {
              undone = true;
              organizer.setHiding(entry.id, false);
              toast.close(toastId);
            },
          },
          onClose: () => {
            if (undone) return;
            void send({ type: "thread.delete", threadId: id(entry) }, "delete the thread").then(
              (deleted) => deleted || organizer.setHiding(entry.id, false),
            );
          },
        });
      },
      newThreadOnMain: (entry) =>
        void navigate({ to: "/new", search: { project: entry.workspaceId, base: "main" } }),
    };
  }, [organizer, client, toast, navigate]);
}
