import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserOpen } from "@ace/protocol";

/** Owned profiles never resolve to a user's personal browser directory. */
export class BrowserProfiles {
  private leases = new Set<string>();
  private root: string;
  constructor(dataDir: string) {
    this.root = join(dataDir, "browser");
  }
  private persistentDir(workspaceId: string, threadId: string): string {
    const key = createHash("sha256").update(`${workspaceId}:${threadId}`).digest("hex");
    return join(this.root, "profiles", key);
  }
  /** The thread was deleted: its persistent profile goes too, unless a session holds it. */
  async forget(workspaceId: string, threadId: string): Promise<void> {
    const profile = this.persistentDir(workspaceId, threadId);
    if (this.leases.has(profile)) throw new Error("Browser profile is still in use");
    await rm(profile, { recursive: true, force: true });
  }
  async acquire(options: BrowserOpen) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const persistent = options.profile === "persistent";
    const profile = persistent
      ? this.persistentDir(options.workspaceId, options.threadId)
      : await mkdtemp(join(this.root, "ephemeral-"));
    if (this.leases.has(profile)) throw new Error("Workspace browser profile is already in use");
    this.leases.add(profile);
    let dir: string | undefined;
    try {
      await mkdir(profile, { recursive: true, mode: 0o700 });
      dir = await mkdtemp(join(this.root, "session-"));
      const sessionDir = dir;
      const downloadDir = join(sessionDir, "downloads");
      await mkdir(downloadDir, { mode: 0o700 });
      return {
        dir,
        downloadDir,
        root: this.root,
        profile,
        // Failed startup has no published artifacts; retain successful session files only.
        discard: () => rm(sessionDir, { recursive: true, force: true }),
        release: async () => {
          this.leases.delete(profile);
          if (!persistent) await rm(profile, { recursive: true, force: true });
        },
      };
    } catch (error) {
      this.leases.delete(profile);
      if (!persistent) await rm(profile, { recursive: true, force: true });
      if (dir) await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }
}
