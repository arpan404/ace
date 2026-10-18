import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * ace's one browser profile, shared by every thread (ADR 0083), and per-session artifact
 * directories. Never the person's own browser directory.
 */
export class BrowserProfiles {
  private root: string;
  constructor(dataDir: string) {
    this.root = join(dataDir, "browser");
  }
  async acquire() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(this.root, "session-"));
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
}
