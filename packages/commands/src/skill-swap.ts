import { rm } from "node:fs/promises";
import { join } from "node:path";
import { sameDirectory, type DirectoryIdentity, type SkillDisk } from "./skill-disk.ts";
import { SkillError } from "./skill-errors.ts";
import type { SwapJournal, SwapJournals } from "./skill-journal.ts";
import { folderFingerprint } from "./skill-source.ts";

/** What recovery found for one journal: who sits at each name now, and what the lock says. */
export interface SwapObserved {
  name: DirectoryIdentity | undefined;
  /** Something, of any kind, is at the skill's name. */
  nameTaken: boolean;
  old: DirectoryIdentity | undefined;
  next: DirectoryIdentity | undefined;
  /** The lock records the journal's folder hash for this skill. */
  committed: boolean;
}
export type SwapStep =
  | { op: "remove"; entry: "old" | "next"; identity: DirectoryIdentity }
  /** Put the original back by swapping it with the folder at the name: never a moment without. */
  | { op: "exchange" }
  /** Put the original back at a free name. */
  | { op: "move" };
export interface SwapPlan {
  steps: SwapStep[];
  /** Why something was left in place for the person; `undefined` when the swap settles fully. */
  left?: string;
}

/**
 * How to settle an interrupted apply. Only directories whose identity matches the journal are
 * touched; anything else at those names is the person's or another program's, and stays.
 */
export function swapRecoveryPlan(journal: SwapJournal, seen: SwapObserved): SwapPlan {
  const nameIsInstalled = sameDirectory(seen.name, journal.installed);
  const nameIsOriginal = sameDirectory(seen.name, journal.original);
  const oldIsOriginal = sameDirectory(seen.old, journal.original);
  const dropNext: SwapStep[] = sameDirectory(seen.next, journal.installed)
    ? [{ op: "remove", entry: "next", identity: journal.installed }]
    : [];
  if (oldIsOriginal) {
    if (nameIsInstalled && seen.committed)
      return { steps: [{ op: "remove", entry: "old", identity: journal.original }] };
    if (nameIsInstalled)
      return {
        steps: [{ op: "exchange" }, { op: "remove", entry: "old", identity: journal.installed }],
      };
    if (!seen.nameTaken) return { steps: [{ op: "move" }, ...dropNext] };
    return {
      steps: dropNext,
      left: "The skill folder was replaced after an interrupted update; its backup was kept.",
    };
  }
  if (nameIsOriginal || (nameIsInstalled && seen.committed && seen.old === undefined))
    return { steps: dropNext };
  return {
    steps: nameIsInstalled ? [] : dropNext,
    left: "An interrupted update's folders no longer match its journal; they were left in place.",
  };
}

export type SwapReport = (message: string, detail: string) => void;
const conflict = () =>
  new SkillError("conflict", "This skill changed since the review. Check for updates again.");

/**
 * Swap a skill folder for a staged replacement under a journal, and settle journals left by a
 * crash. Every step is relative to the pinned skill root; removals check identity first.
 */
export class SkillSwap {
  private readonly disk: SkillDisk;
  private readonly journals: SwapJournals;
  private readonly report: SwapReport;
  constructor(disk: SkillDisk, journals: SwapJournals, report: SwapReport) {
    this.disk = disk;
    this.journals = journals;
    this.report = report;
  }
  /** Remove a child directory only while it is still the identified one. */
  private async removeIf(root: number, name: string, identity: DirectoryIdentity) {
    const fd = await this.disk.openDirectory(root, name);
    if (fd === undefined) return;
    try {
      // The descriptor's own identity: a directory swapped in after the open is never emptied.
      if (!sameDirectory(await this.disk.identityOf(fd), identity)) return;
      await this.disk.empty(fd);
    } finally {
      await this.disk.closeDirectory(fd);
    }
    await this.disk.removeEmptyDirectory(root, name);
  }
  /**
   * Install a staged replacement in place of `name`, under a journal:
   * 1. make `next` and fill it; 2. move the candidate to the backup and check *that* directory
   * against the review; 3. move the replacement in; 4. `commit` (the lock write); 5. drop the
   * backup. A failure before or during the commit puts the original back. The journal goes once
   * the folders are settled; if a rollback itself fails it stays for the next start.
   */
  async apply(input: {
    root: number;
    rootReal: string;
    name: string;
    folderHash: string;
    token: string;
    lockTemporary: string;
    fingerprint: string;
    fill(next: number): Promise<void>;
    commit(): Promise<void>;
  }): Promise<void> {
    const { root, name } = input;
    const original = await this.disk.identity(root, name);
    if (original === undefined) throw conflict();
    const next = `.${name}.ace-update-${input.token}`;
    const old = `.${name}.ace-old-${input.token}`;
    if (!(await this.disk.makeDirectory(root, next)))
      throw new SkillError("update_failed", "Couldn't stage this update.");
    const installed = await this.disk.identity(root, next);
    if (installed === undefined)
      throw new SkillError("update_failed", "Couldn't stage this update.");
    const journal: SwapJournal = {
      version: 1,
      id: input.token,
      rootReal: input.rootReal,
      name,
      next,
      old,
      folderHash: input.folderHash,
      original,
      installed,
      lockTemporary: input.lockTemporary,
    };
    try {
      await this.journals.write(journal);
      await this.swap(root, journal, input);
    } catch (error) {
      // Settled when no backup is left and the name doesn't hold ace's replacement: the original
      // is back, or (after a conflict) whatever someone else put there is untouched.
      const clean =
        !(await this.disk.exists(root, old)) &&
        !sameDirectory(await this.disk.identity(root, name), installed);
      if (!clean) {
        this.report(
          "Skill update interrupted; ace settles it on its next start",
          join(input.rootReal, name),
        );
        throw new SkillError(
          "update_failed",
          "Couldn't finish this update. ace will put the original back when it next starts.",
        );
      }
      await this.finish(root, journal);
      if (
        error instanceof SkillError &&
        (error.code === "conflict" || error.code === "update_failed")
      )
        throw error;
      throw new SkillError(
        "update_failed",
        "Couldn't replace this skill's files. Nothing changed.",
      );
    }
    await this.finish(root, journal);
  }
  private async swap(
    root: number,
    journal: SwapJournal,
    input: { fingerprint: string; fill(next: number): Promise<void>; commit(): Promise<void> },
  ): Promise<void> {
    const { name, next, old } = journal;
    const target = await this.disk.openDirectory(root, next);
    if (target === undefined) throw new SkillError("update_failed", "Couldn't stage this update.");
    try {
      await input.fill(target);
    } finally {
      await this.disk.closeDirectory(target);
    }
    await this.disk.move(root, name, old);
    // Check what was actually moved, not what was opened earlier: a folder replaced while the
    // update was staging goes straight back.
    if (!(await this.matches(root, old, journal.original, input.fingerprint))) {
      await this.disk.move(root, old, name);
      throw conflict();
    }
    try {
      await this.disk.move(root, next, name);
    } catch (error) {
      await this.disk.move(root, old, name);
      throw error;
    }
    // The folder at the name is the one staged; anything else stops before the lock records it.
    if (!sameDirectory(await this.disk.identity(root, name), journal.installed))
      throw new SkillError("update_failed", "The skill folder changed during the update.");
    try {
      await input.commit();
    } catch {
      await this.disk.exchange(root, old, name);
      await this.removeIf(root, old, journal.installed);
      throw new SkillError(
        "update_failed",
        "Couldn't record the update in the skills lock file. Nothing changed.",
      );
    }
    await this.removeIf(root, old, journal.original);
  }
  private async matches(
    root: number,
    name: string,
    identity: DirectoryIdentity,
    fingerprint: string,
  ): Promise<boolean> {
    const moved = await this.disk.openDirectory(root, name);
    if (moved === undefined) return false;
    try {
      return (
        sameDirectory(await this.disk.identityOf(moved), identity) &&
        folderFingerprint(await this.disk.walk(moved)) === fingerprint
      );
    } catch {
      return false;
    } finally {
      await this.disk.closeDirectory(moved);
    }
  }
  /** Drop the unused replacement, if still there, and the journal. */
  private async finish(root: number, journal: SwapJournal): Promise<void> {
    await this.removeIf(root, journal.next, journal.installed).catch(() => {});
    await this.journals.remove(journal.id);
  }
  /** Whether any journal, readable or not, is waiting. */
  async pending(): Promise<boolean> {
    const { journals, unreadable } = await this.journals.list();
    return journals.length + unreadable.length > 0;
  }
  /** Settle every journal in the store. `committed` reads the lock for one journal. */
  async recover(committed: (journal: SwapJournal) => boolean): Promise<void> {
    const { journals, unreadable } = await this.journals.list();
    for (const path of unreadable)
      this.report("Unreadable skill update journal left in place", path);
    for (const journal of journals) {
      const root = await this.disk.openPath(journal.rootReal);
      if (root === undefined) {
        if (await this.disk.absent(journal.rootReal)) {
          this.report("Skill folder of an interrupted update is gone", journal.rootReal);
          await this.journals.remove(journal.id);
        } else
          // Unreadable, or a link where the folder was: keep the journal and try next time.
          this.report(
            "Skill folder of an interrupted update can't be opened yet",
            journal.rootReal,
          );
        continue;
      }
      try {
        await this.settle(root, journal, committed(journal));
      } finally {
        await this.disk.closeDirectory(root);
      }
    }
  }
  private async settle(root: number, journal: SwapJournal, committed: boolean): Promise<void> {
    const plan = swapRecoveryPlan(journal, {
      name: await this.disk.identity(root, journal.name),
      nameTaken: await this.disk.exists(root, journal.name),
      old: await this.disk.identity(root, journal.old),
      next: await this.disk.identity(root, journal.next),
      committed,
    });
    try {
      for (const step of plan.steps) {
        if (step.op === "remove") await this.removeIf(root, journal[step.entry], step.identity);
        else if (step.op === "exchange") await this.disk.exchange(root, journal.old, journal.name);
        else await this.disk.move(root, journal.old, journal.name);
      }
    } catch {
      // The journal stays, so the next start tries again from whatever state this left.
      this.report(
        "Couldn't settle an interrupted skill update",
        join(journal.rootReal, journal.name),
      );
      return;
    }
    if (plan.left) this.report(plan.left, join(journal.rootReal, journal.name));
    await rm(journal.lockTemporary, { force: true });
    await this.journals.remove(journal.id);
  }
}
