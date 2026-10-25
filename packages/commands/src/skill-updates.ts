import { mkdir, readFile, readdir, realpath, rename, rm, open } from "node:fs/promises";
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
const gitHash = /^[a-f0-9]{40,64}$/;
// `.<name>.ace-update-<token>`: a replacement being built, or one rolled back. Always removed.
const building = /^\.(.+)\.ace-update-[A-Za-z0-9-]+$/;
// `.<name>.ace-old-<folderHash>-<token>`: the original, kept until the lock records folderHash.
const backup = /^\.(.+)\.ace-old-([a-f0-9]{40,64})-[A-Za-z0-9-]+$/;
const conflict = () =>
  new SkillError("conflict", "This skill changed since the review. Check for updates again.");
/** Check, stage, review and apply updates for skills installed by the `skills` CLI. */
export class SkillUpdates {
  private readonly options: SkillUpdateOptions;
  private readonly pending = new Map<string, Pending>();
  private readonly disk: SkillDisk;
  constructor(options: SkillUpdateOptions, disk: SkillDisk) {
    this.options = options;
    this.disk = disk;
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
   * Swap the folder for the staged one, then record the new hash in the lock. The original stays
   * beside it, named after the new hash, until the lock commits; any failure puts it back.
   * `expectedHash` is the SKILL.md hash the review started from (`review.baseHash`).
   */
  async apply(reviewId: string, skillId: string, canonical: SkillFolder, expectedHash: string) {
    this.expire();
    const pending = this.pending.get(reviewId);
    if (!pending || pending.review.skillId !== skillId)
      throw new SkillError("not_found", "This update review expired. Check for updates again.");
    if (expectedHash !== pending.review.baseHash) throw conflict();
    const { name } = canonical;
    const token = this.options.id();
    const next = `.${name}.ace-update-${token}`;
    const old = `.${name}.ace-old-${pending.review.folderHash}-${token}`;
    await withSkillFolder(this.disk, canonical, async (root, folder) => {
      try {
        if (!(await this.disk.makeDirectory(root, next)))
          throw new SkillError("update_failed", "Couldn't stage this update.");
        const target = await this.disk.openDirectory(root, next);
        if (target === undefined)
          throw new SkillError("update_failed", "Couldn't stage this update.");
        try {
          await this.withStaged(pending.staged, (staged) => this.disk.copy(staged, target));
        } finally {
          await this.disk.closeDirectory(target);
        }
        // Right before the swap: every file still as reviewed, not only SKILL.md.
        if (folderFingerprint(await this.disk.walk(folder)) !== pending.fingerprint)
          throw conflict();
        await this.disk.rename(root, name, root, old);
        try {
          await this.disk.rename(root, next, root, name);
        } catch (error) {
          await this.disk.rename(root, old, root, name);
          throw error;
        }
      } catch (error) {
        await this.disk.remove(root, next).catch(() => {});
        if (error instanceof SkillError && error.code === "conflict") throw error;
        throw new SkillError(
          "update_failed",
          "Couldn't replace this skill's files. Nothing changed.",
        );
      }
      try {
        await this.writeLock(name, pending.review.folderHash);
      } catch {
        // The lock still names the old version: put the old folder back.
        await this.disk.rename(root, name, root, next);
        await this.disk.rename(root, old, root, name);
        await this.disk.remove(root, next).catch(() => {});
        throw new SkillError(
          "update_failed",
          "Couldn't record the update in the skills lock file. Nothing changed.",
        );
      }
      await this.disk.remove(root, old).catch(() => {});
    });
    await this.cancel(reviewId);
  }
  private async writeLock(name: string, folderHash: string) {
    const text = await readFile(this.options.lockPath, "utf8");
    const temporary = `${this.options.lockPath}.ace-${this.options.id()}`;
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
   * After a crash: drop staged reviews and half-built replacements, then settle any original kept
   * beside its folder. The update stands only if the lock already records its hash; otherwise the
   * original goes back.
   */
  async recover(roots: readonly string[]): Promise<void> {
    await rm(this.options.temporaryRoot, { recursive: true, force: true });
    const lockDirectory = dirname(this.options.lockPath);
    const lockName = basename(this.options.lockPath);
    for (const entry of await readdir(lockDirectory).catch(() => [] as string[]))
      if (entry.startsWith(`${lockName}.ace-`))
        await rm(join(lockDirectory, entry), { force: true });
    const locked = await this.locked();
    for (const path of new Set(roots)) {
      const real = await realpath(path).catch(() => undefined);
      const root = real === undefined ? undefined : await this.disk.openPath(real);
      if (root === undefined) continue;
      try {
        await this.settle(root, locked);
      } finally {
        await this.disk.closeDirectory(root);
      }
    }
  }
  private async settle(root: number, locked: ReadonlyMap<string, LockedSkill>): Promise<void> {
    const names = await this.disk.names(root);
    for (const entry of names)
      if (building.test(entry)) await this.disk.remove(root, entry).catch(() => {});
    for (const entry of names) {
      const kept = backup.exec(entry);
      const name = kept?.[1];
      if (!kept || !name) continue;
      const present = names.includes(name);
      if (present && locked.get(name)?.folderHash === kept[2]) {
        await this.disk.remove(root, entry).catch(() => {});
        continue;
      }
      const aside = `.${name}.ace-update-recover-${this.options.id()}`;
      if (present) await this.disk.rename(root, name, root, aside).catch(() => {});
      await this.disk.rename(root, entry, root, name).catch(() => {});
      if (present) await this.disk.remove(root, aside).catch(() => {});
    }
  }
  async close(): Promise<void> {
    for (const id of this.pending.keys()) await this.cancel(id);
  }
}
