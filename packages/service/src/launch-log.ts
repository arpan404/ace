import { openSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A daemon started detached (by `ace open`, or by the desktop app, which leaves it running when
 * it quits) writes its stdout and stderr here, in its home. Nothing reads that output live, and
 * no pipe to a parent can break under it.
 */
export const launchLogName = "daemon-start.log";

/**
 * The daemon writes only startup lines and crash traces to the launch log (diagnostics go to
 * the capped, redacted `logs/ace.jsonl`), so a check at each launch bounds it: once the file
 * reaches a quarter of the cap it becomes the single `.1` segment, replacing the previous one.
 * While one run writes less than a quarter of the cap, the file and its segment stay within the
 * cap together.
 */
export function rotateLaunchLog(path: string, maxBytes: number): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (size >= Math.floor(maxBytes / 4)) renameSync(path, `${path}.1`);
}

/**
 * Rotates `home`'s launch log and opens it for appending (owner-only), for a detached daemon's
 * stdout and stderr. The caller closes its copy of the descriptor once the daemon has it.
 */
export function openLaunchLog(home: string, maxBytes: number): number {
  const path = join(home, launchLogName);
  rotateLaunchLog(path, maxBytes);
  return openSync(path, "a", 0o600);
}
