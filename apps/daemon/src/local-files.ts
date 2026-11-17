import {
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "@ace/provider-kit/sqlite";

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
/** Another daemon holds this data directory's lock (it may still be starting or stopping). */
export class DaemonLockHeldError extends Error {
  override name = "DaemonLockHeldError";
}
export function acquireLock(dataDir: string): () => void {
  secureDataDir(dataDir);
  const path = join(dataDir, "daemon-lock");
  const owner = JSON.stringify({ pid: process.pid, id: randomUUID() });
  // A separate SQLite connection holds the OS lock for the daemon lifetime.
  // Kernel locks disappear on crash; the lock database must never be unlinked.
  const lock = new DatabaseSync(join(dataDir, "daemon-lock.sqlite"));
  try {
    // The lock is the kernel's lock on this file; its journal is kept in memory, so taking it
    // creates no file and works on a full disk too (ADR 0174). The table is made once, ever.
    lock.exec(
      "PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (pid INTEGER)",
    );
  } catch (error) {
    lock.close();
    // Only a lock someone else holds is another daemon; anything else is said as it is.
    if (sqliteBusy(error))
      throw new DaemonLockHeldError(
        `Cannot acquire daemon lock in ${dataDir}. Another daemon owns it.`,
        { cause: error },
      );
    throw error;
  }
  try {
    writeFileSync(path, owner, { mode: 0o600 });
  } catch {
    // The name of the holder only (a full disk can refuse it). A stale one would name an old
    // pid, so it goes; readers take no file as no holder named.
    try {
      unlinkSync(path);
    } catch {
      /* None was there. */
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (readFileSync(path, "utf8") === owner) unlinkSync(path);
    } catch {
      /* Never written, or already gone. */
    } finally {
      lock.close();
    }
  };
}

/** SQLITE_BUSY or SQLITE_LOCKED: another connection holds the lock. */
function sqliteBusy(error: unknown): boolean {
  const code: unknown = error instanceof Error ? Reflect.get(error, "errcode") : undefined;
  return typeof code === "number" && ((code & 0xff) === 5 || (code & 0xff) === 6);
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
/**
 * The key a Suit's served URLs are signed with (ADR 0150), kept across daemon runs: a version of
 * a Suit then keeps one URL, so a client that reconnects or reloads keeps its running scene and
 * its cached files, and only an edit (a new content hash) gives it a new one. A missing or
 * damaged file gets a new key; the only cost is that clients load the Suit's files once more.
 */
export function loadSuitUrlKey(dataDir: string): Uint8Array {
  const path = join(dataDir, "suit-url-key");
  try {
    writeFileSync(path, freshKey(), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isExists(error)) throw error;
  }
  chmodSync(path, 0o600);
  let key = readFileSync(path, "utf8");
  if (!/^[0-9a-f]{64}$/.test(key)) {
    key = freshKey();
    writeFileSync(path, key, { mode: 0o600 });
  }
  return Buffer.from(key, "hex");
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
/**
 * This daemon's P-256 identity at the push gateway (ADR 0106), generated on first start. The
 * gateway binds each phone handle to it, so a leaked handle is useless without this key.
 */
export function loadPushKey(dataDir: string): string {
  const path = join(dataDir, "push-key.pem");
  try {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!isExists(error)) throw error;
  }
  chmodSync(path, 0o600);
  const pem = readFileSync(path, "utf8");
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch (error) {
    throw new Error("Invalid push signing key file", { cause: error });
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("Invalid push signing key file");
  return pem;
}
const freshKey = () => randomBytes(32).toString("hex");
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
