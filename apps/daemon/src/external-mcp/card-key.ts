/*
 * The machine's key for signing its A2A Agent Card (ADR 0202 §6): P-256, made on first use and
 * kept in the data directory beside the daemon's other keys, readable by its user only. It
 * signs the card and nothing else.
 *
 * The key is read again whenever its file changes (another file in its place, or new
 * contents), so a rotation reaches the card and the public JWK set without a restart; `rotate`
 * replaces it atomically and `reload` reads it again at once.
 */
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { cardKey, type CardKey } from "./card-signature.ts";

const fileName = "a2a-card-key.pem";

function isExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function freshPem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return String(privateKey.export({ type: "pkcs8", format: "pem" }));
}

function read(path: string): CardKey {
  chmodSync(path, 0o600);
  const key = createPrivateKey(readFileSync(path, "utf8"));
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("Invalid A2A card key file");
  return cardKey(key);
}

/** What says the file changed: another file in its place, or new contents. */
function version(path: string): string {
  const stat = statSync(path, { bigint: true });
  return `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
}

export interface CardKeys {
  /** The key in the file now, read again only when the file changed since it was last read. */
  current(): CardKey;
  /** Reads the file again now. */
  reload(): CardKey;
  /** Replaces the key with a new one, atomically, and answers it. */
  rotate(): CardKey;
}

/** This machine's card key in `dataDir`, made the first time it is asked for. */
export function cardKeys(dataDir: string): CardKeys {
  const path = join(dataDir, fileName);
  let loaded: { key: CardKey; version: string } | undefined;
  const reload = (): CardKey => {
    try {
      writeFileSync(path, freshPem(), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!isExists(error)) throw error;
    }
    const seen = version(path);
    const key = read(path);
    loaded = { key, version: seen };
    return key;
  };
  return {
    current: () => {
      try {
        if (loaded?.version === version(path)) return loaded.key;
      } catch {
        // Gone: made again below.
      }
      return reload();
    },
    reload,
    rotate: () => {
      const next = `${path}.next`;
      writeFileSync(next, freshPem(), { mode: 0o600 });
      renameSync(next, path);
      return reload();
    },
  };
}
