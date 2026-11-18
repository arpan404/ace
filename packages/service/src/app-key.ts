import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * The desktop app's key for the daemon it starts (ADR 0178 §12.8). The app makes a fresh key
 * for each daemon it spawns and writes it on that daemon's stdin, then closes it; the key is
 * never in a file, an argument or the environment, so a process that reads ACE_HOME (a coding
 * agent) never sees it. The app's page proves it holds the key in its hello, bound to the port
 * it dialled, and the daemon then knows the socket is the app's and not the host token alone.
 * Pure, apart from Node's HMAC.
 */

/** Set to {@link appKeyOnStdin} by the app: `ace start` reads one key line from stdin. */
export const appKeyEnv = "ACE_APP_KEY";
export const appKeyOnStdin = "stdin";

/** The most stdin bytes `ace start` reads for the key line. */
export const appKeyLineLimit = 128;

const KeyLine = /^([0-9a-f]{64})\r?\n?$/;

/** The line the app writes: the key as lowercase hex, then a newline. */
export function appKeyLine(key: Uint8Array): string {
  if (key.length !== 32) throw new Error("An app key is 32 bytes");
  return `${Buffer.from(key).toString("hex")}\n`;
}

/** The key in what the daemon read from stdin, or undefined for anything else. */
export function parseAppKeyLine(text: string): Uint8Array | undefined {
  const match = KeyLine.exec(text);
  return match?.[1] ? new Uint8Array(Buffer.from(match[1], "hex")) : undefined;
}

/**
 * The page's proof for a socket to the daemon listening on `port`: the base64url HMAC-SHA256
 * of `ace-app/v1\n<port>` keyed by the app key. Bound to the port, so a proof a process
 * collects by listening at another address is worth nothing at the daemon's.
 */
export function appSocketProof(key: Uint8Array, port: number): string {
  return createHmac("sha256", key).update(`ace-app/v1\n${port}`).digest("base64url");
}

/** Whether `proof` is the app's for a socket that reached this daemon on `port`. */
export function appSocketProven(key: Uint8Array, port: number, proof: string): boolean {
  const given = Buffer.from(proof, "base64url");
  const expected = Buffer.from(appSocketProof(key, port), "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
