import { backup as nodeBackup, type DatabaseSync } from "node:sqlite";

type BackupPath = Parameters<typeof nodeBackup>[1];
type BackupOptions = Parameters<typeof nodeBackup>[2];

// How long a finished backup may wait for its promise to settle.
const WAKE_MS = 10;

/**
 * `node:sqlite`'s `backup()`, settling as soon as the copy finishes.
 *
 * Before Node 26.9 (nodejs/node#65666), the copy's final step resolves the promise
 * outside a callback scope, so `await backup()` only resumes when some unrelated
 * callback runs. In a process kept alive by an idle server, IPC channel or long timer,
 * that is seconds, minutes or never. A short timer runs that callback while the copy
 * is in flight. Remove this once every supported runtime is 26.9 or later.
 */
export async function backup(
  source: DatabaseSync,
  path: BackupPath,
  options?: BackupOptions,
): Promise<number> {
  const wake = setInterval(() => {}, WAKE_MS);
  try {
    // Node rejects an explicit undefined options argument.
    return await (options ? nodeBackup(source, path, options) : nodeBackup(source, path));
  } finally {
    clearInterval(wake);
  }
}
