import type { ClientApi } from "@ace/client";
import type { useNavigate, useRouter } from "@tanstack/react-router";
import type { useToast } from "@/components/ui/toast.tsx";
import type { useArchiveConfirmation, useDeleteConfirmation } from "./delete-confirmation.ts";
import type { OrganizeOverlay } from "./overlay.ts";

/** What an action needs of a thread: a Home list entry or the open thread's meta. */
export interface ThreadTarget {
  id: string;
  title: string;
  workspaceId: string;
  snoozedUntil?: number | null | undefined;
  /** What its current snooze waits for, so Undo puts it back as it was. */
  snoozeWake?: { on: SnoozeWakeOn } | undefined;
  pinned?: boolean | undefined;
  /** Its place among pinned threads, so Undo puts an unpinned thread back where it was. */
  pinOrder?: number | undefined;
  /** False when the thread never settles by itself. */
  autoSettle?: false | undefined;
}

/** The event a snooze waits for, besides its time: a request or finish, or a PR change. */
export type SnoozeWakeOn = "needs_you" | "pr";

/** A pinned thread's new place, from a drag or a keyboard move (`placePinned`). */
export interface PinPlacement {
  entry: ThreadTarget;
  order: number;
}

export interface ThreadActions {
  /** Settle, with a toast offering Undo, which takes back only the settle. */
  settle(entry: ThreadTarget): void;
  /** Unsettle, which also keeps it from settling by itself again. */
  unsettle(entry: ThreadTarget): void;
  /** Let the thread settle by itself again, or keep it until settled by hand. */
  setAutoSettle(entry: ThreadTarget, enabled: boolean): void;
  /**
   * Snooze until `until`, or sooner on `wake`'s event (then `until` is only a backstop), with a
   * toast offering Undo. `label` says how ("until it needs you", "until tomorrow 9:00 AM").
   */
  snooze(entry: ThreadTarget, until: number, wake?: SnoozeWakeOn, label?: string): void;
  wake(entry: ThreadTarget): void;
  /** Pin (leading the group) or unpin. */
  setPinned(entry: ThreadTarget, pinned: boolean): void;
  /** Pin each thread at its new place: a drop into the Pinned group or a move within it. */
  placePinned(placements: readonly PinPlacement[]): void;
  /** Put each thread at its new place in the hand-sorted Home list. */
  placeListed(placements: readonly PinPlacement[]): void;
  /** Pin (leading the group, in list order) or unpin several at once. */
  setPinnedMany(entries: readonly ThreadTarget[], pinned: boolean): void;
  /**
   * Archive several threads at once, with one Undo. When any left commands running, which
   * archiving stops, it asks first; `archived` runs once the archive goes ahead (not on Cancel).
   */
  archiveMany(entries: readonly ThreadTarget[], archived?: () => void): void;
  /** Archive several threads at once, with one Undo, without asking: the caller asked. */
  archiveManyNow(entries: readonly ThreadTarget[]): void;
  /** How many commands each thread left running, which archiving it would stop. */
  leftRunning(entries: readonly ThreadTarget[]): { title: string; leftRunning: number }[];
  /** Delete several threads at once, for good: no Undo, so ask first. */
  removeMany(entries: readonly ThreadTarget[]): void;
  /** Move threads to another project, with one Undo back to where each was. */
  moveMany(entries: readonly ThreadTarget[], to: { id: string; name: string }): void;
  setUnread(entry: ThreadTarget, unread: boolean): void;
  rename(entry: ThreadTarget, title: string): void;
  /**
   * Archive with Undo, which opens the thread again. A thread still working or waiting on the
   * person asks first: stop it too, or keep it running. A done thread that left commands
   * running asks too, since archiving stops them. `leave` runs once it is archived.
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

/** What the actions of one machine run with: its client and overlay, and the window's dialogs. */
export interface ThreadActionsDeps {
  overlay: OrganizeOverlay;
  confirmation: ReturnType<typeof useDeleteConfirmation>;
  archiving: ReturnType<typeof useArchiveConfirmation>;
  client: ClientApi;
  toast: ReturnType<typeof useToast>;
  navigate: ReturnType<typeof useNavigate>;
  router: ReturnType<typeof useRouter>;
  /** `?machine=` for the threads' own links, empty on this window's daemon (ADR 0102). */
  machine: { machine?: string };
}
