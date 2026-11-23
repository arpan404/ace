import { childHasExited } from "./child-exit.ts";
import { existsSync } from "node:fs";
import { z } from "zod";
import { DatabaseSync } from "./sqlite.ts";
import { noteJournalBoot, supervisorBackend } from "./native-switches.ts";
import { supervisorAddon } from "./native-process.ts";
import { processIdentity, processGroupIsGone, type ProcessIdentity } from "./process-identity.ts";
import { WindowsSid, windowsTreeRuntime, type WindowsTreeRuntime } from "./process-identity.ts";
import type { WindowsProcessRecord } from "./process-identity.ts";
import { guardedTick, inventoryRetryMs } from "./inventory-retry.ts";
import { killGroup } from "./process-owner.ts";
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
  /** Ends a verified group; `start` is its leader's kernel start, its identity. */
  kill(group: number, start?: string): void;
  ownerPid: number;
  now(): number;
  /** Windows only: a recorded tree is its leader plus live descendants, not a group. */
  windowsTree?: WindowsTreeRuntime;
  /** Windows only: runs the descendant recorder on an interval; returns its stop. */
  windowsEvery?: (run: () => void, milliseconds: number) => () => void;
  /** Runs `run` once after `milliseconds`; returns its cancel. Retries of failed deletes use it. */
  later?: (run: () => void, milliseconds: number) => () => void;
}
export const inventoryRuntime: InventoryRuntime = {
  identity: processIdentity,
  childExited: childHasExited,
  ownerPid: process.pid,
  now: Date.now,
  alive(group) {
    return !processGroupIsGone(group);
  },
  // Through the group guard: a previous run's group may hold another home's daemon.
  kill: (group, start) => killGroup(group, "SIGKILL", undefined, start),
};
/** Only kernel identities and non-secret labels persist; provider input never enters this journal. */
export class ProcessInventory implements ProcessJournal {
  private db!: DatabaseSync;
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
  /** The native journal when the supervisor runs in Rust; the timers stay here. */
  private native:
    | {
        handle: {
          add(pid: number, name: string, cwd?: string): void;
          remove(pid: number): string;
          retryRemovals(nowMs: number): string;
          retryAtMs(): number | null | undefined;
          recover(): string;
          list(): string;
          takeReports(): string[];
          close(): void;
          windowsTick(nowMs: number): boolean;
        };
        cancelRetry: (() => void) | undefined;
        cancelWindows: (() => void) | undefined;
      }
    | undefined;
  /** `report` hears each write that failed and will be retried (a delete, a Windows tick). */
  constructor(
    path: string,
    runtime: InventoryRuntime = inventoryRuntime,
    report: (error: unknown) => void = () => {},
  ) {
    this.runtime = runtime;
    this.report = report;
    noteJournalBoot(path);
    if (supervisorBackend() === "native") {
      const addon = supervisorAddon();
      this.native = {
        handle: new addon.NativeInventory(path),
        cancelRetry: undefined,
        cancelWindows: undefined,
      };
      return;
    }
    const db = new DatabaseSync(path);
    this.db = db;
    // Every spawn and exit writes here on the main thread. WAL commits are durable when the
    // daemon crashes, which is what recovery needs, without waiting on fsync: behind other disk
    // work one fsync held the event loop for seconds.
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    db.exec("CREATE TABLE IF NOT EXISTS processes(pid INTEGER PRIMARY KEY,entry TEXT NOT NULL)");
  }
  /** Reports what the native journal failed and will retry, then forgets it. */
  private drainNativeReports(): void {
    const native = this.native;
    if (!native) return;
    for (const message of native.handle.takeReports()) this.report(new Error(message));
  }
  /** The retry timer: the runtime's, or an unref'd one that never keeps the daemon alive. */
  private later(run: () => void, ms: number): () => void {
    const schedule =
      this.runtime.later ??
      ((task: () => void, wait: number) => {
        const timer = setTimeout(task, wait);
        timer.unref?.();
        return () => clearTimeout(timer);
      });
    return schedule(run, ms);
  }
  list(): ProcessEntry[] {
    const native = this.native;
    if (native) {
      this.drainNativeReports();
      return (JSON.parse(native.handle.list()) as unknown[]).map((row) =>
        process.platform === "win32" ? WindowsTreeEntry.parse(row) : Entry.parse(row),
      );
    }
    if (process.platform === "win32") return this.windowsList();
    return this.db
      .prepare("SELECT entry FROM processes ORDER BY pid")
      .all()
      .map((row) => Entry.parse(JSON.parse(String(row.entry))));
  }
  add(pid: number, metadata: { name: string; cwd?: string }): void {
    const native = this.native;
    if (native) {
      native.handle.add(pid, metadata.name, metadata.cwd);
      this.drainNativeReports();
      if (process.platform === "win32") this.armNativeWindowsRecorder(native);
      return;
    }
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
    const native = this.native;
    if (native) {
      const plan = JSON.parse(native.handle.remove(pid)) as { retryInMs: number | null };
      this.drainNativeReports();
      this.scheduleNativeRetry(native, plan.retryInMs);
      return;
    }
    this.unremoved.add(pid);
    this.retryRemovals();
  }
  /**
   * Retry the deletes that failed earlier; true once none is left. Never throws. While any is
   * left, another attempt is scheduled on a bounded backoff, whatever made this one fail.
   */
  retryRemovals(): boolean {
    const native = this.native;
    if (native) {
      const plan = JSON.parse(native.handle.retryRemovals(this.runtime.now())) as {
        retryInMs: number | null;
      };
      this.drainNativeReports();
      this.scheduleNativeRetry(native, plan.retryInMs);
      return plan.retryInMs === null;
    }
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
  /** Schedules a native retry from its plan; the timer never keeps the daemon alive. */
  private scheduleNativeRetry(
    native: NonNullable<ProcessInventory["native"]>,
    retryInMs: number | null,
  ): void {
    native.cancelRetry?.();
    native.cancelRetry = undefined;
    if (retryInMs === null || this.closed) return;
    native.cancelRetry = this.later(() => {
      native.cancelRetry = undefined;
      this.retryRemovals();
    }, retryInMs);
  }
  /** Starts the native Windows recorder; a failed tick is reported and retried. */
  private armNativeWindowsRecorder(native: NonNullable<ProcessInventory["native"]>): void {
    if (native.cancelWindows) return;
    const every =
      this.runtime.windowsEvery ??
      ((run: () => void, ms: number) => {
        const timer = setInterval(run, ms);
        timer.unref?.();
        return () => clearInterval(timer);
      });
    native.cancelWindows = every(() => {
      try {
        if (!native.handle.windowsTick(Date.now())) {
          native.cancelWindows?.();
          native.cancelWindows = undefined;
        }
      } catch (error) {
        this.report(error);
      }
      this.drainNativeReports();
    }, 1_000);
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
  recover(): { removed: number; killed: number; unresolved: number } {
    const native = this.native;
    if (native) {
      const { groups, ...recovered } = JSON.parse(native.handle.recover()) as {
        removed: number;
        killed: number;
        unresolved: number;
        groups: { pid: number; start: string }[];
      };
      this.drainNativeReports();
      // Recovery only marks first-empty rows; the retry pass takes the second
      // scan a second later. Schedule it from the native retry hint.
      const at = native.handle.retryAtMs();
      if (typeof at === "number" && Number.isFinite(at))
        this.scheduleNativeRetry(native, Math.max(0, at - this.runtime.now()));
      // The verified orphan groups end through the runtime's guarded group stop, never past it.
      for (const group of groups) this.runtime.kill(group.pid, group.start);
      return recovered;
    }
    if (process.platform === "win32") return { ...this.windowsRecover(), unresolved: 0 };
    let removed = 0;
    let killed = 0;
    let unresolved = 0;
    for (const entry of this.list()) {
      const owner = this.runtime.identity(entry.ownerPid);
      if (
        owner?.pid === entry.ownerPid &&
        owner.start === entry.ownerStart &&
        owner.uid === entry.uid
      )
        continue;
      let current: ProcessIdentity | undefined;
      try {
        current = this.runtime.identity(entry.pid);
      } catch {
        // An identity the kernel won't give proves nothing either way: unresolved, below.
        current = undefined;
      }
      const alive = this.groupAlive(entry.group);
      if (alive === undefined) {
        // The kernel refused the probe (macOS does this while a group exits). Only ESRCH proves
        // a group gone, so keep its evidence for a later recovery instead of failing startup.
        unresolved++;
        continue;
      }
      if (!alive) {
        this.remove(entry.pid);
        removed++;
        continue;
      }
      // The group lives on, but its leader is gone or its PID is someone else's now: nothing
      // proves the group is the run's, so it is neither ended nor called stopped. Startup goes on
      // and reports the previous run unverified; the record stays for a later start.
      if (
        !current ||
        current.pid !== entry.pid ||
        current.start !== entry.start ||
        current.uid !== entry.uid ||
        current.group !== entry.group
      ) {
        unresolved++;
        continue;
      }
      this.runtime.kill(entry.group, entry.start);
      // Keep evidence until a later recovery proves the group has disappeared.
      killed++;
    }
    return { removed, killed, unresolved };
  }
  /** Liveness of a recorded group, or undefined when the kernel refuses to say (EPERM). */
  private groupAlive(group: number): boolean | undefined {
    try {
      return this.runtime.alive(group);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EPERM") return undefined;
      throw error;
    }
  }
  close(): void {
    const native = this.native;
    if (native) {
      this.closed = true;
      native.cancelRetry?.();
      native.cancelRetry = undefined;
      native.cancelWindows?.();
      native.cancelWindows = undefined;
      native.handle.close();
      this.drainNativeReports();
      return;
    }
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
  if (supervisorBackend() === "native") {
    if (!existsSync(journal)) return false;
    return supervisorAddon().supervisorWindowsTreeRecorded(journal, JSON.stringify(leader));
  }
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

/**
 * Read-only, for `ace stop`: what the inventory records as owned by one daemon process (its pid
 * and start), by pid and start: POSIX group leaders, and on Windows each tree's leader and the
 * members its recorder proved.
 */
export function readOwnedGroups(
  journal: string,
  owner: { pid: number; start: string },
): { pid: number; start: string }[] {
  if (supervisorBackend() === "native") {
    if (!existsSync(journal)) return [];
    return JSON.parse(
      supervisorAddon().supervisorReadOwnedGroups(journal, owner.pid, owner.start),
    ) as { pid: number; start: string }[];
  }
  if (!existsSync(journal)) return [];
  const db = new DatabaseSync(journal, { readOnly: true });
  try {
    // A home whose inventory never recorded a process has no table: nothing owned, not unknown.
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='processes'").get())
      return [];
    return db
      .prepare("SELECT entry FROM processes ORDER BY pid")
      .all()
      .flatMap((row) => {
        const value: unknown = JSON.parse(String(row.entry));
        const posix = Entry.safeParse(value);
        const entry = posix.success ? posix : WindowsTreeEntry.safeParse(value);
        return entry.success &&
          entry.data.ownerPid === owner.pid &&
          entry.data.ownerStart === owner.start
          ? [{ pid: entry.data.pid, start: entry.data.start }]
          : [];
      });
  } finally {
    db.close();
  }
}
