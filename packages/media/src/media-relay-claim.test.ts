import { expect, test } from "vitest";
import { MediaConnections, MediaIssue, ticketTtlMs, type MediaOwner } from "./media-connections.ts";

// A relay stream's hello presents its media.connect ticket to the daemon (D2): the daemon checks
// it against what it minted, once, for the same device and admission kind.

function harness() {
  let byte = 0;
  return harnessWith((length) => new Uint8Array(length).fill(++byte));
}

function harnessWith(randomBytes: (length: number) => Uint8Array) {
  let now = 1_000_000;
  const connections = new MediaConnections({
    port: {
      send: () => true,
      revoke: () => Promise.resolve("answered"),
      directPort: () => 41_000,
      need: () => () => {},
      sleep: () => Promise.resolve(),
    },
    issue: new MediaIssue(),
    now: () => now,
    randomBytes,
    id: () => "id",
  });
  return { connections, advance: (ms: number) => void (now += ms) };
}

const phone: MediaOwner = {
  session: "phone-session",
  device: "phone",
  admission: { kind: "pairing", generation: "g1" },
};

async function ticket(connections: MediaConnections, owner = phone) {
  const result = await connections.connect(owner);
  if (!result.ok) throw new Error(result.code);
  return result;
}

test("a ticket opens its relay connection once, for its own device, with a fresh issue number", async () => {
  const { connections } = harness();
  const minted = await ticket(connections);
  const first = connections.claimRelay(minted.ticket, { device: "phone", admission: "pairing" });
  expect(first).toMatchObject({ connection: minted.connection, owner: phone });
  expect(first?.issued).toBeGreaterThan(1);
  expect(connections.claimRelay(minted.ticket, { device: "phone", admission: "pairing" })).toBe(
    undefined,
  );
});

test("a ticket presented by another device, or under another admission kind, is burnt", async () => {
  const { connections } = harness();
  const stolen = await ticket(connections);
  expect(connections.claimRelay(stolen.ticket, { device: "tablet", admission: "pairing" })).toBe(
    undefined,
  );
  // Burnt: its own device can't use it after that either.
  expect(connections.claimRelay(stolen.ticket, { device: "phone", admission: "pairing" })).toBe(
    undefined,
  );
  const other = await ticket(connections);
  expect(connections.claimRelay(other.ticket, { device: "phone", admission: "account" })).toBe(
    undefined,
  );
});

test("an expired ticket, a closed session's, a revoked device's or a malformed one opens nothing", async () => {
  const { connections, advance } = harness();
  const late = await ticket(connections);
  advance(ticketTtlMs);
  expect(connections.claimRelay(late.ticket, { device: "phone", admission: "pairing" })).toBe(
    undefined,
  );
  const closed = await ticket(connections);
  await connections.sessionClosed(phone.session);
  expect(connections.claimRelay(closed.ticket, { device: "phone", admission: "pairing" })).toBe(
    undefined,
  );
  const revoked = await ticket(connections, { ...phone, session: "s2" });
  await connections.revoke("phone");
  expect(connections.claimRelay(revoked.ticket, { device: "phone", admission: "pairing" })).toBe(
    undefined,
  );
  expect(connections.claimRelay("A".repeat(42), { device: "phone", admission: "pairing" })).toBe(
    undefined,
  );
});

test("a ticket a client already used directly can't open a relay connection too", async () => {
  const { connections } = harness();
  const minted = await ticket(connections);
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

test("an all-zero ticket is never a relay ticket, and presenting one burns nothing", async () => {
  const { connections } = harness();
  const minted = await ticket(connections);
  const zeros = Buffer.alloc(32).toString("base64url");
  expect(connections.claimRelay(zeros, { device: "phone", admission: "pairing" })).toBe(undefined);
  // The real ticket still opens its connection.
  expect(
    connections.claimRelay(minted.ticket, { device: "phone", admission: "pairing" }),
  ).toMatchObject({
    connection: minted.connection,
  });
});

test("a ticket wiped to zeros before it was minted is never redeemable on the relay", async () => {
  const { connections } = harnessWith(() => new Uint8Array(32));
  const result = await connections.connect(phone);
  const zeros = Buffer.alloc(32).toString("base64url");
  if (result.ok) expect(result.ticket).toBe(zeros);
  expect(connections.claimRelay(zeros, { device: "phone", admission: "pairing" })).toBe(undefined);
});
