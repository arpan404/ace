import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  timingSafeEqual,
} from "node:crypto";

/*
 * The desktop app's main process and its daemon (ADR 0190, amendment 1). Node only: both ends
 * run there. The daemon proves it holds the relay key main pinned: an HMAC keyed by the X25519
 * secret between that key and main's ephemeral one, over the whole challenge. Statements name the
 * sockets they prove by a digest of their tags and connection nonces, so their size never grows
 * with the number of sockets. Pure apart from key generation.
 */

/** How long after main made a tag the daemon takes it: a stale tag names no socket. */
export const TAG_FRESH_MS = 60_000;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** A fresh X25519 key pair, raw 32-byte halves. */
export function x25519Ephemeral(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" });
  return {
    privateKey: new Uint8Array(Buffer.from(jwk.d ?? "", "base64url")),
    publicKey: new Uint8Array(
      Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url"),
    ),
  };
}

/** The X25519 secret between a raw private key and a raw public key. */
export function x25519Shared(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const mine = createPrivateKey({
    key: { kty: "OKP", crv: "X25519", d: b64(privateKey), x: b64(x25519Public(privateKey)) },
    format: "jwk",
  });
  const theirs = createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: b64(publicKey) },
    format: "jwk",
  });
  return new Uint8Array(diffieHellman({ privateKey: mine, publicKey: theirs }));
}

/** The raw public half of a raw X25519 private key. */
export function x25519Public(privateKey: Uint8Array): Uint8Array {
  const key = createPrivateKey({
    key: Buffer.concat([
      // PKCS#8 prefix for an X25519 private key.
      Buffer.from("302e020100300506032b656e04220420", "hex"),
      Buffer.from(privateKey),
    ]),
    format: "der",
    type: "pkcs8",
  });
  return new Uint8Array(
    Buffer.from(createPublicKey(key).export({ format: "jwk" }).x ?? "", "base64url"),
  );
}

/** A tagged socket as a statement names it. */
export interface TaggedSocket {
  tag: string;
  connection: string;
}

/** The statement target for `sockets`: `sockets:<SHA-256 of their sorted tag~connection pairs>`. */
export function socketsTarget(sockets: readonly TaggedSocket[]): string {
  const lines = sockets.map((socket) => `${socket.tag}~${socket.connection}`).toSorted();
  return `sockets:${createHash("sha256").update(lines.join("\n")).digest("base64url")}`;
}

/** What the daemon's possession MAC covers: every field of the challenge main relies on. */
function possessionText(challenge: {
  nonce: string;
  host: string;
  owner: string | null;
  sockets: readonly TaggedSocket[];
}): string {
  return [
    "ace-app-possession/v1",
    challenge.nonce,
    challenge.host,
    challenge.owner ?? "",
    socketsTarget(challenge.sockets),
  ].join("\n");
}

/** The daemon's proof that it holds the relay key: HMAC-SHA256 keyed by the X25519 secret. */
export function possessionMac(
  shared: Uint8Array,
  challenge: Parameters<typeof possessionText>[0],
): string {
  return createHmac("sha256", shared).update(possessionText(challenge)).digest("base64url");
}

/** Whether `mac` is the daemon's possession proof for `challenge` under `shared`. */
export function possessionHolds(
  shared: Uint8Array,
  challenge: Parameters<typeof possessionText>[0],
  mac: string,
): boolean {
  const expected = Buffer.from(possessionMac(shared, challenge));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * The action a fresh-sign-in grant names to enroll a device key (ADR 0190, amendment 1): this
 * daemon, this key and the challenge's single-use nonce, so it enrolls nothing else.
 */
export function enrollAction(input: { host: string; device: string; nonce: string }): string {
  return `ace-enroll-device/v1 ${input.host} ${input.device} ${input.nonce}`;
}

/** A new tag main puts on one socket upgrade: when it was made, and 32 random bytes. */
export function appSocketTag(now: number, random: Uint8Array): string {
  return `${String(now).padStart(13, "0")}.${b64(random)}`;
}

/** Whether `tag` was made within `TAG_FRESH_MS` of `now`. */
export function tagFresh(tag: string, now: number): boolean {
  const made = Number(tag.slice(0, 13));
  return Number.isSafeInteger(made) && Math.abs(now - made) <= TAG_FRESH_MS;
}
