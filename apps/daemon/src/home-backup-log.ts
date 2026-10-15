import { describeBackup, type PreparedHome } from "@ace/service";
import { logFields } from "@ace/diagnostics";
import type { openDaemonLog } from "./daemon-log.ts";

type Log = Pick<Awaited<ReturnType<typeof openDaemonLog>>, "log">;

/**
 * After a fresh start, off the startup path: leaves the README in the backup, measures it, and
 * records where the old data went in `ace.jsonl`. Aborting (shutdown) stops the measuring.
 */
export async function logHomeBackup(
  prepared: Extract<PreparedHome, { state: "fresh" }>,
  log: Log,
  at: Date,
  signal: AbortSignal,
): Promise<void> {
  const fields = [
    ["backup", prepared.backup],
    ["previousFormat", prepared.previousFormat],
  ] as const;
  try {
    const { bytes } = await describeBackup(
      { backup: prepared.backup, home: prepared.root, previousFormat: prepared.previousFormat, at },
      signal,
    );
    log.log(
      "info",
      "Started with a fresh data home; the old data was backed up",
      logFields([...fields, ["bytes", bytes]]),
    );
  } catch (error) {
    if (signal.aborted) return;
    log.log(
      "warn",
      "Started with a fresh data home; the old data was backed up",
      logFields([...fields, ["error", error instanceof Error ? error.message : String(error)]]),
    );
  }
}
