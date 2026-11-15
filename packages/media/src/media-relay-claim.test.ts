import { expect, test } from "vitest";
import { MediaConnections, MediaIssue, ticketTtlMs, type MediaOwner } from "./media-connections.ts";

// A relay stream's hello presents its media.connect ticket to the daemon (D2): the daemon checks
// it against what it minted, once, for the same device and admission kind.

function harness() {
  let now = 1_000_000;
  let byte = 0;
  const connections = new MediaConnections({
    port: {
      send: () => true,
      revoke: () => Promise.resolve("answered"),
      directPort: () => 41_000,
    },
    issue: new MediaIssue(),
    now: () => now,
    randomBytes: (length) => new Uint8Array(length).fill(++byte),
    id: () => "id",
  });
  return { connections, advance: (ms: number) => void (now += ms) };
}

const phone: MediaOwner = {
  session: "phone-session",
  device: "phone",
  admission: { kind: "pairing", generation: 1 },
};

function ticket(connections: MediaConnections, owner = phone) {
  const result = connections.connect(owner);
  if (!result.ok) throw new Error(result.code);
  return result;
}

test("a ticket opens its relay connection once, for its own device, with a fresh issue number", () => {
  const { connections } = harness();
  const minted = ticket(connections);
  const first = connections.claimRelay(minted.ticket, { device: "phone", admission: "pairing" });
  expect(first).toMatchObject({ connection: minted.connection, owner: phone });
  expect(first?.issued).toBeGreaterThan(1);
  expect(connections.claimRelay(minted.ticket, { device: "phone", admission: "pairing" })).toBe(
    undefined,
  );
});

test("a ticket presented by another device, or under another admission kind, is burnt", () => {
  const { connections } = harness();
  const stolen = ticket(connections);
  expect(connections.claimRelay(stolen.ticket, { device: "tablet", admission: "pairing" })).toBe(
    undefined,
  );
  // Burnt: its own device can't use it after that either.
  expect(connections.claimRelay(stolen.ticket, { device: "phone", admission: "pairing" })).toBe(
    undefined,
  );
  const other = ticket(connections);
  expect(connections.claimRelay(other.ticket, { device: "phone", admission: "account" })).toBe(
    undefined,
  );
});

test("an expired ticket, a closed session's, a revoked device's or a malformed one opens nothing", async () => {
  const { connections, advance } = harness();
  const late = ticket(connections);
  advance(ticketTtlMs);
  expect(connections.claimRelay(late.ticket, { device: "phone", admission: "pairing" })).toBe(
    undefined,
  );
  const closed = ticket(connections);
  await connections.sessionClosed(phone.session);
  expect(connections.claimRelay(closed.ticket, { device: "phone", admission: "pairing" })).toBe(
    undefined,
  );
  const revoked = ticket(connections, { ...phone, session: "s2" });
  await connections.revoke("phone");
  expect(connections.claimRelay(revoked.ticket, { device: "phone", admission: "pairing" })).toBe(
    undefined,
  );
  expect(connections.claimRelay("A".repeat(42), { device: "phone", admission: "pairing" })).toBe(
    undefined,
  );
});

test("a ticket a client already used directly can't open a relay connection too", () => {
  const { connections } = harness();
  const minted = ticket(connections);
  connections.received({
    type: "connection.open",
    connection: minted.connection,
    kind: "direct",
    owner: phone,
  });
  expect(connections.claimRelay(minted.ticket, { device: "phone", admission: "pairing" })).toBe(
    undefined,
  );
});
