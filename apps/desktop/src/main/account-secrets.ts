import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

/** The OS-backed encryption `safeStorage` gives the app; injected for tests. */
export interface SecretCipher {
  /** False where only plaintext storage exists (Linux's `basic_text`): refused, never used. */
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(bytes: Buffer): string;
}

/** Electron's `safeStorage`. Linux's plaintext fallback counts as unavailable. */
export async function electronCipher(): Promise<SecretCipher> {
  const { safeStorage } = await import("electron");
  return {
    available: () =>
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (bytes) => safeStorage.decryptString(bytes),
  };
}

const Sessions = z.record(z.string(), z.string().regex(/^[A-Za-z0-9_-]{43}$/));

/**
 * A single encrypted credential file. A file this app can't decrypt (one written under another
 * keychain identity, such as a development app's before it had its own) reads as an error, so
 * the person is asked to sign in again; the next sign-in keeps that file beside the new one as
 * `ace-account.unreadable-<id>.enc` and never overwrites or deletes it.
 */
export function accountSecrets(directory: string, cipher: () => Promise<SecretCipher>) {
  const path = join(directory, "ace-account.enc");
  let queue: Promise<unknown> = Promise.resolve();
  async function load(): Promise<
    { kind: "read"; sessions: Record<string, string> } | { kind: "unreadable"; cause: unknown }
  > {
    const secrets = await cipher();
    if (!secrets.available()) throw new Error("Secure account storage is unavailable");
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success)
        return { kind: "read", sessions: {} };
      throw new Error("Couldn't read your ace account session", { cause: error });
    }
    try {
      return { kind: "read", sessions: Sessions.parse(JSON.parse(secrets.decrypt(bytes))) };
    } catch (cause) {
      return { kind: "unreadable", cause };
    }
  }
  async function read() {
    const loaded = await load();
    if (loaded.kind === "unreadable")
      throw new Error("Couldn't read your ace account session", { cause: loaded.cause });
    return loaded.sessions;
  }
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  }
  return {
    read(origin: string) {
      return serial(async () => (await read())[origin] ?? null);
    },
    /** Every saved session, by account origin. */
    all(): Promise<Readonly<Record<string, string>>> {
      return serial(read);
    },
    write(origin: string, token: string | null) {
      return serial(async () => {
        const loaded = await load();
        const entries = loaded.kind === "read" ? loaded.sessions : {};
        if (token) entries[origin] = token;
        else delete entries[origin];
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (loaded.kind === "unreadable")
          await rename(path, join(directory, `ace-account.unreadable-${randomUUID()}.enc`));
        const secrets = await cipher();
        const temporary = `${path}.${randomUUID()}`;
        await writeFile(temporary, secrets.encrypt(JSON.stringify(entries)), { mode: 0o600 });
        await rename(temporary, path);
      });
    },
  };
}
