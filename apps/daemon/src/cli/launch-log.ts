import { renameSync, statSync } from "node:fs";

/**
 * `ace open` hands the detached daemon this file for stdout and stderr. The daemon writes
 * only startup lines and crash traces there (diagnostics go to the capped log sink), so a
 * check at each launch bounds it: once the file reaches a quarter of the cap it becomes the
 * single `.1` segment, replacing the previous one. While one run writes less than a quarter
 * of the cap, the file and its segment stay within the cap together.
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
