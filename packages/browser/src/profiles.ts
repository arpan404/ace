import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserProfileScope } from "@ace/protocol";
import { projectProfileDir, scopedProfileDir, threadProfileDir } from "./profile-scope.ts";

/**
 * ace's kept browser profiles (ADR 0083: one shared by every thread by default, or one per
 * project or thread, by `browser.profileScope`), and per-session artifact directories
 * (downloads, logs) grouped by thread, so a deleted thread's go with it. Never the person's own
 * browser directory, nor their own Downloads folder.
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
  async acquire(threadId: string, profile: { scope: BrowserProfileScope; workspaceId: string }) {
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
        profile: scopedProfileDir(this.root, profile.scope, {
          threadId,
          workspaceId: profile.workspaceId,
        }),
        // Failed startup has no published artifacts; retain successful session files only.
        discard: () => rm(dir, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }
  /**
   * The thread was deleted: its session directories go, downloads and logs included, and its
   * own profile if it had one. ace's Chrome must have stopped using that profile.
   */
  async forget(threadId: string): Promise<void> {
    await rm(this.threadDir(threadId), { recursive: true, force: true });
    await removeProfile(threadProfileDir(this.root, threadId));
  }
  /** The project's own profile; the caller stops ace's Chrome in it before removing it. */
  projectProfile(workspaceId: string): string {
    return projectProfileDir(this.root, workspaceId);
  }
  threadProfile(threadId: string): string {
    return threadProfileDir(this.root, threadId);
  }
  /** The project was removed: its own profile goes. ace's Chrome must have stopped using it. */
  async forgetProject(workspaceId: string): Promise<void> {
    await removeProfile(projectProfileDir(this.root, workspaceId));
  }
}

/** A profile and the directories ace's Chrome keeps beside it (download staging, video). */
async function removeProfile(dir: string): Promise<void> {
  await Promise.all(
    [dir, `${dir}-downloads`, `${dir}-video-extension`].map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
}
