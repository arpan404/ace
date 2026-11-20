import type { ProcessListing } from "./process-listing.ts";
import type { TreeMember } from "./process-tree.ts";

/*
 * macOS lineage by unique id. Every process has a kernel unique id that is never reused, and
 * the kernel keeps the unique id of the process that started it even after the process is
 * orphaned to launchd (checked on macOS 27.0.1). So a process started by one of this run's
 * processes can be found later even if it was never seen while its parent lived, runs an Apple
 * binary and hides its environment: its starting parent's unique id is one this run recorded.
 *
 * The run records the unique ids of the processes it owns as each one starts (provider and
 * probe leaders), and of every process its snapshots see. What none of that reaches: a process
 * whose starting parent was itself never recorded (it started and exited between snapshots
 * without being a leader). Linux has no unique ids; there the daemon is a subreaper instead.
 */

/** The most unique ids one run keeps. Past it, lineage can't be proven complete. */
export const lineageLimit = 65_536;

export interface LineageJournal {
  recordLineage(uniques: readonly string[]): void;
}

/** The unique ids of this run's processes. */
export class LineageBook {
  private readonly ids = new Set<string>();
  private readonly limit: number;
  private readonly journal: LineageJournal | undefined;
  private overflowed = false;
  constructor(options: { limit?: number; journal?: LineageJournal } = {}) {
    this.limit = options.limit ?? lineageLimit;
    this.journal = options.journal;
  }
  /** Record a process's unique id; one beyond the limit marks the book incomplete. */
  note(unique: string | undefined): void {
    if (unique === undefined || this.ids.has(unique)) return;
    if (this.ids.size >= this.limit) {
      this.overflowed = true;
      return;
    }
    this.ids.add(unique);
    this.journal?.recordLineage([unique]);
  }
  /** Record a live process by pid: its unique id, read now. */
  noteProcess(pid: number, listing: ProcessListing): void {
    this.note(listing.ancestry?.(pid)?.unique);
  }
  roots(): ReadonlySet<string> {
    return this.ids;
  }
  /** Whether every id it was given is kept. */
  complete(): boolean {
    return !this.overflowed;
  }
}

/**
 * Every live process whose chain of starting parents, by unique id, reaches `roots`. One pass
 * over every visible process; each is read as identity, ancestry, identity, so a pid reused
 * during the read is left out. Undefined where the platform keeps no lineage (not macOS).
 */
export function lineageDescendants(
  roots: Iterable<string>,
  listing: ProcessListing,
): TreeMember[] | undefined {
  const ancestry = listing.ancestry;
  if (!ancestry) return undefined;
  const byParent = new Map<string, { member: TreeMember; unique: string }[]>();
  for (const pid of listing.all()) {
    const before = listing.info(pid);
    if (!before || before.zombie) continue;
    const ids = ancestry(pid);
    const after = listing.info(pid);
    if (!ids || !after || after.zombie || after.start !== before.start) continue;
    const entry = { member: { pid, start: before.start }, unique: ids.unique };
    const siblings = byParent.get(ids.parentUnique);
    if (siblings) siblings.push(entry);
    else byParent.set(ids.parentUnique, [entry]);
  }
  const found: TreeMember[] = [];
  const seen = new Set<string>(roots);
  const queue = [...seen];
  for (let next = queue.shift(); next !== undefined; next = queue.shift())
    for (const child of byParent.get(next) ?? []) {
      if (seen.has(child.unique)) continue;
      seen.add(child.unique);
      found.push(child.member);
      queue.push(child.unique);
    }
  return found;
}
