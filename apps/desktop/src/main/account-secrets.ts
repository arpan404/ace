import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { safeStorage } from "electron";
import { z } from "zod";
import { savedOriginKey, sessionsByCurrentOrigin } from "./account-origins.ts";

const available = () =>
  safeStorage.isEncryptionAvailable() &&
  (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text");

/** A single encrypted credential file. Linux's plaintext fallback is refused. */
export function accountSecrets(directory: string) {
  const path = join(directory, "ace-account.enc");
  let queue: Promise<unknown> = Promise.resolve();
  async function read() {
    if (!available()) throw new Error("Secure account storage is unavailable");
    try {
      const bytes = await readFile(path);
      const data: unknown = JSON.parse(safeStorage.decryptString(bytes));
      const saved = z.record(z.string(), z.string().regex(/^[A-Za-z0-9_-]{43}$/)).parse(data);
      // Sessions saved under ace's former address; the next write stores them under the current one.
      return sessionsByCurrentOrigin(saved);
    } catch (error) {
      const missing = z.object({ code: z.literal("ENOENT") }).safeParse(error);
      if (missing.success) return {};
      throw new Error("Couldn't read your ace account session", { cause: error });
    }
  }
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  }
  return {
    read(origin: string) {
      return serial(async () => (await read())[savedOriginKey(origin)] ?? null);
    },
    /** Every saved session, by account origin. */
    all(): Promise<Readonly<Record<string, string>>> {
      return serial(read);
    },
    write(origin: string, token: string | null) {
      return serial(async () => {
        const entries = await read();
        if (token) entries[savedOriginKey(origin)] = token;
        else delete entries[savedOriginKey(origin)];
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}`;
        await writeFile(temporary, safeStorage.encryptString(JSON.stringify(entries)), {
          mode: 0o600,
        });
        await rename(temporary, path);
      });
    },
  };
}
