import { expect, it } from "vitest";
import { hostId, keyPair } from "@ace/secure-channel";
import { EARLY_FRAME, RelayRoutes } from "./index.ts";

// The early frame (ADR 0155, step 1): a client may send its first handshake message before its
// host joins, and the relay holds that one frame. These check the shared routing policy both
// relays run: what may be reserved, when it is released, and what is forwarded.

const host = () => hostId(keyPair().publicKey);
const ticket = (n: number) => n.toString(16).padStart(64, "0");

function waiting(routes: RelayRoutes, id: string, owner: string, n: number) {
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
  const granted = Array.from({ length: 17 }, (_, n) => waiting(routes, first, "owner-1", n));
  expect(granted.filter(Boolean)).toHaveLength(EARLY_FRAME.hostFrames);
  expect(granted.at(-1)).toBe(false);
  expect(waiting(routes, second, "owner-2", 100)).toBe(true);
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
    for (let n = 0; n < 16; n++) if (waiting(routes, id, `owner-${h}`, h * 100 + n)) granted++;
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
  waiting(routes, id, "owner", 1);
  expect(routes.early("client-1", 1_000)).toEqual([]);
  expect(routes.earlyState("client-1")).toBe("held");
  expect(routes.early("client-1", 10)).toEqual([
    { type: "close", socket: "client-1", code: 1008, reason: "Stream not paired" },
  ]);
  waiting(routes, id, "owner", 2);
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
  waiting(routes, id, "owner", 1);
  waiting(routes, id, "owner", 2);
  routes.early("client-1", 100);
  expect(routes.join("join-1", ticket(1), 1)).toEqual([
    { type: "pair", client: "client-1", host: "join-1", early: true },
  ]);
  // Reserved but nothing sent yet: an ordinary pairing.
  expect(routes.join("join-2", ticket(2), 1)).toEqual([
    { type: "pair", client: "client-2", host: "join-2" },
  ]);
});

it("expiry, replacement, rejection and disconnect each give the reservation back", () => {
  const routes = new RelayRoutes({ ticketTimeoutMs: 100 });
  const id = host();
  routes.register("owner", id);
  const fill = (from: number) =>
    Array.from({ length: 16 }, (_, n) => waiting(routes, id, "owner", from + n)).every(Boolean);
  expect(fill(0)).toBe(true);
  expect(routes.reserveEarly("extra", id)).toBe(false);
  // Expiry.
  routes.sweep(200);
  expect(routes.earlyState("client-0")).toBeUndefined();
  expect(fill(100)).toBe(true);
  // Replacement: a newer registration closes every client the old one was offered.
  routes.register("owner-again", id);
  expect(routes.earlyState("client-100")).toBeUndefined();
  expect(fill(200)).toBe(true);
  // Rejection by the host, and the client's own disconnect.
  routes.reject("owner-again", ticket(200));
  routes.close("client-201");
  expect(routes.reserveEarly("a", id)).toBe(true);
  expect(routes.reserveEarly("b", id)).toBe(true);
  expect(routes.reserveEarly("c", id)).toBe(false);
  // An upgrade that never completed gives its reservation back too.
  routes.releaseEarly("b");
  expect(routes.reserveEarly("c", id)).toBe(true);
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
