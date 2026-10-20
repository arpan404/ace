import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** The slice of Electron the crash reporter needs; injected so it can be tested without it. */
export interface CrashReporterHost {
  setPath(name: "crashDumps", path: string): void;
  start(options: { uploadToServer: false; compress: boolean }): void;
}

/**
 * Starts Crashpad with every dump kept on this machine, under the app's data folder
 * (`<userData>/Crashpad`); nothing is ever uploaded. Call it before the app is ready: only
 * processes launched after it (the GPU and network service included) are covered.
 * Returns the dump folder.
 */
export function startCrashReporter(host: CrashReporterHost, userData: string): string {
  const directory = join(userData, "Crashpad");
  host.setPath("crashDumps", directory);
  host.start({ uploadToServer: false, compress: false });
  return directory;
}

/** Crashpad's database keeps a dump in `new`, then `pending`, then `completed`. */
const STAGES = ["completed", "pending", "new", ""];

/** Minidumps in Crashpad's folder modified at or after `since`, newest first. */
export async function crashDumps(directory: string, since: number): Promise<string[]> {
  const found: Array<{ path: string; modified: number }> = [];
  for (const stage of STAGES) {
    const folder = join(directory, stage);
    const names = await readdir(folder).catch(() => []);
    for (const name of names) {
      if (!name.endsWith(".dmp")) continue;
      const path = join(folder, name);
      const modified = await stat(path).then(
        (info) => info.mtimeMs,
        () => -1,
      );
      if (modified >= since) found.push({ path, modified });
    }
  }
  return found.toSorted((a, b) => b.modified - a.modified).map((dump) => dump.path);
}
