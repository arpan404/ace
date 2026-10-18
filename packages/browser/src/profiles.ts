import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * ace's one browser profile, shared by every thread (ADR 0083), and per-session artifact
 * directories (downloads, logs) grouped by thread, so a deleted thread's go with it. Never the
 * person's own browser directory, nor their own Downloads folder.
 */
export class BrowserProfiles {
  private root: string;
  constructor(dataDir: string) {
    this.root = join(dataDir, "browser");
  }
  /** A thread's folder of session directories; its id is hashed, never trusted as a path. */
  private threadDir(threadId: string): string {
    const name = createHash("sha256").update(threadId).digest("hex").slice(0, 32);
    return join(this.root, "threads", name);
  }
  async acquire(threadId: string) {
    const parent = this.threadDir(threadId);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(parent, "session-"));
    try {
      const downloadDir = join(dir, "downloads");
      await mkdir(downloadDir, { mode: 0o700 });
      return {
        dir,
        downloadDir,
        root: this.root,
        profile: join(this.root, "profile"),
        // Failed startup has no published artifacts; retain successful session files only.
        discard: () => rm(dir, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }
  /** The thread was deleted: its session directories go, downloads and logs included. */
  async forget(threadId: string): Promise<void> {
    await rm(this.threadDir(threadId), { recursive: true, force: true });
  }
}
