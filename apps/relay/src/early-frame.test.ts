import { expect, it } from "vitest";
import { hostId, keyPair } from "@ace/secure-channel";
import { EARLY_FRAME, RelayRoutes } from "./index.ts";

// The early frame (ADR 0155, step 1): a client may send its first handshake message before its
// host joins, and the relay holds that one frame. These check the shared routing policy both
// relays run: what may be reserved, when it is released, and what is forwarded.

const host = () => hostId(keyPair().publicKey);
const ticket = (n: number) => n.toString(16).padStart(64, "0");

function waiting(routes: RelayRoutes, id: string, n: number) {
  const reserved = routes.reserveEarly(`client-${n}`, id);
  routes.request(`client-${n}`, id, ticket(n), 0);
  return reserved;
}

it("one host gets at most 16 held frames; another host still gets its own", () => {
  const routes = new RelayRoutes({ ticketTimeoutMs: 10_000 });
  const first = host();
  const second = host();
  routes.register("owner-1", first);
  routes.register("owner-2", second);
  const granted = Array.from({ length: 17 }, (_, n) => waiting(routes, first, n));
  expect(granted.filter(Boolean)).toHaveLength(EARLY_FRAME.hostFrames);
  expect(granted.at(-1)).toBe(false);
  expect(waiting(routes, second, 100)).toBe(true);
  // 16 frames of at most 65,535 bytes fit the host's 1 MiB.
  expect(EARLY_FRAME.hostFrames * EARLY_FRAME.frameBytes).toBeLessThanOrEqual(
    EARLY_FRAME.hostBytes,
  );
});

it("the whole relay holds at most 256 frames, whichever hosts they wait for", () => {
  const routes = new RelayRoutes({ ticketTimeoutMs: 10_000 });
  let granted = 0;
  for (let h = 0; h < 17; h++) {
    const id = host();
    routes.register(`owner-${h}`, id);
    for (let n = 0; n < 16; n++) if (waiting(routes, id, h * 100 + n)) granted++;
  }
  expect(granted).toBe(EARLY_FRAME.relayFrames);
});

it("nothing is reserved for a host that isn't registered", () => {
  const routes = new RelayRoutes({ ticketTimeoutMs: 10_000 });
  expect(routes.reserveEarly("client", host())).toBe(false);
});

it("an early frame is held once; a second one, a frame too large or one never reserved closes", () => {
  const routes = new RelayRoutes({ ticketTimeoutMs: 10_000 });
  const id = host();
  routes.register("owner", id);
  waiting(routes, id, 1);
  expect(routes.early("client-1", 1_000)).toEqual([]);
  expect(routes.earlyState("client-1")).toBe("held");
  expect(routes.early("client-1", 10)).toEqual([
    { type: "close", socket: "client-1", code: 1008, reason: "Stream not paired" },
  ]);
  waiting(routes, id, 2);
  expect(routes.early("client-2", EARLY_FRAME.frameBytes + 1)).toEqual([
    { type: "close", socket: "client-2", code: 1008, reason: "Stream not paired" },
  ]);
  // A client that didn't reserve (an older client, or the relay had no room) is closed as today.
  routes.request("client-3", id, ticket(3), 0);
  expect(routes.early("client-3", 10)).toEqual([
    { type: "close", socket: "client-3", code: 1008, reason: "Stream not paired" },
  ]);
});

it("pairing says a frame is held, so it is forwarded to the joining host and to no other", () => {
  const routes = new RelayRoutes({ ticketTimeoutMs: 10_000 });
  const id = host();
  routes.register("owner", id);
  waiting(routes, id, 1);
  waiting(routes, id, 2);
  routes.early("client-1", 100);
  expect(routes.join("join-1", ticket(1), 1)).toEqual([
    { type: "pair", client: "client-1", host: "join-1", early: true },
  ]);
  // Reserved but nothing sent yet: an ordinary pairing.
  expect(routes.join("join-2", ticket(2), 1)).toEqual([
    { type: "pair", client: "client-2", host: "join-2" },
  ]);
});

it("a client closed by expiry, replacement or rejection keeps its room until its socket is gone", () => {
  const routes = new RelayRoutes({ ticketTimeoutMs: 100 });
  const id = host();
  routes.register("owner", id);
  const fill = (from: number) =>
    Array.from({ length: 16 }, (_, n) => waiting(routes, id, from + n)).every(Boolean);
  expect(fill(0)).toBe(true);
  for (let n = 0; n < 16; n++) routes.early(`client-${n}`, EARLY_FRAME.frameBytes);
  expect(routes.earlyHeld(id)).toEqual({
    reserved: 16,
    frames: 16,
    bytes: 16 * EARLY_FRAME.frameBytes,
  });
  expect(routes.earlyHeld(id).bytes).toBeLessThanOrEqual(EARLY_FRAME.hostBytes);
  // Expiry closes them, but their bytes may still sit in their sockets: nothing is freed yet.
  const expired = routes.sweep(200);
  expect(expired).toHaveLength(16);
  expect(routes.reserveEarly("extra", id)).toBe(false);
  expect(routes.earlyHeld(id).bytes).toBe(16 * EARLY_FRAME.frameBytes);
  // As each socket is really gone, its room comes back, and only then.
  for (let n = 0; n < 8; n++) routes.close(`client-${n}`);
  expect(routes.earlyHeld(id)).toEqual({
    reserved: 8,
    frames: 8,
    bytes: 8 * EARLY_FRAME.frameBytes,
  });
  for (let n = 0; n < 8; n++) expect(routes.reserveEarly(`next-${n}`, id)).toBe(true);
  expect(routes.reserveEarly("extra", id)).toBe(false);
  for (let n = 8; n < 16; n++) routes.close(`client-${n}`);
  for (let n = 0; n < 8; n++) routes.close(`next-${n}`);
  expect(routes.earlyHeld(id)).toEqual({ reserved: 0, frames: 0, bytes: 0 });
  // A newer registration closes the old one's clients; they keep counting for the host id.
  expect(fill(100)).toBe(true);
  routes.register("owner-again", id);
  expect(routes.reserveEarly("extra", id)).toBe(false);
  for (let n = 100; n < 116; n++) routes.close(`client-${n}`);
  expect(fill(200)).toBe(true);
  // A rejection by the host, likewise, until that socket is gone.
  routes.reject("owner-again", ticket(200));
  expect(routes.reserveEarly("a", id)).toBe(false);
  routes.close("client-200");
  expect(routes.reserveEarly("a", id)).toBe(true);
  // An upgrade that never completed gives its reservation back at once.
  routes.releaseEarly("a");
  expect(routes.reserveEarly("b", id)).toBe(true);
});

it("a paired frame keeps its room until it has been forwarded", () => {
  const routes = new RelayRoutes({ ticketTimeoutMs: 10_000 });
  const id = host();
  routes.register("owner", id);
  waiting(routes, id, 1);
  routes.early("client-1", 500);
  routes.join("join-1", ticket(1), 1);
  expect(routes.earlyHeld(id)).toEqual({ reserved: 1, frames: 1, bytes: 500 });
  routes.releaseEarly("client-1");
  expect(routes.earlyHeld(id)).toEqual({ reserved: 0, frames: 0, bytes: 0 });
});

it("after hibernation, reservations are rebuilt and a held frame that was lost closes its client", () => {
  const routes = new RelayRoutes({ ticketTimeoutMs: 10_000 });
  const id = host();
  const pending = Array.from({ length: 16 }, (_, n) => ({
    ticket: ticket(n),
    client: `client-${n}`,
    owner: "owner",
    expires: 10_000,
    early: n === 0 ? ("held" as const) : ("reserved" as const),
  }));
  expect(routes.restore([{ socket: "owner", hostId: id }], pending)).toEqual([
    { type: "close", socket: "client-0", code: EARLY_FRAME.lostClose, reason: "Early frame lost" },
  ]);
  // The 15 reservations still count; the lost one was given back.
  expect(routes.reserveEarly("new", id)).toBe(true);
  expect(routes.reserveEarly("another", id)).toBe(false);
  // A reserved client whose frame arrives after waking is held as usual.
  expect(routes.early("client-1", 50)).toEqual([]);
});
