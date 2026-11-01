import { z } from "zod";
import { firstLaunch } from "./first-launch.ts";
import { readJson, writeJson, type KeyValueStorage } from "./storage.ts";

/*
 * How this device shows the Home list. Settle, snooze, pin, read state, titles and deletion
 * belong to the daemon (ADR 0057) and arrive on each thread list entry; what stays here is
 * view state: the unread baseline of a first launch, the project and device filters, and which
 * of the Threads panel's tabs (Inbox, Snoozed, Settled) is open.
 */

/** The daemon's auto-settle window (`threads.autoSettleAfter`). */
export const AutoSettle = z.enum(["1d", "2d", "1w", "never"]);
export type AutoSettle = z.infer<typeof AutoSettle>;

/** The Threads panel's three places (`threadsPanel`). */
export const ThreadsTab = z.enum(["inbox", "snoozed", "settled"]);
export type ThreadsTab = z.infer<typeof ThreadsTab>;

const Stored = z.object({
  /** Activity before this moment counts as seen, so a first launch isn't all unread. */
  baseline: z.number(),
  /** Home list project filter; null is every project. */
  project: z.string().nullable().catch(null),
  /** Home list device filter; absent is every device. */
  device: z.string().optional().catch(undefined),
  /** The Chats panel's own device filter, apart from Threads'; absent is every device. */
  chatDevice: z.string().optional().catch(undefined),
  /** The Threads panel's open tab. */
  tab: ThreadsTab.catch("inbox"),
});
type Stored = z.infer<typeof Stored>;

export type OrganizerState = Stored;

const storageKey = "ace.home.organizer";

/** A small external store: React reads it with `useSyncExternalStore`. */
export class Organizer {
  private state: OrganizerState;
  private listeners = new Set<() => void>();
  private storage: KeyValueStorage | undefined;
  constructor(storage: KeyValueStorage | undefined, now: number) {
    this.storage = storage;
    // The first launch may already have been recorded before the rest of this.
    const fresh: Stored = {
      baseline: firstLaunch(storage, now),
      project: null,
      tab: "inbox",
    };
    const stored = readJson(storage, storageKey, Stored, fresh);
    this.state = stored;
    if (stored === fresh) this.persist();
  }
  getState = (): OrganizerState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  setProject(project: string | null): void {
    this.set({ project });
  }
  setDevice(device: string | undefined): void {
    // Projects belong to a device, so a device switch clears the previous project's filter.
    this.set({ device, project: null });
  }
  /** Narrow the Chats panel to one device (undefined: every device). */
  setChatDevice(chatDevice: string | undefined): void {
    this.set({ chatDevice });
  }
  /** Open one of the Threads panel's tabs. */
  setTab(tab: ThreadsTab): void {
    if (tab !== this.state.tab) this.set({ tab });
  }
  private set(patch: Partial<Stored>): void {
    this.state = { ...this.state, ...patch };
    this.persist();
    this.emit();
  }
  private persist(): void {
    const { baseline, project, device, chatDevice, tab } = this.state;
    writeJson(this.storage, storageKey, {
      baseline,
      project,
      device,
      chatDevice,
      tab,
    } satisfies Stored);
  }
  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
