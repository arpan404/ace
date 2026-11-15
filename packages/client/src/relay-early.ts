/**
 * The relay's early-frame wire, as `@ace/relay` defines it (`EARLY_FRAME`; ADR 0155, step 1):
 * the subprotocol a client offers to send its first frame at once, the neutral one it adds
 * when it offers no grant (a relay must echo one it was offered), the query a new client sets
 * to learn whether the relay is new, the marker that says so, and the close for a held frame
 * the hosted relay lost to hibernation.
 */
export const RELAY_EARLY = {
  subprotocol: "ace.early.1",
  neutral: "ace.relay.1",
  query: "early",
  marker: 1,
  capableMarker: 2,
  lostClose: 4020,
} as const;
