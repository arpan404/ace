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
  /** The longest entry, prefix included. */
  entryBytes: 4096,
  /** The longest `Sec-WebSocket-Protocol` header a relay takes the entry from. */
  headerBytes: 8192,
} as const;

/**
 * The first message an upgrade carries for the relay to take, or undefined: only when it offers
 * `UPGRADE_MESSAGE.subprotocol` and exactly one entry within the size limits that decodes as
 * unpadded base64url. Called only after room is reserved, so an upgrade without room never has
 * its entry decoded.
 */
export function upgradeMessage(header: string): Uint8Array | undefined {
  if (header.length > UPGRADE_MESSAGE.headerBytes) return undefined;
  const offered = header.split(",").map((entry) => entry.trim());
  if (!offered.includes(UPGRADE_MESSAGE.subprotocol)) return undefined;
  const entries = offered.filter((entry) => entry.startsWith(UPGRADE_MESSAGE.prefix));
  const [entry] = entries;
  if (entries.length !== 1 || !entry || entry.length > UPGRADE_MESSAGE.entryBytes) return undefined;
  const encoded = entry.slice(UPGRADE_MESSAGE.prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) return undefined;
  const bytes = Uint8Array.from(Buffer.from(encoded, "base64url"));
  // Canonical only: the bytes must encode back to the same text.
  if (!bytes.length || Buffer.from(bytes).toString("base64url") !== encoded) return undefined;
  return bytes;
}
