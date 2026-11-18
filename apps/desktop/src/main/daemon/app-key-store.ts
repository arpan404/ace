import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appKeyPair, type AppKeyPair } from "@ace/service/app-signature";
import { z } from "zod";
import type { SecretBox } from "../secure-storage.ts";

const Raw = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Stored = z.record(z.string().min(1).max(256), z.object({ x: Raw, d: Raw }));

/**
 * The app's key pair for each daemon home it adopts (ADR 0178 §12.8), by that home's host id.
 * The file holds only what `box` encrypted with the OS keychain's key; when the keychain can't
 * do that (Linux's `basic_text` fallback, no keyring), no key is made or kept, and the app's
 * page stays a host-token socket there, as before.
 */
export function appKeyStore(
  directory: string,
  box: SecretBox,
  /** 32 random bytes for a new key: randomness comes from the caller. */
  seed: () => Uint8Array,
) {
  const path = join(directory, "daemon-app-keys.enc");
  let queue: Promise<unknown> = Promise.resolve();
  async function read(): Promise<Record<string, AppKeyPair>> {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success) return {};
      throw error;
    }
    return Stored.parse(JSON.parse(box.decrypt(bytes)));
  }
  async function write(entries: Record<string, AppKeyPair>): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // One write at a time (`queue`), so one temporary name is enough.
    const temporary = `${path}.tmp`;
    await writeFile(temporary, box.encrypt(JSON.stringify(entries)), { mode: 0o600 });
    await rename(temporary, path);
  }
  return {
    /** The key pair for `hostId`, made and kept on first use; undefined without a keychain. */
    pair(hostId: string): Promise<AppKeyPair | undefined> {
      const run = queue.then(async () => {
        if (!box.available()) return undefined;
        const entries = await read().catch(() => ({}) as Record<string, AppKeyPair>);
        const kept = entries[hostId];
        if (kept) return kept;
        const made = appKeyPair(seed());
        await write({ ...entries, [hostId]: made });
        return made;
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}

export type AppKeyStore = ReturnType<typeof appKeyStore>;
