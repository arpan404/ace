import { lstat, opendir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HOME_FORMAT_VERSION, formatName } from "./home-format.ts";

export const BACKUP_README = "BACKUP-README.txt";

function code(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

/** The note left in a backup: what it is, that nothing reads it, and that it is safe to delete. */
export function backupReadme(input: {
  backup: string;
  home: string;
  previousFormat: string;
  at: Date;
}): string {
  const previous =
    input.previousFormat === formatName(0)
      ? "an earlier ace build that did not record a data format"
      : `data format ${input.previousFormat}`;
  return [
    "This folder is a backup of ace's data.",
    "",
    `On ${input.at.toISOString()} ace started with a fresh data home in ${input.home}, in data format ${formatName(HOME_FORMAT_VERSION)}. This folder was that home before, written by ${previous}. ace renamed it here instead of migrating it: nothing in it was changed or deleted, and ace never reads it again.`,
    "",
    "To keep something from it, copy it out by hand. ace never deletes this folder; delete it yourself once you no longer need it.",
    "",
  ].join("\n");
}

/** Bytes under `path`, without following links. Stops early once `signal` aborts. */
export async function directorySize(path: string, signal?: AbortSignal): Promise<number> {
  const stats = await lstat(path);
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  const pending = [path];
  while (pending.length > 0) {
    signal?.throwIfAborted();
    const directory = pending.pop();
    if (directory === undefined) break;
    let entries;
    try {
      entries = await opendir(directory);
    } catch (error) {
      // Unreadable or vanished folders count as empty; the size is a hint, not a ledger.
      if (["EACCES", "EPERM", "ENOENT", "ENOTDIR"].includes(String(code(error)))) continue;
      throw error;
    }
    for await (const entry of entries) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else
        total += await lstat(child).then(
          (stat) => stat.size,
          () => 0,
        );
    }
  }
  return total;
}

/**
 * The follow-up to a fresh start, off the startup path: leaves `BACKUP-README.txt` in the
 * backup (never replacing a file of that name) and measures it. Returns its size in bytes.
 */
export async function describeBackup(
  input: { backup: string; home: string; previousFormat: string; at: Date },
  signal?: AbortSignal,
): Promise<{ bytes: number }> {
  try {
    if ((await lstat(input.backup)).isDirectory())
      await writeFile(join(input.backup, BACKUP_README), backupReadme(input), {
        flag: "wx",
        mode: 0o600,
      });
  } catch (error) {
    if (code(error) !== "EEXIST") throw error;
  }
  return { bytes: await directorySize(input.backup, signal) };
}
