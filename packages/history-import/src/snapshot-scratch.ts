import { execFile } from "node:child_process";
import { lstat, mkdtemp, readdir, rm, statfs } from "node:fs/promises";
import { join } from "node:path";

const GiB = 1024 ** 3;
const PREFIX = "sqlite-read-";

export interface SnapshotPolicy {
  /** Largest number of bytes one snapshot may write into scratch. */
  maxCopyBytes: number;
  /** Free space that must remain after a snapshot: max(minFreeBytes, minFreeRatio * volume). */
  minFreeBytes: number;
  minFreeRatio: number;
}
export const defaultSnapshotPolicy: SnapshotPolicy = {
  maxCopyBytes: 4 * GiB,
  minFreeBytes: 5 * GiB,
  minFreeRatio: 0.02,
};
export type FreeSpaceProbe = (path: string) => Promise<{ available: number; total: number }>;
/** Copy-on-write clone. Resolves false when the filesystem cannot clone this pair. */
export type CloneFile = (source: string, target: string, signal: AbortSignal) => Promise<boolean>;
export interface SnapshotScratchOptions {
  policy?: { [K in keyof SnapshotPolicy]?: SnapshotPolicy[K] | undefined };
  freeSpace?: FreeSpaceProbe;
  clone?: CloneFile;
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

/** Another snapshot owns the single scratch slot. The caller retries on a later scan. */
export class SnapshotBusy extends Error {
  constructor() {
    super("Another saved-history database snapshot is in progress; retrying later");
  }
}
/** Lenient refusal: the source stays unread and the reason is surfaced as a scan notice. */
export class SnapshotRefused extends Error {}

export interface SnapshotStage {
  readonly dir: string;
  clone(source: string, target: string, signal: AbortSignal): Promise<boolean>;
  /** Refuse before writing when the copy is over the cap or would starve the disk. */
  reserve(bytes: number): Promise<void>;
  release(): Promise<void>;
}

const systemFreeSpace: FreeSpaceProbe = async (path) => {
  const info = await statfs(path);
  return { available: info.bavail * info.bsize, total: info.blocks * info.bsize };
};
const systemClone: CloneFile = (source, target, signal) => {
  const command =
    process.platform === "darwin"
      ? { file: "/bin/cp", args: ["-c", source, target] }
      : process.platform === "linux"
        ? { file: "cp", args: ["--reflink=always", source, target] }
        : undefined;
  if (!command) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(command.file, command.args, { signal, timeout: 60_000 }, (error) => {
      if (!error) resolve(true);
      // A failed clone may leave an empty target; the streamed copy recreates it exclusively.
      else
        void rm(target, { force: true }).then(
          () => resolve(false),
          () => resolve(false),
        );
    });
  });
};
function systemAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
const gib = (bytes: number) =>
  bytes >= GiB ? `${(bytes / GiB).toFixed(1)} GB` : `${Math.ceil(bytes / 1024 ** 2)} MB`;

/**
 * Owns `<root>/sqlite-read-<pid>-*` stages. One snapshot exists at a time per owner, and
 * stages left by dead processes or earlier workers of this process are swept.
 */
export class SnapshotScratch {
  readonly root: string;
  private policy: SnapshotPolicy;
  private freeSpace: FreeSpaceProbe;
  private cloneFile: CloneFile;
  private pid: number;
  private isAlive: (pid: number) => boolean;
  private held = false;
  constructor(root: string, options: SnapshotScratchOptions = {}) {
    this.root = root;
    const policy = options.policy ?? {};
    this.policy = {
      maxCopyBytes: policy.maxCopyBytes ?? defaultSnapshotPolicy.maxCopyBytes,
      minFreeBytes: policy.minFreeBytes ?? defaultSnapshotPolicy.minFreeBytes,
      minFreeRatio: policy.minFreeRatio ?? defaultSnapshotPolicy.minFreeRatio,
    };
    this.freeSpace = options.freeSpace ?? systemFreeSpace;
    this.cloneFile = options.clone ?? systemClone;
    this.pid = options.pid ?? process.pid;
    this.isAlive = options.isAlive ?? systemAlive;
  }
  /** Remove stages no live snapshot can own. Call at startup and while holding the slot. */
  async sweep(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
      throw error;
    }
    let removed = 0;
    for (const name of names) {
      if (!name.startsWith(PREFIX)) continue;
      const pid = Number(/^sqlite-read-(\d+)-/.exec(name)?.[1] ?? Number.NaN);
      // Our own pid cannot own a stage here: the slot is free or held by the caller.
      if (Number.isSafeInteger(pid) && pid !== this.pid && this.isAlive(pid)) continue;
      const path = join(this.root, name);
      if (!(await lstat(path)).isDirectory()) continue;
      await rm(path, { recursive: true, force: true });
      removed++;
    }
    return removed;
  }
  async acquire(signal: AbortSignal): Promise<SnapshotStage> {
    signal.throwIfAborted();
    if (this.held) throw new SnapshotBusy();
    this.held = true;
    let dir: string | undefined;
    try {
      await this.sweep();
      signal.throwIfAborted();
      dir = await mkdtemp(join(this.root, `${PREFIX}${this.pid}-`));
    } catch (error) {
      if (dir) await rm(dir, { recursive: true, force: true });
      this.held = false;
      throw error;
    }
    return this.stage(dir);
  }
  private stage(dir: string): SnapshotStage {
    let released: Promise<void> | undefined;
    return {
      dir,
      clone: (source, target, signal) => this.cloneFile(source, target, signal),
      reserve: async (bytes) => {
        if (bytes > this.policy.maxCopyBytes)
          throw new SnapshotRefused(
            `Saved history skipped a provider database: reading it needs ${gib(bytes)} of scratch space, above the ${gib(this.policy.maxCopyBytes)} snapshot limit`,
          );
        const { available, total } = await this.freeSpace(this.root);
        const margin = Math.max(this.policy.minFreeBytes, this.policy.minFreeRatio * total);
        if (available - bytes < margin)
          throw new SnapshotRefused(
            `Saved history skipped a provider database: reading it needs ${gib(bytes)} of scratch space and would leave less than ${gib(margin)} free`,
          );
      },
      release: () => {
        released ??= rm(dir, { recursive: true, force: true }).finally(() => {
          this.held = false;
        });
        return released;
      },
    };
  }
}
