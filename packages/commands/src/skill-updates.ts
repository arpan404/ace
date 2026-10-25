import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  open,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { SkillUpdateReview } from "@ace/protocol";
import {
  diffFolders,
  readLock,
  updateLock,
  type FolderFile,
  type LockedSkill,
} from "./skill-source.ts";
import { readSkillFile, SkillError, writableDirectory } from "./skill-files.ts";
import type { SkillFolder } from "./skill-model.ts";

/** Git access, injected so tests use local repositories and the daemon reuses the plugin fetcher. */
export interface SkillFetcher {
  fetch(url: string, ref: string, temporary: string): Promise<{ gitRoot: string; commit: string }>;
  /** Git tree SHA of `folder` at `commit`: the lock's `skillFolderHash`. */
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
  expires: number;
}
const reviewLifetime = 30 * 60_000;
async function walk(root: string): Promise<Map<string, FolderFile>> {
  const files = new Map<string, FolderFile>();
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 16) throw new SkillError("limit", "This skill folder is nested too deeply.");
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isDirectory()) await visit(path, depth + 1);
      else if (info.isFile() || info.isSymbolicLink()) {
        if (files.size >= 512) throw new SkillError("limit", "This skill has too many files.");
        const hash = info.isFile()
          ? createHash("sha256")
              .update(await readFile(path))
              .digest("hex")
          : `link:${path}`;
        files.set(relative(root, path), { hash, executable: (info.mode & 0o111) !== 0 });
      }
    }
  };
  await visit(root, 0);
  return files;
}
/** Check, stage, review and apply updates for skills installed by the `skills` CLI. */
export class SkillUpdates {
  private readonly options: SkillUpdateOptions;
  private readonly pending = new Map<string, Pending>();
  constructor(options: SkillUpdateOptions) {
    this.options = options;
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
        await this.options.fetcher.extract(gitRoot, commit, locked.folder, staged);
        const after = await readSkillFile(staged);
        const before = await readSkillFile(canonical.real);
        const review: SkillUpdateReview = {
          id,
          skillId,
          commit,
          folderHash,
          files: diffFolders(await walk(canonical.real), await walk(staged)),
          before: before.text,
          after: after.text,
        };
        this.pending.set(id, { review, staged, expires: this.options.now() + reviewLifetime });
        return review;
      } catch (error) {
        await rm(staged, { recursive: true, force: true });
        if (error instanceof SkillError && error.code !== "not_found") throw error;
        throw new SkillError("update_failed", "The source no longer has a valid SKILL.md here.");
      }
    });
  }
  /** Swap the folder's contents for the staged ones, then record the new hash in the lock. */
  async apply(reviewId: string, skillId: string, canonical: SkillFolder, expectedHash: string) {
    this.expire();
    const pending = this.pending.get(reviewId);
    if (!pending || pending.review.skillId !== skillId)
      throw new SkillError("not_found", "This update review expired. Check for updates again.");
    const real = await writableDirectory(canonical);
    if ((await readSkillFile(real)).hash !== expectedHash)
      throw new SkillError(
        "conflict",
        "This skill changed since the review. Check for updates again.",
      );
    const token = this.options.id();
    const next = join(dirname(real), `.${canonical.name}.ace-update-${token}`);
    const old = join(dirname(real), `.${canonical.name}.ace-old-${token}`);
    let moved = false;
    try {
      for (const [path, file] of await walk(pending.staged)) {
        const target = join(next, path);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(pending.staged, path), target);
        await chmod(target, file.executable ? 0o755 : 0o644);
      }
      await rename(real, old);
      moved = true;
      await rename(next, real);
    } catch {
      if (moved) await rename(old, real).catch(() => {});
      throw new SkillError(
        "update_failed",
        "Couldn't replace this skill's files. Nothing changed.",
      );
    } finally {
      await rm(next, { recursive: true, force: true });
    }
    await rm(old, { recursive: true, force: true });
    await this.writeLock(canonical.name, pending.review.folderHash);
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
   * After a crash: drop staged reviews, put back a folder caught between its two renames and
   * remove half-built replacements in `root`.
   */
  async recover(roots: readonly string[]): Promise<void> {
    await rm(this.options.temporaryRoot, { recursive: true, force: true });
    for (const root of roots)
      for (const entry of await readdir(root).catch(() => [] as string[])) {
        const swap = /^\.(.+)\.ace-(old|update)-[A-Za-z0-9-]+$/.exec(entry);
        if (!swap?.[1]) continue;
        const path = join(root, entry);
        const original = join(root, swap[1]);
        if (swap[2] === "old" && !(await lstat(original).catch(() => undefined)))
          await rename(path, original).catch(() => {});
        else await rm(path, { recursive: true, force: true });
      }
  }
  async close(): Promise<void> {
    for (const id of this.pending.keys()) await this.cancel(id);
  }
}
