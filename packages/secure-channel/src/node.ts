import { constants } from "node:fs";
import { mkdir, open, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { keyPair } from "./crypto.ts";
import type { KeyPair } from "./crypto.ts";
/** Atomic publication avoids exposing partially written keys to concurrent starts. */
export async function loadOrCreateHostKeys(dataDir: string): Promise<KeyPair> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, "noise-static.key");
  const temporary = join(dataDir, `.noise-${randomUUID()}`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(keyPair().privateKey);
    await file.sync();
    await file.close();
    try {
      await link(temporary, path);
      const directory = await open(dataDir, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  } finally {
    await file.close();
    await unlink(temporary);
  }
  const stored = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await stored.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600)
      throw new Error("Static key must be a regular file with mode 0600");
    const bytes = await stored.readFile();
    if (bytes.length !== 32) throw new Error("Invalid stored static key");
    return keyPair(bytes);
  } finally {
    await stored.close();
  }
}
