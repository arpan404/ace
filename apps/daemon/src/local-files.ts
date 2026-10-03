import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The data directory holds every transcript, tool output and credential, so only its owner may
 * enter it. mkdir's mode does not apply to a directory that already exists (for example one a
 * legacy install created with 0755), so the mode is enforced here, before any store opens.
 */
export function secureDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dataDir);
  if (stat.isSymbolicLink())
    throw new Error(`Refusing data directory ${dataDir}: it is a symbolic link`);
  if (!stat.isDirectory()) throw new Error(`Refusing data directory ${dataDir}: not a directory`);
  // Windows has no POSIX owner or mode bits; its profile ACLs protect the directory.
  const uid = process.getuid?.();
  if (uid === undefined) return;
  if (stat.uid !== uid)
    throw new Error(`Refusing data directory ${dataDir}: it is owned by another user`);
  if ((stat.mode & 0o077) !== 0) chmodSync(dataDir, 0o700);
}
export function acquireLock(dataDir: string): () => void {
  secureDataDir(dataDir);
  const path = join(dataDir, "daemon-lock");
  const owner = JSON.stringify({ pid: process.pid, id: randomUUID() });
  // A separate SQLite connection holds the OS lock for the daemon lifetime.
  // Kernel locks disappear on crash; the lock database must never be unlinked.
  const lock = new DatabaseSync(join(dataDir, "daemon-lock.sqlite"));
  try {
    lock.exec(
      "PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (pid INTEGER)",
    );
    writeFileSync(path, owner, { mode: 0o600 });
  } catch (error) {
    lock.close();
    throw new Error(`Cannot acquire daemon lock in ${dataDir}. Another daemon owns it.`, {
      cause: error,
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (readFileSync(path, "utf8") === owner) unlinkSync(path);
    } finally {
      lock.close();
    }
  };
}
export function loadToken(dataDir: string): { token: string; tokenPath: string } {
  const tokenPath = join(dataDir, "daemon-token");
  try {
    writeFileSync(tokenPath, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isExists(error)) throw error;
  }
  chmodSync(tokenPath, 0o600);
  const token = readFileSync(tokenPath, "utf8");
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("Invalid daemon token file");
  return { token, tokenPath };
}
export function loadHostId(dataDir: string): string {
  const path = join(dataDir, "host-id");
  try {
    writeFileSync(path, randomUUID(), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isExists(error)) throw error;
  }
  return readFileSync(path, "utf8");
}
function isExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
export function validToken(actual: string, expected: string): boolean {
  // Hash-sized buffers always take the same comparison path, even for wrong lengths.
  const actualBytes = Buffer.alloc(64);
  const input = Buffer.from(actual);
  input.copy(actualBytes, 0, 0, 64);
  return timingSafeEqual(actualBytes, Buffer.from(expected)) && input.length === 64;
}
