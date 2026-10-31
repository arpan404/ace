import { z } from "zod";
import { firstLaunch } from "./first-launch.ts";
import { readJson, writeJson, type KeyValueStorage } from "./storage.ts";

/*
 * How this device shows the Home list. Settle, snooze, pin, read state, titles and deletion
 * belong to the daemon (ADR 0057) and arrive on each thread list entry; what stays here is
 * view state: the unread baseline of a first launch, the project filter, and which of the
 * Threads panel's places, projects and disclosures are folded or open.
 */

/** The daemon's auto-settle window (`threads.autoSettleAfter`). */
export const AutoSettle = z.enum(["1d", "2d", "1w", "never"]);
export type AutoSettle = z.infer<typeof AutoSettle>;

const Stored = z.object({
  /** Activity before this moment counts as seen, so a first launch isn't all unread. */
  baseline: z.number(),
  /** Home list project filter; null is every project. */
  project: z.string().nullable().catch(null),
  /** Home list device filter; absent is every device. */
  device: z.string().optional().catch(undefined),
  snoozedOpen: z.boolean().catch(false),
  /** The Inbox and projects the person folded (`inboxFold`, `projectFold`). */
  collapsed: z.array(z.string().max(4200)).max(500).catch([]),
  /** Projects whose "N settled" is open in the tree. */
  settledOpen: z.array(z.string().max(4096)).max(100).catch([]),
  /** Quiet projects (only settled threads) shown at the foot of Projects. */
  quietOpen: z.boolean().catch(false),
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
      snoozedOpen: false,
      collapsed: [],
      settledOpen: [],
      quietOpen: false,
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
  setSnoozedOpen(snoozedOpen: boolean): void {
    this.set({ snoozedOpen });
  }
  /** Fold or unfold the Inbox or a project (`inboxFold`, `projectFold`). */
  setFolded(key: string, folded: boolean): void {
    const rest = this.state.collapsed.filter((each) => each !== key);
    this.set({ collapsed: folded ? [...rest, key] : rest });
  }
  /** Show or hide a project's settled threads in the tree. */
  setSettledOpen(project: string, open: boolean): void {
    const rest = this.state.settledOpen.filter((each) => each !== project);
    this.set({ settledOpen: open ? [...rest, project] : rest });
  }
  setQuietOpen(quietOpen: boolean): void {
    this.set({ quietOpen });
  }
  private set(patch: Partial<Stored>): void {
    this.state = { ...this.state, ...patch };
    this.persist();
    this.emit();
  }
  private persist(): void {
    const { baseline, project, device, snoozedOpen, collapsed, settledOpen, quietOpen } =
      this.state;
    writeJson(this.storage, storageKey, {
      baseline,
      project,
      device,
      snoozedOpen,
      collapsed,
      settledOpen,
      quietOpen,
    } satisfies Stored);
  }
  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
