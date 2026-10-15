import { describeBackup } from "@ace/service/home";
import type { Log } from "../log/desktop-log.ts";
import type { DaemonTarget } from "./target.ts";

/**
 * After the app gave the daemon home a fresh start, off the launch path: leaves the README in
 * the backup, measures it, and records where the old data went in the desktop log.
 */
export async function logFreshStart(target: DaemonTarget, log: Log, at: Date): Promise<void> {
  if (target.kind !== "managed" || !target.fresh) return;
  const { backup, previousFormat } = target.fresh;
  const message = "Started with a fresh data home; the old data was backed up";
  try {
    const { bytes } = await describeBackup({ backup, home: target.home, previousFormat, at });
    log("info", message, { home: target.home, backup, previousFormat, bytes });
  } catch (error) {
    log("warn", message, {
      home: target.home,
      backup,
      previousFormat,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
