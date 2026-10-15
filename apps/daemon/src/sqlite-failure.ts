import { statfsSync } from "node:fs";
import { logError, logFields } from "@ace/diagnostics";

/** Free space of the volume holding a path: Node's statfs fields, injected in tests. */
export type DiskSpace = (path: string) => { bavail: number | bigint; bsize: number | bigint };
export const systemDiskSpace: DiskSpace = (path) => statfsSync(path);

const codes = new Map([
  [13, "SQLITE_FULL"],
  [14, "SQLITE_CANTOPEN"],
]);
const messages = new Map([
  ["database or disk is full", "SQLITE_FULL"],
  ["unable to open database file", "SQLITE_CANTOPEN"],
]);

/** SQLITE_FULL or SQLITE_CANTOPEN anywhere in an error's cause chain, else undefined. */
export function sqliteStorageFailure(error: unknown): string | undefined {
  for (let cause = error, depth = 0; cause instanceof Error && depth < 5; depth++) {
    const errcode: unknown = Reflect.get(cause, "errcode");
    // node:sqlite reports extended result codes; the primary code is the low byte.
    if (typeof errcode === "number" && codes.has(errcode & 0xff)) return codes.get(errcode & 0xff);
    const errstr: unknown = Reflect.get(cause, "errstr");
    for (const text of [errstr, cause.message])
      if (typeof text === "string" && messages.has(text)) return messages.get(text);
    cause = cause.cause;
  }
  return undefined;
}

/**
 * Log fields for a storage failure the user can act on: the SQLite code and the free bytes
 * on the volume holding ACE_HOME (null when the volume cannot be read either). Undefined
 * for any other error.
 */
export function sqliteFailureDetails(
  error: unknown,
  home: string,
  diskSpace: DiskSpace = systemDiskSpace,
): (readonly [string, unknown])[] | undefined {
  const code = sqliteStorageFailure(error);
  if (code === undefined) return undefined;
  let freeBytes: number | null = null;
  try {
    const volume = diskSpace(home);
    freeBytes = Number(BigInt(volume.bavail) * BigInt(volume.bsize));
  } catch {
    freeBytes = null;
  }
  return [
    ["sqlite", code],
    ["freeBytes", freeBytes],
    ["dataDir", home],
  ];
}

interface FailureLog {
  log(level: "error", message: string, data?: unknown): void;
}

/**
 * Records a failed background task (maintenance, discovery, cleanup) without rethrowing, so
 * one failed pass never stops the daemon. Storage failures carry their code and free space.
 */
export function logBackgroundFailure(
  log: FailureLog,
  message: string,
  error: unknown,
  home: string,
  diskSpace: DiskSpace = systemDiskSpace,
): void {
  const details = sqliteFailureDetails(error, home, diskSpace);
  log.log(
    "error",
    message,
    details ? logFields([["error", logError(error)], ...details]) : logError(error),
  );
}
