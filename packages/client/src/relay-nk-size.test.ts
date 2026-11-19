import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { signGrant } from "@ace/account-grant";
import { NoiseNK, keyPair } from "@ace/secure-channel";
import { connectPortableRelay, type PortableSocket } from "./portable-relay.ts";
import { RELAY_EARLY } from "./relay-early.ts";
import { earlyFlight } from "./relay-nk.ts";

// How large an NK first message is (ADR 0155, steps 2 and 3), and what the client offers when
// it doesn't fit the upgrade entry: neither upgrade entry, so it goes whole as the early frame.

const hello = (credential: Record<string, string>) =>
  JSON.stringify({
    type: "hello",
    protocolVersion: 1,
    deviceId: randomUUID(),
    installId: randomUUID(),
    trims: [
      "item-defaults",
      "provider-capabilities",
      "spade-hidden",
      "raw-on-demand",
      "storage-hold",
    ],
    framing: ["lines", "short-deltas"],
    compression: ["deflate-raw"],
    flowControl: ["credit"],
    ...credential,
  });
const subscribes = [
  ...Array.from({ length: 4 }, () =>
    JSON.stringify({
      type: "subscribe",
      subscriptionId: randomUUID(),
      scope: { kind: "thread", threadId: randomUUID() },
      afterSeq: 1_234_567,
      paced: true,
      tail: { items: 40, bytes: 65_536 },
    }),
  ),
  ...Array.from({ length: 2 }, () =>
    JSON.stringify({
      type: "subscribe",
      subscriptionId: randomUUID(),
      scope: { kind: "threads", window: { limit: 20, project: randomUUID(), archived: false } },
      paced: true,
    }),
  ),
];
const grant = signGrant(
  { kind: "device", account: `user_${randomUUID()}`, subject: randomUUID(), iat: 0, exp: 300_000 },
  { id: "k1", privateKey: new Uint8Array(32).fill(1) },
);

/** The NK first message's entry for this first flight, as the client would build it. */
function entryFor(credential: { ticket?: string; grant?: string }, flight: string[]) {
  const converted = earlyFlight(flight, credential);
  if (!converted) throw new Error("Not an NK flight");
  const first = NoiseNK.initiator({
    remoteStatic: keyPair().publicKey,
    ephemeralKey: keyPair(),
  }).writeMessage(new TextEncoder().encode(JSON.stringify(converted.early)));
  return {
    bytes: first.length,
    entry: RELAY_EARLY.nkMessagePrefix.length + Math.ceil((first.length * 4) / 3),
  };
}

it("with a ticket, or a grant, and every allowed subscribe, an NK first message fits its entry", () => {
  const ticket = entryFor({ ticket: "ab".repeat(32) }, [hello({ token: "t" }), ...subscribes]);
  const granted = entryFor({ grant }, [hello({ grant }), ...subscribes]);
  // Measured: 1,574 bytes with a ticket (a 2,106-character entry), 1,807 with a grant (2,417).
  expect(ticket.entry).toBeLessThan(RELAY_EARLY.entryBytes);
  expect(granted.entry).toBeLessThan(RELAY_EARLY.entryBytes);
  expect(ticket.bytes).toBeGreaterThan(900);
  expect(granted.bytes).toBeGreaterThan(ticket.bytes);
});

/** The subprotocols a dial offers, from a socket that never opens. */
async function offered(early: Uint8Array, grantEntry?: string): Promise<string[]> {
  let seen: string[] = [];
  const socket = (_url: string, protocols?: string[]): PortableSocket => {
    seen = protocols ?? [];
    const listeners = new Map<string, ((event?: { code?: number }) => void)[]>();
    queueMicrotask(() => {
      for (const run of listeners.get("close") ?? []) run({ code: 1006 });
    });
    return {
      binaryType: "arraybuffer",
      bufferedAmount: 0,
      addEventListener(type: string, listener: (event?: { code?: number }) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      send() {},
      close() {},
    } as unknown as PortableSocket;
  };
  await connectPortableRelay({
    relayUrl: "wss://relay.invalid",
    pinnedFingerprint: "A".repeat(52),
    socket,
    keys: () => ({ staticKey: keyPair(), ephemeralKey: keyPair() }),
    schedule: () => () => {},
    early: true,
    inUpgrade: true,
    ...(grantEntry ? { grant: grantEntry } : {}),
    nk: { hostKey: keyPair().publicKey, early, confirm: new Uint8Array(2) },
  }).catch(() => undefined);
  return seen;
}

it("an NK message that fits goes in the upgrade beside XX's; one that doesn't is offered in neither", async () => {
  const fits = await offered(new Uint8Array(1_000).fill(97));
  expect(fits).toContain(RELAY_EARLY.nkInUpgrade);
  expect(fits).toContain(RELAY_EARLY.inUpgrade);
  const large = await offered(new Uint8Array(3_500).fill(97));
  expect(large).not.toContain(RELAY_EARLY.nkInUpgrade);
  expect(large).not.toContain(RELAY_EARLY.inUpgrade);
  expect(large.some((entry) => entry.startsWith(RELAY_EARLY.nkMessagePrefix))).toBe(false);
  // It still offers early sending: the whole message goes as the early frame.
  expect(large).toContain(RELAY_EARLY.subprotocol);
});
