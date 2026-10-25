import { mkdir, readFile, realpath, rename, rm, open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SkillUpdateReview } from "@ace/protocol";
import {
  diffFolders,
  folderFingerprint,
  readLock,
  updateLock,
  type LockedSkill,
} from "./skill-source.ts";
import type { SkillDisk } from "./skill-disk.ts";
import { SkillError } from "./skill-errors.ts";
import { readPinnedSkill, withSkillFolder } from "./skill-files.ts";
import { SwapJournals } from "./skill-journal.ts";
import { withSkillLock, type SkillLockWait } from "./skill-lock.ts";
import { SkillSwap, type SwapReport } from "./skill-swap.ts";
import type { SkillFolder } from "./skill-model.ts";

/** Git access, injected so tests use local repositories and the daemon reuses the plugin fetcher. */
export interface SkillFetcher {
  fetch(url: string, ref: string, temporary: string): Promise<{ gitRoot: string; commit: string }>;
  /** Git tree SHA of `folder` (`.` for the repository root) at `commit`: the lock's `skillFolderHash`. */
  treeHash(gitRoot: string, commit: string, folder: string): Promise<string>;
  /** Write the folder's blobs under `destination`, refusing symlinks and submodules. */
  extract(gitRoot: string, commit: string, folder: string, destination: string): Promise<void>;
}
export interface SkillUpdateOptions {
  fetcher: SkillFetcher;
  /** Private directory for fetches and staged folders. */
  temporaryRoot: string;
  lockPath: string;
  /** Private directory for swap journals (ace's data dir); survives restarts. */
  journalRoot: string;
  /** Things recovery left in place for the person, with the path concerned. */
  report?: SwapReport | undefined;
  /** Pause while another ace holds the skills lock. */
  wait?: SkillLockWait | undefined;
  now(): number;
  id(): string;
}
interface Pending {
  review: SkillUpdateReview;
  staged: string;
  /** Every file of the installed folder when the review was made (`folderFingerprint`). */
  fingerprint: string;
  expires: number;
}
const reviewLifetime = 30 * 60_000;
const pause: SkillLockWait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const gitHash = /^[a-f0-9]{40,64}$/;
const conflict = () =>
  new SkillError("conflict", "This skill changed since the review. Check for updates again.");
/** Check, stage, review and apply updates for skills installed by the `skills` CLI. */
export class SkillUpdates {
  private readonly options: SkillUpdateOptions;
  private readonly pending = new Map<string, Pending>();
  private readonly disk: SkillDisk;
  private readonly swap: SkillSwap;
  constructor(options: SkillUpdateOptions, disk: SkillDisk) {
    this.options = options;
    this.disk = disk;
    this.swap = new SkillSwap(
      disk,
      new SwapJournals(options.journalRoot),
      options.report ?? (() => {}),
    );
  }
  /** Beside the shared lock file, so every ace using these skills takes the same lock. */
  private locking<T>(run: () => Promise<T>): Promise<T> {
    const path = join(dirname(this.options.lockPath), ".ace-skills.sqlite");
    return withSkillLock(path, this.options.wait ?? pause, run);
  }
  async locked(): Promise<Map<string, LockedSkill>> {
    return readLock(await readFile(this.options.lockPath, "utf8").catch(() => undefined));
  }
  private async source(name: string): Promise<LockedSkill> {
    const locked = (await this.locked()).get(name);
    if (!locked) throw new SkillError("invalid", "This skill wasn't installed from a source.");
    return locked;
  }
  private async fetched<T>(
    locked: LockedSkill,
    work: (
      git: { gitRoot: string; commit: string; folderHash: string },
      scratch: string,
    ) => Promise<T>,
  ): Promise<T> {
    const scratch = join(this.options.temporaryRoot, `fetch-${this.options.id()}`);
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    try {
      const git = await this.options.fetcher.fetch(locked.url, locked.ref, scratch);
      const folderHash = await this.options.fetcher.treeHash(
        git.gitRoot,
        git.commit,
        locked.folder,
      );
      return await work({ ...git, folderHash }, scratch);
    } catch (error) {
      if (error instanceof SkillError) throw error;
      throw new SkillError("update_failed", "Couldn't fetch this skill's source. Try again later.");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  async check(name: string) {
    const locked = await this.source(name);
    return this.fetched(locked, async ({ commit, folderHash }) => ({
      status: folderHash === locked.folderHash ? ("current" as const) : ("available" as const),
      commit,
    }));
  }
  async prepare(skillId: string, canonical: SkillFolder): Promise<SkillUpdateReview> {
    this.expire();
    if (this.pending.size >= 8)
      throw new SkillError("limit", "Finish or cancel other update reviews first.");
    const locked = await this.source(canonical.name);
    const id = `skill-update-${this.options.id()}`;
    const staged = join(this.options.temporaryRoot, id);
    return this.fetched(locked, async ({ gitRoot, commit, folderHash }) => {
      try {
        if (!gitHash.test(folderHash)) throw new SkillError("update_failed", "Invalid tree.");
        await this.options.fetcher.extract(gitRoot, commit, locked.folder, staged);
        const next = await this.withStaged(staged, async (folder) => ({
          skill: await readPinnedSkill(this.disk, folder),
          files: await this.disk.walk(folder),
        }));
        const current = await withSkillFolder(this.disk, canonical, async (_root, folder) => ({
          skill: await readPinnedSkill(this.disk, folder),
          files: await this.disk.walk(folder),
        }));
        if (!next.skill || !current.skill) throw new SkillError("not_found", "No SKILL.md.");
        const review: SkillUpdateReview = {
          id,
          skillId,
          commit,
          folderHash,
          baseHash: current.skill.hash,
          files: diffFolders(current.files, next.files),
          before: current.skill.text,
          after: next.skill.text,
        };
        this.pending.set(id, {
          review,
          staged,
          fingerprint: folderFingerprint(current.files),
          expires: this.options.now() + reviewLifetime,
        });
        return review;
      } catch (error) {
        await rm(staged, { recursive: true, force: true });
        if (error instanceof SkillError && error.code !== "not_found") throw error;
        throw new SkillError("update_failed", "The source no longer has a valid SKILL.md here.");
      }
    });
  }
  private async withStaged<T>(staged: string, work: (folder: number) => Promise<T>): Promise<T> {
    const real = await realpath(staged);
    return this.disk.withFolder(dirname(real), basename(real), (_root, folder) => work(folder));
  }
  /**
   * Swap the folder for the staged one and record the new hash in the lock, under the skills
   * lock and a journal (`SkillSwap.apply`). `expectedHash` is the review's `baseHash`.
   */
  async apply(reviewId: string, skillId: string, canonical: SkillFolder, expectedHash: string) {
    this.expire();
    const pending = this.pending.get(reviewId);
    if (!pending || pending.review.skillId !== skillId)
      throw new SkillError("not_found", "This update review expired. Check for updates again.");
    if (expectedHash !== pending.review.baseHash) throw conflict();
    if (canonical.real !== join(canonical.rootReal, canonical.name))
      throw new SkillError("read_only", "This skill's folder moved. Reload the list.");
    const { name } = canonical;
    const { folderHash } = pending.review;
    const token = this.options.id();
    const lockTemporary = `${this.options.lockPath}.ace-${token}`;
    await this.locking(async () => {
      const root = await this.disk.openPath(canonical.rootReal);
      if (root === undefined)
        throw new SkillError("read_only", "This skill's folder moved. Reload the list.");
      try {
        await this.swap.apply({
          root,
          rootReal: canonical.rootReal,
          name,
          folderHash,
          token,
          lockTemporary,
          fingerprint: pending.fingerprint,
          fill: (next) => this.withStaged(pending.staged, (staged) => this.disk.copy(staged, next)),
          commit: () => this.writeLock(name, folderHash, lockTemporary),
        });
      } finally {
        await this.disk.closeDirectory(root);
      }
    });
    await this.cancel(reviewId);
  }
  private async writeLock(name: string, folderHash: string, temporary: string) {
    const text = await readFile(this.options.lockPath, "utf8");
    try {
      const handle = await open(temporary, "wx", 0o644);
      try {
        await handle.writeFile(
          updateLock(text, name, folderHash, new Date(this.options.now()).toISOString()),
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.options.lockPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async cancel(reviewId: string): Promise<void> {
    const pending = this.pending.get(reviewId);
    this.pending.delete(reviewId);
    if (pending) await rm(pending.staged, { recursive: true, force: true });
  }
  private expire(): void {
    for (const [id, pending] of this.pending)
      if (pending.expires <= this.options.now()) void this.cancel(id);
  }
  /**
   * After a crash: drop this ace's staged reviews, then settle each apply it has a journal for
   * (`SkillSwap.recover`). Folders without a journal, or that no longer match one, are left alone.
   */
  async recover(): Promise<void> {
    await rm(this.options.temporaryRoot, { recursive: true, force: true });
    if (!(await this.swap.pending())) return;
    await this.locking(async () => {
      const locked = await this.locked();
      await this.swap.recover(
        (journal) => locked.get(journal.name)?.folderHash === journal.folderHash,
      );
    });
  }
  async close(): Promise<void> {
    for (const id of this.pending.keys()) await this.cancel(id);
  }
}
