import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isAppStandingText } from "@ace/client/standing";
import { z } from "zod";
import { savedOriginKey } from "./account-origins.ts";

/*
 * The person's standing key for this app (ADR 0190, amendment 1): one P-256 key per account
 * backend, made here the first time a window proves the owner's grant, and kept encrypted with
 * `safeStorage`, whose key the OS keychain holds (bound to this signed app on macOS). Windows ask
 * main to sign a socket's challenge with it; the private half never leaves this process, and
 * main signs nothing but an app-standing challenge. Signing out forgets it.
 */

/** What `safeStorage` does for this store; Electron's in the app, a stand-in in tests. */
export interface Sealer {
  available(): boolean;
  seal(text: string): Buffer;
  open(bytes: Buffer): string;
}

const Saved = z.record(
  z.string(),
  z.object({ account: z.string().min(1).max(256), key: z.string().min(1).max(512) }),
);
type Saved = z.infer<typeof Saved>;

const encode = (bytes: Buffer) => bytes.toString("base64url");

/** The uncompressed P-256 point of a PKCS#8 private key's public half, base64url. */
function publicPoint(pkcs8: string): string {
  const jwk = createPrivateKey({
    key: Buffer.from(pkcs8, "base64url"),
    format: "der",
    type: "pkcs8",
  }).export({ format: "jwk" });
  const x = Buffer.from(jwk.x ?? "", "base64url");
  const y = Buffer.from(jwk.y ?? "", "base64url");
  return encode(Buffer.concat([Buffer.from([4]), x, y]));
}

export function standingKeys(directory: string, sealer: Sealer) {
  const path = join(directory, "ace-standing-key.enc");
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  };
  async function read(): Promise<Saved> {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success) return {};
      throw new Error("Couldn't read this app's standing key", { cause: error });
    }
    if (!sealer.available()) throw new Error("Secure storage is unavailable");
    // A file this app can't open (another install's, or damaged) holds nothing; a new key replaces it.
    try {
      return Saved.parse(JSON.parse(sealer.open(bytes)));
    } catch {
      return {};
    }
  }
  async function write(saved: Saved): Promise<void> {
    if (!Object.keys(saved).length) {
      await rm(path, { force: true });
      return;
    }
    // Never written in the clear.
    if (!sealer.available()) throw new Error("Secure storage is unavailable");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}`;
    await writeFile(temporary, sealer.seal(JSON.stringify(saved)), { mode: 0o600 });
    await rename(temporary, path);
  }
  return {
    /**
     * The public half of `account`'s key at `origin`, made now when there is none or it is
     * another account's (a different account signed in: the old key goes).
     */
    key(origin: string, account: string): Promise<string> {
      return serial(async () => {
        const saved = await read();
        const slot = savedOriginKey(origin);
        const held = saved[slot];
        if (held?.account === account) return publicPoint(held.key);
        const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
        const key = encode(privateKey.export({ format: "der", type: "pkcs8" }));
        saved[slot] = { account, key };
        await write(saved);
        return publicPoint(key);
      });
    },
    /**
     * `account`'s key at `origin` signing `text`, an app-standing challenge and nothing else: its
     * public half and the signature (P1363, base64url), or null without a key for that account.
     */
    sign(
      origin: string,
      account: string,
      text: string,
    ): Promise<{ key: string; proof: string } | null> {
      if (!isAppStandingText(text)) return Promise.reject(new Error("Not a standing challenge"));
      return serial(async () => {
        const held = (await read())[savedOriginKey(origin)];
        if (held?.account !== account) return null;
        const privateKey = createPrivateKey({
          key: Buffer.from(held.key, "base64url"),
          format: "der",
          type: "pkcs8",
        });
        const proof = sign("sha256", Buffer.from(text, "utf8"), {
          key: privateKey,
          dsaEncoding: "ieee-p1363",
        });
        return { key: publicPoint(held.key), proof: encode(proof) };
      });
    },
    /** Signing out of `origin`: its key is gone, so no window proves with it again. */
    forget(origin: string): Promise<void> {
      return serial(async () => {
        let saved: Saved;
        try {
          saved = await read();
        } catch {
          // Unreadable here: nothing in it can be kept, so none of it can sign again.
          await rm(path, { force: true });
          return;
        }
        if (!saved[savedOriginKey(origin)]) return;
        delete saved[savedOriginKey(origin)];
        await write(saved);
      });
    },
  };
}
export type StandingKeys = ReturnType<typeof standingKeys>;
