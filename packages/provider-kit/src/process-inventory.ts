import { childHasExited } from "./child-exit.ts";
import { existsSync } from "node:fs";
import { z } from "zod";
import { DatabaseSync } from "./sqlite.ts";
import { processIdentity, processGroupIsGone, type ProcessIdentity } from "./process-identity.ts";
import { WindowsSid, windowsTreeRuntime, type WindowsTreeRuntime } from "./process-identity.ts";
import type { WindowsProcessRecord } from "./process-identity.ts";
import { guardedTick, inventoryRetryMs } from "./inventory-retry.ts";
export interface ProcessJournal {
  add(pid: number, metadata: { name: string; cwd?: string }): void;
  remove(pid: number): void;
}
const Entry = z.object({
  pid: z.number().int().positive(),
  start: z.string(),
  uid: z.number().int().nonnegative(),
  group: z.number().int().positive(),
  ownerPid: z.number().int().positive(),
  ownerStart: z.string(),
  name: z.string().max(256),
  cwd: z.string().optional(),
  createdAt: z.number(),
});
/** Windows owners are SID strings. */
const WindowsEntry = Entry.extend({ uid: WindowsSid });
/** A descendant row names its tree as the leader's `pid:start`; a leader row has none. */
const WindowsTreeEntry = WindowsEntry.extend({ tree: z.string().max(64).optional() });
type WindowsTreeEntry = z.infer<typeof WindowsTreeEntry>;
export type ProcessEntry = z.infer<typeof Entry> | z.infer<typeof WindowsEntry>;
export interface InventoryRuntime {
  identity(pid: number): ProcessIdentity | undefined;
  alive(group: number): boolean;
  /** Non-consuming proof that an owned child has exited before Node has reaped it. */
  childExited?(pid: number): boolean;
  kill(group: number): void;
  ownerPid: number;
  now(): number;
  /** Windows only: a recorded tree is its leader plus live descendants, not a group. */
  windowsTree?: WindowsTreeRuntime;
  /** Windows only: runs the descendant recorder on an interval; returns its stop. */
  windowsEvery?: (run: () => void, milliseconds: number) => () => void;
  /** Runs `run` once after `milliseconds`; returns its cancel. Retries of failed deletes use it. */
  later?: (run: () => void, milliseconds: number) => () => void;
}
const NoSuchProcess = z.object({ code: z.literal("ESRCH") });
export const inventoryRuntime: InventoryRuntime = {
  identity: processIdentity,
  childExited: childHasExited,
  ownerPid: process.pid,
  now: Date.now,
  alive(group) {
    return !processGroupIsGone(group);
  },
  kill(group) {
    try {
      process.kill(-group, "SIGKILL");
    } catch (error) {
      if (!NoSuchProcess.safeParse(error).success) throw error;
    }
  },
};
/** Only kernel identities and non-secret labels persist; provider input never enters this journal. */
export class ProcessInventory implements ProcessJournal {
  private db: DatabaseSync;
  private runtime: InventoryRuntime;
  private report: (error: unknown) => void;
  /**
   * Exited processes whose rows could not be deleted yet (a full disk, a locked file). The exit
   * is already true, so a failed delete is retried, never thrown into the exit listener that
   * called it. A row left behind by a crash is harmless: recovery finds its group gone.
   */
  private unremoved = new Set<number>();
  /** The scheduled retry of `unremoved`, and how many retries in a row have failed. */
  private cancelRetry: (() => void) | undefined;
  private retryFailures = 0;
  /** `report` hears each write that failed and will be retried (a delete, a Windows tick). */
  constructor(
    path: string,
    runtime: InventoryRuntime = inventoryRuntime,
    report: (error: unknown) => void = () => {},
  ) {
    this.runtime = runtime;
    this.report = report;
    this.db = new DatabaseSync(path);
    // Every spawn and exit writes here on the main thread. WAL commits are durable when the
    // daemon crashes, which is what recovery needs, without waiting on fsync: behind other disk
    // work one fsync held the event loop for seconds.
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS processes(pid INTEGER PRIMARY KEY,entry TEXT NOT NULL)",
    );
  }
  list(): ProcessEntry[] {
    if (process.platform === "win32") return this.windowsList();
    return this.db
      .prepare("SELECT entry FROM processes ORDER BY pid")
      .all()
      .map((row) => Entry.parse(JSON.parse(String(row.entry))));
  }
  add(pid: number, metadata: { name: string; cwd?: string }): void {
    // A reused pid: the earlier process's pending delete must not remove the new row.
    this.unremoved.delete(pid);
    this.retryRemovals();
    if (process.platform === "win32") return this.windowsAdd(pid, metadata);
    const identity = this.runtime.identity(pid);
    const owner = this.runtime.identity(this.runtime.ownerPid);
    if (!identity && (this.runtime.childExited?.(pid) || !this.runtime.alive(pid))) return;
    if (
      !identity ||
      !owner ||
      identity.pid !== pid ||
      owner.pid !== this.runtime.ownerPid ||
      identity.group !== pid ||
      identity.uid !== owner.uid
    )
      throw new Error("Cannot record owned process identity");
    if (Number(this.db.prepare("SELECT COUNT(*) AS n FROM processes").get()?.n) >= 4096)
      throw new Error("Process inventory capacity");
    const entry = Entry.parse({
      ...identity,
      ownerPid: this.runtime.ownerPid,
      ownerStart: owner.start,
      name: metadata.name,
      cwd: metadata.cwd,
      createdAt: this.runtime.now(),
    });
    this.db
      .prepare(
        "INSERT INTO processes VALUES (?,?) ON CONFLICT(pid) DO UPDATE SET entry=excluded.entry",
      )
      .run(pid, JSON.stringify(entry));
  }
  /** Forget an exited process. Never throws: a delete that fails is kept and retried. */
  remove(pid: number): void {
    this.unremoved.add(pid);
    this.retryRemovals();
  }
  /**
   * Retry the deletes that failed earlier; true once none is left. Never throws. While any is
   * left, another attempt is scheduled on a bounded backoff, whatever made this one fail.
   */
  retryRemovals(): boolean {
    for (const pid of this.unremoved) {
      try {
        this.db.prepare("DELETE FROM processes WHERE pid=?").run(pid);
      } catch (error) {
        this.report(error);
        this.scheduleRetry();
        return false;
      }
      this.unremoved.delete(pid);
    }
    this.retryFailures = 0;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    return true;
  }
  private scheduleRetry(): void {
    if (this.closed) return;
    this.cancelRetry?.();
    this.cancelRetry = (this.runtime.later ?? later)(
      () => {
        this.cancelRetry = undefined;
        this.retryRemovals();
      },
      inventoryRetryMs(++this.retryFailures),
    );
  }
  private closed = false;
  recover(): { removed: number; killed: number } {
    if (process.platform === "win32") return this.windowsRecover();
    let removed = 0;
    let killed = 0;
    for (const entry of this.list()) {
      const owner = this.runtime.identity(entry.ownerPid);
      if (
        owner?.pid === entry.ownerPid &&
        owner.start === entry.ownerStart &&
        owner.uid === entry.uid
      )
        continue;
      const current = this.runtime.identity(entry.pid);
      if (!this.runtime.alive(entry.group)) {
        this.remove(entry.pid);
        removed++;
        continue;
      }
      if (
        !current ||
        current.pid !== entry.pid ||
        current.start !== entry.start ||
        current.uid !== entry.uid ||
        current.group !== entry.group
      )
        throw new Error(`Orphan group ${entry.group} cannot be safely identified`);
      this.runtime.kill(entry.group);
      // Keep evidence until a later recovery proves the group has disappeared.
      killed++;
    }
    return { removed, killed };
  }
  close(): void {
    this.closed = true;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    this.stopWindowsRecorder?.();
    this.db.close();
  }

  // Windows: no process groups exist. A Job Object usually ends the tree with the daemon. For a
  // tree that escaped it, the journal holds every member proven while its ancestry was live, so
  // recovery ends only proven processes and keeps the record while anything stays unproven.

  private stopWindowsRecorder: (() => void) | undefined;
  private windowsList(): WindowsTreeEntry[] {
    return this.db
      .prepare("SELECT entry FROM processes ORDER BY pid")
      .all()
      .map((row) => WindowsTreeEntry.parse(JSON.parse(String(row.entry))));
  }
  private windowsTrees(): Map<string, WindowsTreeEntry[]> {
    const trees = new Map<string, WindowsTreeEntry[]>();
    for (const entry of this.windowsList()) {
      const key = entry.tree ?? `${entry.pid}:${entry.start}`;
      trees.set(key, [...(trees.get(key) ?? []), entry]);
    }
    return trees;
  }
  private windowsAdd(pid: number, metadata: { name: string; cwd?: string }): void {
    const identity = this.runtime.identity(pid);
    const owner = this.runtime.identity(this.runtime.ownerPid);
    // processIdentity proves absence before it reports none.
    if (!identity) return;
    if (
      !owner ||
      identity.pid !== pid ||
      owner.pid !== this.runtime.ownerPid ||
      identity.uid !== owner.uid
    )
      throw new Error("Cannot record owned process identity");
    if (Number(this.db.prepare("SELECT COUNT(*) AS n FROM processes").get()?.n) >= 4096)
      throw new Error("Process inventory capacity");
    const entry = WindowsTreeEntry.parse({
      ...identity,
      group: pid,
      ownerPid: this.runtime.ownerPid,
      ownerStart: owner.start,
      name: metadata.name,
      cwd: metadata.cwd,
      createdAt: this.runtime.now(),
    });
    this.windowsWrite(entry);
    // A tick runs from a timer: a failed write (a full disk) is reported and retried on a
    // backoff, never thrown. What was already recorded stays as evidence.
    this.stopWindowsRecorder ??= (this.runtime.windowsEvery ?? windowsEvery)(
      guardedTick(() => this.recordWindowsTrees(), {
        now: () => this.runtime.now(),
        report: (error) => this.report(error),
        stop: () => {
          this.stopWindowsRecorder?.();
          this.stopWindowsRecorder = undefined;
        },
      }),
      1_000,
    );
  }
  private windowsWrite(entry: WindowsTreeEntry): void {
    this.unremoved.delete(entry.pid);
    this.db
      .prepare(
        "INSERT INTO processes VALUES (?,?) ON CONFLICT(pid) DO UPDATE SET entry=excluded.entry",
      )
      .run(entry.pid, JSON.stringify(entry));
  }
  private windowsDescendant(tree: string, leader: WindowsTreeEntry, member: WindowsProcessRecord) {
    return WindowsTreeEntry.parse({
      ...leader,
      ...member,
      group: member.pid,
      tree,
      createdAt: this.runtime.now(),
    });
  }
  private windowsOwnerAlive(entry: WindowsTreeEntry): boolean {
    const owner = this.runtime.identity(entry.ownerPid);
    return (
      owner?.pid === entry.ownerPid && owner.start === entry.ownerStart && owner.uid === entry.uid
    );
  }
  /**
   * Records newly proven descendants of this daemon's trees and drops members proven gone.
   * Returns whether any of this daemon's trees remain recorded.
   */
  recordWindowsTrees(): boolean {
    if (process.platform !== "win32") return false;
    const tree = this.runtime.windowsTree ?? windowsTreeRuntime;
    let owned = false;
    for (const [key, entries] of this.windowsTrees()) {
      const leader = entries.find((entry) => entry.tree === undefined) ?? entries[0];
      if (!leader || leader.ownerPid !== this.runtime.ownerPid) continue;
      owned = true;
      const state = tree.state(entries.map(({ pid, start, uid }) => ({ pid, start, uid })));
      const room = 4096 - Number(this.db.prepare("SELECT COUNT(*) AS n FROM processes").get()?.n);
      for (const member of state.discovered.slice(0, Math.max(0, room)))
        this.windowsWrite(this.windowsDescendant(key, leader, member));
      // A gone member stays as evidence while a live process still names it as parent.
      if (state.ambiguous.length === 0)
        for (const gone of state.gone)
          if (entries.some((entry) => entry.pid === gone.pid && entry.tree !== undefined))
            this.remove(gone.pid);
    }
    return owned;
  }
  /** Recovery that also counts trees left recorded because some member cannot be proven. */
  recoverWindows(): { removed: number; killed: number; unresolved: number } {
    const tree = this.runtime.windowsTree ?? windowsTreeRuntime;
    let removed = 0;
    let killed = 0;
    let unresolved = 0;
    for (const [key, entries] of this.windowsTrees()) {
      const leader = entries.find((entry) => entry.tree === undefined) ?? entries[0];
      if (!leader || entries.some((entry) => this.windowsOwnerAlive(entry))) continue;
      const state = tree.state(entries.map(({ pid, start, uid }) => ({ pid, start, uid })));
      for (const member of state.discovered)
        this.windowsWrite(this.windowsDescendant(key, leader, member));
      if (state.live.length === 0 && state.ambiguous.length === 0) {
        for (const entry of entries) this.remove(entry.pid);
        removed++;
        continue;
      }
      for (const member of state.live) tree.terminate(member);
      // Evidence stays until a later recovery proves every member gone.
      if (state.live.length) killed++;
      if (state.ambiguous.length) unresolved++;
    }
    return { removed, killed, unresolved };
  }
  private windowsRecover(): { removed: number; killed: number } {
    const { removed, killed } = this.recoverWindows();
    return { removed, killed };
  }
}

function later(run: () => void, milliseconds: number): () => void {
  const timer = setTimeout(run, milliseconds);
  timer.unref();
  return () => clearTimeout(timer);
}

function windowsEvery(run: () => void, milliseconds: number): () => void {
  const timer = setInterval(run, milliseconds);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Windows only: whether a journal still records the tree a leader started. A recovery that
 * could not prove every member gone keeps that record, so its owners keep their resources.
 */
export function windowsTreeRecorded(
  journal: string,
  leader: { pid: number; start: string },
): boolean {
  if (!existsSync(journal)) return false;
  const db = new DatabaseSync(journal, { readOnly: true });
  try {
    const key = `${leader.pid}:${leader.start}`;
    return db
      .prepare("SELECT entry FROM processes")
      .all()
      .some((row) => {
        const entry = WindowsTreeEntry.parse(JSON.parse(String(row.entry)));
        return entry.tree === key || (entry.pid === leader.pid && entry.start === leader.start);
      });
  } finally {
    db.close();
  }
}
