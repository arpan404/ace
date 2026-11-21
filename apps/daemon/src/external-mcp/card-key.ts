/*
 * The machine's key for signing its A2A Agent Card (ADR 0202 §6): P-256, made on first use and
 * kept in the data directory beside the daemon's other keys, readable by its user only. It
 * signs the card and nothing else.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { cardKey, type CardKey } from "./card-signature.ts";

const fileName = "a2a-card-key.pem";

function isExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/** This machine's card key, made the first time. */
export function loadCardKey(dataDir: string): CardKey {
  const path = join(dataDir, fileName);
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
  const key = createPrivateKey(readFileSync(path, "utf8"));
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("Invalid A2A card key file");
  return cardKey(key);
}
