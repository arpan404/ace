import { z } from "zod";
import { readJson, writeJson, type KeyValueStorage } from "./storage.ts";

/*
 * TODO(train-2): wire to protocol when merged. Settle, snooze, pin, read state, rename and
 * delete have no daemon commands on main yet, so the person's list organisation lives on this
 * device. Everything goes through `Organizer`; moving it to the daemon changes this file.
 */

/** How one person has organised one thread. Times are the thread's `updatedAt` at the action. */
export const ThreadMark = z.object({
  /** Settled while the thread was at this `updatedAt`; newer activity brings it back. */
  settledAt: z.number().optional(),
  /** Unsettled at this `updatedAt`; auto-settle waits for newer activity. */
  unsettledAt: z.number().optional(),
  snoozedUntil: z.number().optional(),
  pinned: z.boolean().optional(),
  /** Marked unread by hand. */
  unread: z.boolean().optional(),
  /** Last `updatedAt` the person saw. */
  seenAt: z.number().optional(),
  /** Local title until rename reaches the daemon. */
  title: z.string().min(1).max(200).optional(),
  deleted: z.boolean().optional(),
});
export type ThreadMark = z.infer<typeof ThreadMark>;

export const AutoSettle = z.enum(["never", "1d", "3d", "1w"]);
export type AutoSettle = z.infer<typeof AutoSettle>;

const Stored = z.object({
  /** Activity before this moment counts as seen, so a first launch isn't all unread. */
  baseline: z.number(),
  autoSettle: AutoSettle.catch("1d"),
  /** Home list project filter; null is every project. */
  project: z.string().nullable().catch(null),
  settledOpen: z.boolean().catch(false),
  marks: z.record(z.string(), ThreadMark).catch({}),
});
type Stored = z.infer<typeof Stored>;

export interface OrganizerState extends Stored {
  /** Threads whose archive is waiting out its undo window. Not persisted. */
  archiving: ReadonlySet<string>;
}

const storageKey = "ace.home.organizer";
const markLimit = 5_000;

/** A small external store: React reads it with `useSyncExternalStore`. */
export class Organizer {
  private state: OrganizerState;
  private listeners = new Set<() => void>();
  private storage: KeyValueStorage | undefined;
  constructor(storage: KeyValueStorage | undefined, now: number) {
    this.storage = storage;
    const fresh: Stored = {
      baseline: now,
      autoSettle: "1d",
      project: null,
      settledOpen: false,
      marks: {},
    };
    const stored = readJson(storage, storageKey, Stored, fresh);
    this.state = { ...stored, archiving: new Set() };
    if (stored === fresh) this.persist();
  }
  getState = (): OrganizerState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  mark(threadId: string): ThreadMark | undefined {
    return Object.hasOwn(this.state.marks, threadId) ? this.state.marks[threadId] : undefined;
  }
  /** Replace one thread's mark. Fields set to undefined are dropped. */
  update(threadId: string, change: (mark: ThreadMark) => ThreadMark): void {
    const next = compact(change(this.mark(threadId) ?? {}));
    const marks = { ...this.state.marks };
    if (Object.keys(next).length) marks[threadId] = next;
    else delete marks[threadId];
    this.set({ marks: bounded(marks) });
  }
  setAutoSettle(autoSettle: AutoSettle): void {
    this.set({ autoSettle });
  }
  setProject(project: string | null): void {
    this.set({ project });
  }
  setSettledOpen(settledOpen: boolean): void {
    this.set({ settledOpen });
  }
  setArchiving(threadId: string, pending: boolean): void {
    const archiving = new Set(this.state.archiving);
    if (pending) archiving.add(threadId);
    else archiving.delete(threadId);
    this.state = { ...this.state, archiving };
    this.emit();
  }
  private set(patch: Partial<Stored>): void {
    this.state = { ...this.state, ...patch };
    this.persist();
    this.emit();
  }
  private persist(): void {
    const { baseline, autoSettle, project, settledOpen, marks } = this.state;
    const stored: Stored = { baseline, autoSettle, project, settledOpen, marks };
    writeJson(this.storage, storageKey, stored);
  }
  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function compact(mark: ThreadMark): ThreadMark {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mark))
    if (value !== undefined && value !== false) out[key] = value;
  return ThreadMark.parse(out);
}

/** Keep storage bounded: drop the oldest-inserted marks past the limit. */
function bounded(marks: Record<string, ThreadMark>): Record<string, ThreadMark> {
  const keys = Object.keys(marks);
  if (keys.length <= markLimit) return marks;
  const kept: Record<string, ThreadMark> = {};
  for (const key of keys.slice(keys.length - markLimit)) {
    const mark = marks[key];
    if (mark) kept[key] = mark;
  }
  return kept;
}
