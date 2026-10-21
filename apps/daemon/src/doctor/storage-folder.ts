import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_LOG_MAX_BYTES } from "@ace/diagnostics/log-policy";
import { SettingsService } from "@ace/settings";
import type { DoctorContext } from "./feature.ts";

export type DatabaseFile = {
  name: string;
  bytes: number;
  /** The write-ahead log beside it, which holds changes not yet folded in. */
  walBytes: number;
};

/** The data folder's top level, sorted into what doctor reports on. */
export type DataFolder = {
  /** Largest first. */
  databases: DatabaseFile[];
  folders: string[];
  /** Plain files that are neither databases, their companions nor backups. */
  otherFileBytes: number;
};

const COMPANION = /-(wal|shm|journal)$/;
const BACKUP = /\.backup(\.partial)?$/;

async function size(path: string): Promise<number> {
  return lstat(path).then(
    (stat) => (stat.isFile() ? stat.size : 0),
    () => 0,
  );
}

/** Reads the top level of the data folder. A missing folder reads as empty. */
export async function readDataFolder(dataDir: string): Promise<DataFolder> {
  const entries = await readdir(dataDir, { withFileTypes: true }).catch(() => []);
  const names = new Set(entries.map((entry) => entry.name));
  const databases: DatabaseFile[] = [];
  const folders: string[] = [];
  let otherFileBytes = 0;
  for (const entry of entries) {
    const path = join(dataDir, entry.name);
    if (entry.isDirectory()) folders.push(entry.name);
    else if (entry.name.endsWith(".sqlite"))
      databases.push({
        name: entry.name,
        bytes: await size(path),
        walBytes: names.has(`${entry.name}-wal`) ? await size(`${path}-wal`) : 0,
      });
    else if (BACKUP.test(entry.name)) continue;
    else if (COMPANION.test(entry.name) && names.has(entry.name.replace(COMPANION, ""))) continue;
    else otherFileBytes += await size(path);
  }
  return {
    databases: databases.toSorted((a, b) => b.bytes + b.walBytes - (a.bytes + a.walBytes)),
    folders: folders.toSorted(),
    otherFileBytes,
  };
}

/**
 * The log cap the daemon applies: the environment's, else the saved `logs.maxBytes`, else the
 * default. Read from the settings file, so it works while the daemon is down.
 */
export async function logCap(context: DoctorContext): Promise<number> {
  const overrides = context.config.settingsOverrides;
  const settings = new SettingsService({
    dataDir: context.config.dataDir,
    ...(overrides ? { overrides } : {}),
  });
  try {
    return (await settings.get("logs.maxBytes")).value;
  } catch {
    return overrides?.["logs.maxBytes"] ?? DEFAULT_LOG_MAX_BYTES;
  } finally {
    await settings.close().catch(() => {});
  }
}
