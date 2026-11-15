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
