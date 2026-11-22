import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deviceKeyId, readStatement } from "@ace/account-grant/person-statement";
import { z } from "zod";
import { savedOriginKey } from "./account-origins.ts";

/*
 * This device's key for the person's statements (ADR 0190, amendment 1): one P-256 key pair per
 * account backend, made when the person enrolls it after a browser sign-in, kept sealed with
 * `safeStorage` (the OS keychain; on macOS bound to ace's signed app). Its public half is what a
 * verifier registers: the local daemon today, the person's ace account later. The private half
 * never leaves this process, and it signs only a person's statement for its own account and
 * device. It is bound to the session it was enrolled under: another sign-in, or signing out,
 * ends it.
 */

/** What `safeStorage` does for this store; Electron's in the app, a stand-in in tests. */
export interface Sealer {
  available(): boolean;
  seal(text: string): Buffer;
  open(bytes: Buffer): string;
}

const Held = z.object({
  account: z.string().min(1).max(256),
  /** The SHA-256 of the session the key was enrolled under: another session's never uses it. */
  session: z.string().regex(/^[0-9a-f]{64}$/),
  key: z.string().min(1).max(512),
});
const Saved = z.record(z.string(), Held);
type Saved = z.infer<typeof Saved>;

/** The digest a key is bound to: a session token's SHA-256, never the token itself. */
export const sessionDigest = (token: string) => createHash("sha256").update(token).digest("hex");

/** The uncompressed P-256 point of a PKCS#8 private key's public half, base64url. */
function publicPoint(pkcs8: string): string {
  const jwk = createPrivateKey({
    key: Buffer.from(pkcs8, "base64url"),
    format: "der",
    type: "pkcs8",
  }).export({ format: "jwk" });
  const x = Buffer.from(jwk.x ?? "", "base64url");
  const y = Buffer.from(jwk.y ?? "", "base64url");
  return Buffer.concat([Buffer.from([4]), x, y]).toString("base64url");
}

export interface DeviceKey {
  account: string;
  session: string;
  /** The public half, an uncompressed P-256 point, base64url. */
  publicKey: string;
  /** Its id in statements (`deviceKeyId`). */
  id: string;
}

/** What a kept key is, as callers see it: never its private half. */
async function described(held: z.infer<typeof Held>): Promise<DeviceKey> {
  const publicKey = publicPoint(held.key);
  return {
    account: held.account,
    session: held.session,
    publicKey,
    id: await deviceKeyId(publicKey),
  };
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
      throw new Error("Couldn't read this device's key", { cause: error });
    }
    if (!sealer.available()) throw new Error("Secure storage is unavailable");
    // A file this app can't open (another install's, or damaged) holds nothing it can use.
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
    /** The key kept for `origin`, if any. */
    held(origin: string): Promise<DeviceKey | undefined> {
      return serial(async () => {
        const held = (await read())[savedOriginKey(origin)];
        return held ? described(held) : undefined;
      });
    },
    /** A new key for `account`'s session `session` at `origin`, replacing any kept there. */
    make(origin: string, account: string, session: string): Promise<DeviceKey> {
      return serial(async () => {
        const saved = await read();
        const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
        const key = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
        saved[savedOriginKey(origin)] = { account, session, key };
        await write(saved);
        return described({ account, session, key });
      });
    },
    /**
     * The key at `origin` signing `text`: a person's statement for this key's own account and
     * device, and nothing else (P1363, base64url). Null without a key.
     */
    sign(origin: string, text: string): Promise<string | null> {
      return serial(async () => {
        const held = (await read())[savedOriginKey(origin)];
        if (!held) return null;
        const statement = readStatement(text);
        const own = await described(held);
        if (!statement || statement.account !== own.account || statement.device !== own.id)
          throw new Error("Not this device's statement");
        const privateKey = createPrivateKey({
          key: Buffer.from(held.key, "base64url"),
          format: "der",
          type: "pkcs8",
        });
        return sign("sha256", Buffer.from(text, "utf8"), {
          key: privateKey,
          dsaEncoding: "ieee-p1363",
        }).toString("base64url");
      });
    },
    /** The key at `origin` is gone: nothing signs with it again. */
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
