import { provenAdoptions, type ZombieChild } from "./process-reaper.ts";
import { captureTree, liveMembers, type TreeIo, type TreeMember } from "./process-tree.ts";

/*
 * While the daemon owns process groups, a snapshot of their trees every few seconds: pid,
 * start, parent and group. A process seen while its parent lived stays known after that
 * parent exits and the kernel hands it to init, so a shutdown still finds it. On macOS there
 * is no subreaper, so this is how a tree's orphans are kept; on Linux it also proves which of
 * the daemon's zombie children were adopted, so they can be reaped.
 *
 * The work follows the owned trees, never the machine, and stops while nothing is owned and no
 * escaped process is known. Known members are capped: past the cap new ones aren't learned.
 */

/** Between snapshots. An orphan made and orphaned again inside one is not seen. */
export const watchIntervalMs = 3_000;
const knownLimit = 4_096;

type Known = { start: string; parent: number; group: number };

export interface WatchJournal {
  /** Remember members that left their group or tree, for the next start's sweep. */
  record(members: readonly TreeMember[]): void;
  forget(members: readonly TreeMember[]): void;
}

export interface WatchIo {
  tree: TreeIo;
  /** The leaders of the process groups owned now. */
  leaders(): number[];
  /** Runs `run` once after `milliseconds`; returns its cancel. */
  schedule(run: () => void, milliseconds: number): () => void;
  journal?: WatchJournal;
  /** Linux, where the daemon is a subreaper: its pid and group, its zombie children, a reap. */
  reaper?: {
    self: { pid: number; group: number };
    zombies(): ZombieChild[];
    reap(pid: number): boolean;
  };
  report?(error: unknown): void;
  /** How many processes the watch remembers at most (4,096 unless a test sets fewer). */
  knownLimit?: number;
}

export class ProcessWatch {
  private readonly io: WatchIo;
  private readonly known = new Map<number, Known>();
  /** What the journal holds, so a tick writes only what changed. */
  private readonly journaled = new Map<number, string>();
  private cancel: (() => void) | undefined;
  private closed = false;
  private truncationReported = false;
  constructor(io: WatchIo) {
    this.io = io;
  }

  /** A group became owned: watch until nothing is left to watch. */
  wake(): void {
    if (this.closed || this.cancel) return;
    this.cancel = this.io.schedule(() => this.run(), watchIntervalMs);
  }

  private run(): void {
    this.cancel = undefined;
    let busy = false;
    try {
      busy = this.tick();
    } catch (error) {
      this.io.report?.(error);
      busy = true;
    }
    if (busy) this.wake();
  }

  /** One snapshot. Returns whether anything is still worth watching. */
  tick(): boolean {
    const leaders = this.io.leaders();
    const groups = new Set(leaders);
    const seen = new Set<number>();
    const capture = captureTree(leaders, this.io.tree);
    if (capture.truncated && !this.truncationReported) {
      this.truncationReported = true;
      this.io.report?.(new Error("The owned process trees outgrew one snapshot; some are unseen"));
    }
    for (const member of capture.members) {
      seen.add(member.pid);
      const before = this.known.get(member.pid);
      // A reused pid is a new process: what was known about the old one no longer holds.
      if (before && before.start !== member.start) this.known.delete(member.pid);
      if (!this.known.has(member.pid) && this.known.size >= (this.io.knownLimit ?? knownLimit))
        continue;
      this.known.set(member.pid, {
        start: member.start,
        // The first parent seen is the proof of adoption later.
        parent: before?.start === member.start ? before.parent : member.parent,
        group: member.group,
      });
    }
    // Prune first, by pid AND start: an entry stays only while that same process exists,
    // running or as a zombie waiting to be reaped. Only then does any evidence move to a zombie.
    const zombies = this.io.reaper?.zombies() ?? [];
    const dead = new Map(zombies.map((zombie) => [zombie.pid, zombie.start]));
    const keep: TreeMember[] = [];
    for (const [pid, known] of this.known) {
      const member = { pid, start: known.start };
      if (liveMembers([member], this.io.tree).length) {
        // Outside every owned tree now, or outside every owned group: a group stop misses it.
        if (!seen.has(pid) || !groups.has(known.group)) keep.push(member);
      } else if (dead.get(pid) !== known.start) this.known.delete(pid);
    }
    this.reapAdopted(zombies, groups);
    this.journal(keep);
    return leaders.length > 0 || keep.length > 0;
  }

  /** Every known process that is still running, whatever its parent is now. */
  members(): TreeMember[] {
    const members = [...this.known].map(([pid, known]) => ({ pid, start: known.start }));
    return liveMembers(members, this.io.tree);
  }

  private journal(keep: readonly TreeMember[]): void {
    const journal = this.io.journal;
    if (!journal) return;
    const wanted = new Map(keep.map((member) => [member.pid, member.start]));
    const added = keep.filter((member) => this.journaled.get(member.pid) !== member.start);
    const gone = [...this.journaled]
      .filter(([pid, start]) => wanted.get(pid) !== start)
      .map(([pid, start]) => ({ pid, start }));
    try {
      if (gone.length) journal.forget(gone);
      if (added.length) journal.record(added);
      for (const member of gone) this.journaled.delete(member.pid);
      for (const member of added) this.journaled.set(member.pid, member.start);
    } catch (error) {
      // Retried next tick: nothing was marked written.
      this.io.report?.(error);
    }
  }

  private reapAdopted(zombies: readonly ZombieChild[], owned: ReadonlySet<number>): void {
    const reaper = this.io.reaper;
    if (!reaper || !zombies.length) return;
    for (const pid of provenAdoptions(zombies, reaper.self, owned, this.known))
      if (reaper.reap(pid)) this.known.delete(pid);
  }

  close(): void {
    this.closed = true;
    this.cancel?.();
    this.cancel = undefined;
  }
}
