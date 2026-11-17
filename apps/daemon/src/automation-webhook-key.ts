import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { webhookSecretBox, type SecretBox } from "@ace/automations";

/** The key file, beside the stores and never inside them (ADR 0173, decision 11). */
export const webhookKeyName = "automation-webhooks.key";
const size = 32;
const posix = process.platform !== "win32";
/** Never through a symlink: the key must be this file, not one it points at. */
const noFollow = constants.O_NOFOLLOW ?? 0;
/** Never wait on the open: a FIFO left at the path would block the daemon until a writer came. */
const noBlock = constants.O_NONBLOCK ?? 0;

/**
 * The box both automation stores seal webhook secrets with. Its key is 32 random bytes in an
 * owner-only file. Opening a secret only reads the key: a missing one leaves secrets unreadable
 * until the person rotates them, never silently replaced. Sealing a new secret makes the key when
 * there is none. An existing key that isn't a regular file of exactly 32 bytes, owned by this
 * user and readable by no one else, is refused and left as it is.
 */
export function webhookSecrets(dataDir: string): SecretBox {
  const path = join(dataDir, webhookKeyName);
  return webhookSecretBox({
    load: () => load(path),
    create: () => {
      const key = randomBytes(size);
      let fd: number;
      try {
        fd = openSync(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
          0o600,
        );
      } catch (error) {
        // The other store made it first: use theirs.
        if (code(error) !== "EEXIST") throw error;
        const made = load(path);
        if (!made) throw new Error(`${webhookKeyName} vanished while being made`, { cause: error });
        return made;
      }
      try {
        if (posix) fchmodSync(fd, 0o600);
        writeSync(fd, key);
      } finally {
        closeSync(fd);
      }
      return new Uint8Array(key);
    },
  });
}

/** The key, undefined when there is none; throws when the file is there but unsafe. */
function load(path: string): Uint8Array | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | noFollow | noBlock);
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    // ELOOP: a symlink, refused by O_NOFOLLOW.
    throw new Error(`${webhookKeyName} can't be opened safely (${code(error) ?? "error"})`, {
      cause: error,
    });
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${webhookKeyName} isn't a regular file`);
    if (posix && (stat.mode & 0o077) !== 0)
      throw new Error(`${webhookKeyName} is readable by others; it must be mode 0600`);
    if (posix && process.getuid && stat.uid !== process.getuid())
      throw new Error(`${webhookKeyName} belongs to another user`);
    if (stat.size !== size) throw new Error(`${webhookKeyName} isn't a ${size}-byte key`);
    const key = Buffer.alloc(size);
    if (readSync(fd, key, 0, size, 0) !== size)
      throw new Error(`${webhookKeyName} isn't a ${size}-byte key`);
    return new Uint8Array(key);
  } finally {
    closeSync(fd);
  }
}

function code(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
