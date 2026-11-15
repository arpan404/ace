/**
 * One early client frame (ADR 0155, step 1): a client that offers `subprotocol` and gets it
 * echoed in the upgrade answer may send its first frame at once instead of after the marker.
 * The relay reserves room for it before it accepts the upgrade, within these budgets, and
 * forwards it to the host right after pairing. A frame lost to the hosted relay's hibernation
 * closes its client with `lostClose`; the client then connects again without sending early.
 */
export const EARLY_FRAME = {
  subprotocol: "ace.early.1",
  /**
   * Echoed when the client may not send early and offered no grant: a client that offers a
   * subprotocol fails an upgrade answered with none, so a new relay always echoes one it was
   * offered. Only a client that knows the relay is new offers it.
   */
  neutral: "ace.relay.1",
  /**
   * A new client adds `early=1` to its `/client` address (older relays ignore it) and a new
   * relay answers with `capableMarker` instead of the marker: how a client without a grant
   * learns, from one connection, that it may offer `subprotocol` next time.
   */
  query: "early",
  capableMarker: 2,
  lostClose: 4020,
  /** One Noise message at most. */
  frameBytes: 65_535,
  hostFrames: 16,
  hostBytes: 1024 * 1024,
  relayFrames: 256,
  relayBytes: 16 * 1024 * 1024,
} as const;

/**
 * The first message in the upgrade request (ADR 0155, step 3). A client that may offer
 * `EARLY_FRAME.subprotocol` also offers `subprotocol` and one entry `prefix` + the message in
 * unpadded base64url. A relay that reserved room for an early frame takes the entry as the
 * client's first frame and echoes `subprotocol`; the client then never sends that message as a
 * frame. With no room the relay reads nothing of the entry and echoes as step 1 does. For XX the
 * message is the 32-byte ephemeral public key: 43 characters encoded, 50 with the prefix.
 */
export const UPGRADE_MESSAGE = {
  subprotocol: "ace.v2",
  prefix: "ace.x1.",
  /** The XX first message: the client's ephemeral public key, with no payload. */
  messageBytes: 32,
  /** Its canonical unpadded base64url length. */
  messageCharacters: 43,
  /** The longest entry, prefix included. */
  entryBytes: 4096,
  /** The longest `Sec-WebSocket-Protocol` header a relay takes the entry from. */
  headerBytes: 8192,
} as const;

/**
 * An NK first message in the upgrade request (ADR 0155, steps 2 and 3): `subprotocol` and one
 * entry `prefix` + the message in canonical unpadded base64url. Unlike XX's, it is ciphertext
 * (the early hello, sealed to the daemon's static key) of a bounded length: at least `minBytes`
 * (the ephemeral key and the tag), at most `maxBytes` (what fits in a 4 KiB entry). A relay that
 * knows only XX's entry ignores it, and a client whose message doesn't fit offers neither entry.
 */
export const NK_UPGRADE_MESSAGE = {
  subprotocol: "ace.v3",
  prefix: "ace.n1.",
  minBytes: 48,
  maxBytes: Math.floor(((UPGRADE_MESSAGE.entryBytes - "ace.n1.".length) * 3) / 4),
} as const;

/** One entry's message, canonical unpadded base64url of `min` to `max` bytes, or undefined. */
function decodeEntry(offered: string[], prefix: string, min: number, max: number) {
  const entries = offered.filter((entry) => entry.startsWith(prefix));
  const [entry] = entries;
  if (entries.length !== 1 || !entry || entry.length > UPGRADE_MESSAGE.entryBytes) return undefined;
  const encoded = entry.slice(prefix.length);
  if (!encoded.length || !/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
  const bytes = Uint8Array.from(Buffer.from(encoded, "base64url"));
  // Canonical only: the bytes encode back to the same text.
  if (bytes.length < min || bytes.length > max) return undefined;
  if (Buffer.from(bytes).toString("base64url") !== encoded) return undefined;
  return bytes;
}

/**
 * What a relay takes from an upgrade request as the client's first frame, and the subprotocol it
 * then echoes: an NK first message when one is offered by its rule, else an XX one, else
 * nothing. Called only after room is reserved, so an upgrade without room never has an entry
 * decoded.
 */
export function takenUpgradeMessage(
  header: string,
): { message: Uint8Array; echo: string } | undefined {
  if (header.length > UPGRADE_MESSAGE.headerBytes) return undefined;
  const offered = header.split(",").map((entry) => entry.trim());
  if (offered.includes(NK_UPGRADE_MESSAGE.subprotocol)) {
    const message = decodeEntry(
      offered,
      NK_UPGRADE_MESSAGE.prefix,
      NK_UPGRADE_MESSAGE.minBytes,
      NK_UPGRADE_MESSAGE.maxBytes,
    );
    if (message) return { message, echo: NK_UPGRADE_MESSAGE.subprotocol };
  }
  const message = upgradeMessage(header);
  return message ? { message, echo: UPGRADE_MESSAGE.subprotocol } : undefined;
}

/**
 * The first message an upgrade carries for the relay to take, or undefined: only when it offers
 * `UPGRADE_MESSAGE.subprotocol` and exactly one entry that can be an XX first message, 32 bytes
 * in canonical unpadded base64url (43 characters). Anything else is as if no entry were offered:
 * no `ace.v2`, nothing kept or forwarded. Called only after room is reserved, so an upgrade
 * without room never has its entry decoded.
 */
export function upgradeMessage(header: string): Uint8Array | undefined {
  if (header.length > UPGRADE_MESSAGE.headerBytes) return undefined;
  const offered = header.split(",").map((entry) => entry.trim());
  if (!offered.includes(UPGRADE_MESSAGE.subprotocol)) return undefined;
  const entries = offered.filter((entry) => entry.startsWith(UPGRADE_MESSAGE.prefix));
  const [entry] = entries;
  if (entries.length !== 1 || !entry || entry.length > UPGRADE_MESSAGE.entryBytes) return undefined;
  const encoded = entry.slice(UPGRADE_MESSAGE.prefix.length);
  if (encoded.length !== UPGRADE_MESSAGE.messageCharacters || !/^[A-Za-z0-9_-]+$/.test(encoded))
    return undefined;
  const bytes = Uint8Array.from(Buffer.from(encoded, "base64url"));
  // Canonical only: exactly the first message's length, encoding back to the same text.
  if (
    bytes.length !== UPGRADE_MESSAGE.messageBytes ||
    Buffer.from(bytes).toString("base64url") !== encoded
  )
    return undefined;
  return bytes;
}
