import { afterEach, expect, it, vi } from "vitest";
import { keyPair } from "@ace/secure-channel";
import { startRelay } from "./server.ts";
import { FrameReader } from "./socket.ts";
import { EARLY_FRAME, NK_UPGRADE_MESSAGE, UPGRADE_MESSAGE } from "./wire.ts";
import { Offer, address, json, openPeer, register } from "./testing/peer.ts";

// The client's first message in its upgrade request (ADR 0155, step 3), at the self-hosted
// relay over real sockets: taken only with room reserved, delivered to the joining host once
// and first, and otherwise left unread as step 1 leaves it.

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const entry = (bytes: Uint8Array) =>
  UPGRADE_MESSAGE.prefix + Buffer.from(bytes).toString("base64url");
const first = new Uint8Array(32).map((_, i) => i + 1);

async function relayWithHost(limits: { ticketTimeoutMs?: number } = {}) {
  const relay = await startRelay({ limits });
  cleanups.push(() => relay.close());
  const keys = keyPair();
  const daemon = await register(relay.url, keys);
  cleanups.push(() => daemon.close());
  const offer = async () =>
    Offer.parse(json(daemon.transport.receive.decrypt(await daemon.next()))).ticket;
  /** A new client that may send early, offering `message` in its upgrade. */
  const client = async (message?: Uint8Array, extra: string[] = []) => {
    const opened = await openPeer(
      address(relay.url, "/client", { hostId: daemon.hostId, [EARLY_FRAME.query]: "1" }),
      [
        ...(message ? [UPGRADE_MESSAGE.subprotocol, entry(message)] : []),
        EARLY_FRAME.subprotocol,
        EARLY_FRAME.neutral,
        ...extra,
      ],
    );
    cleanups.push(() => opened.close());
    return opened;
  };
  const join = async (ticket: string) => {
    const joined = await openPeer(address(relay.url, "/join", { ticket }));
    cleanups.push(() => joined.close());
    return joined;
  };
  return { relay, keys, daemon, offer, client, join };
}

/** Resolves once `check` holds, looking every 10 ms; the test's timeout is the only limit. */
async function eventually(check: () => boolean): Promise<void> {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 10));
}

const within = (next: Promise<Buffer>, ms = 300) =>
  Promise.race([
    next,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);

it("a first message in the upgrade is taken, echoed, and delivered to the joining host once and first", async () => {
  const h = await relayWithHost();
  const client = await h.client(first);
  expect(client.socket.protocol).toBe(UPGRADE_MESSAGE.subprotocol);
  expect(h.relay.earlyHeld()).toMatchObject({ reserved: 1, frames: 1, bytes: 32 });
  const joined = await h.join(await h.offer());
  expect([...(await client.next())]).toEqual([EARLY_FRAME.capableMarker]);
  expect([...(await joined.next())]).toEqual([...first]);
  // Then the stream runs as any other, and nothing came twice.
  await client.send(new Uint8Array([7]));
  expect([...(await joined.next())]).toEqual([7]);
  expect(await within(joined.next())).toBeUndefined();
  await joined.send(new Uint8Array([9]));
  expect([...(await client.next())]).toEqual([9]);
});

it("a client that also sends the message as a frame before pairing is closed at once: it is delivered once", async () => {
  // Its ticket would expire only after the test's own timeout: a close now is the frame's.
  const h = await relayWithHost({ ticketTimeoutMs: 60_000 });
  const client = await h.client(first);
  await client.send(first);
  expect(await client.closed).toBe(1008);
  expect(h.relay.earlyHeld()).toMatchObject({ frames: 0, bytes: 0 });
});

it("with every early reservation taken, the entry is left unread and the client is told so", async () => {
  const h = await relayWithHost();
  for (let n = 0; n < EARLY_FRAME.hostFrames; n++) await h.client();
  const late = await h.client(first);
  // Neither the upgrade nor early sending: the client sends its first message after the marker.
  expect(late.socket.protocol).toBe(EARLY_FRAME.neutral);
  expect(h.relay.earlyHeld()).toMatchObject({
    reserved: EARLY_FRAME.hostFrames,
    frames: 0,
    bytes: 0,
  });
});

it.each([
  ["an entry over 4 KiB", () => UPGRADE_MESSAGE.prefix + "A".repeat(UPGRADE_MESSAGE.entryBytes)],
  ["an entry that isn't canonical base64url", () => `${UPGRADE_MESSAGE.prefix}A`],
  ["a 1-byte entry", () => entry(new Uint8Array(1))],
  ["a 31-byte entry", () => entry(new Uint8Array(31))],
  ["a 33-byte entry", () => entry(new Uint8Array(33))],
  [
    "a non-canonical 32-byte encoding",
    () => `${entry(first).slice(0, -1)}${entry(first).endsWith("B") ? "C" : "B"}`,
  ],
  ["an empty entry", () => UPGRADE_MESSAGE.prefix],
  ["two entries", () => `${entry(first)}, ${entry(new Uint8Array(32).fill(5))}`],
])("%s isn't taken: the client may send early, as step 1 lets it", async (_name, bad) => {
  const h = await relayWithHost();
  const opened = await openPeer(
    address(h.relay.url, "/client", { hostId: h.daemon.hostId, [EARLY_FRAME.query]: "1" }),
    [
      UPGRADE_MESSAGE.subprotocol,
      ...bad().split(", "),
      EARLY_FRAME.subprotocol,
      EARLY_FRAME.neutral,
    ],
  );
  cleanups.push(() => opened.close());
  expect(opened.socket.protocol).toBe(EARLY_FRAME.subprotocol);
  expect(h.relay.earlyHeld()).toMatchObject({ reserved: 1, frames: 0 });
});

it("an older client that offers no upgrade message gets step 1 as before", async () => {
  const h = await relayWithHost();
  const client = await h.client();
  expect(client.socket.protocol).toBe(EARLY_FRAME.subprotocol);
  await client.send(new Uint8Array([1, 2, 3]));
  const joined = await h.join(await h.offer());
  expect([...(await joined.next())]).toEqual([1, 2, 3]);
});

// With step 2: an NK first message (ciphertext with the early hello) under its own entry.

const nkFirst = new Uint8Array(400).map((_, i) => (i * 7) % 256);
const nkOffer = (message: Uint8Array) => [
  NK_UPGRADE_MESSAGE.subprotocol,
  NK_UPGRADE_MESSAGE.prefix + Buffer.from(message).toString("base64url"),
  UPGRADE_MESSAGE.subprotocol,
  entry(first),
  EARLY_FRAME.subprotocol,
  EARLY_FRAME.neutral,
];

it("an NK first message in the upgrade is taken ahead of XX's, echoed ace.v3, and delivered once and first", async () => {
  const h = await relayWithHost();
  const client = await openPeer(
    address(h.relay.url, "/client", { hostId: h.daemon.hostId, [EARLY_FRAME.query]: "1" }),
    nkOffer(nkFirst),
  );
  cleanups.push(() => client.close());
  expect(client.socket.protocol).toBe(NK_UPGRADE_MESSAGE.subprotocol);
  const joined = await h.join(await h.offer());
  expect([...(await client.next())]).toEqual([EARLY_FRAME.capableMarker]);
  expect([...(await joined.next())]).toEqual([...nkFirst]);
  expect(await within(joined.next())).toBeUndefined();
});

it("nothing the relay writes, on any path, carries an upgrade entry", async () => {
  const written: string[] = [];
  const capture = (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  };
  const spies = [
    vi.spyOn(process.stdout, "write").mockImplementation(capture),
    vi.spyOn(process.stderr, "write").mockImplementation(capture),
    ...(["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi
        .spyOn(console, level)
        .mockImplementation((...args: unknown[]) => void capture(args.join(" "))),
    ),
  ];
  cleanups.push(() => {
    for (const spy of spies) spy.mockRestore();
  });
  const h = await relayWithHost();
  const secret = Buffer.from(nkFirst).toString("base64url");
  const open = async (offered: string[]) => {
    const opened = await openPeer(
      address(h.relay.url, "/client", { hostId: h.daemon.hostId, [EARLY_FRAME.query]: "1" }),
      offered,
    );
    cleanups.push(() => opened.close());
    return opened;
  };
  // Taken, then a failed stream; refused for room; malformed; and a socket error.
  const taken = await open(nkOffer(nkFirst));
  await taken.send(nkFirst);
  await taken.closed;
  for (let n = 0; n < EARLY_FRAME.hostFrames; n++)
    await open([EARLY_FRAME.subprotocol, EARLY_FRAME.neutral]);
  await open(nkOffer(nkFirst));
  await open([
    NK_UPGRADE_MESSAGE.subprotocol,
    `${NK_UPGRADE_MESSAGE.prefix}${secret.slice(0, 20)}B`,
    EARLY_FRAME.neutral,
  ]);
  const broken = await open(nkOffer(nkFirst));
  const reserved = h.relay.earlyHeld().reserved;
  broken.socket.terminate();
  await eventually(() => h.relay.earlyHeld().reserved < reserved);
  for (const spy of spies) spy.mockRestore();
  expect(written.join("\n")).not.toContain(secret.slice(0, 40));
  expect(written.join("\n")).not.toContain(NK_UPGRADE_MESSAGE.prefix);
  expect(written.join("\n")).not.toContain(UPGRADE_MESSAGE.prefix);
});

it("once the first message is held, and after it is forwarded, the relay keeps no copy of the upgrade entry", async () => {
  for (const offer of [
    nkOffer(nkFirst),
    [UPGRADE_MESSAGE.subprotocol, entry(first), EARLY_FRAME.subprotocol, EARLY_FRAME.neutral],
  ]) {
    const h = await relayWithHost();
    const client = await openPeer(
      address(h.relay.url, "/client", { hostId: h.daemon.hostId, [EARLY_FRAME.query]: "1" }),
      offer,
    );
    cleanups.push(() => client.close());
    // Held as the early frame: the entry itself is no longer kept by the relay.
    expect(h.relay.upgradeEntries()).toBe(0);
    expect(h.relay.earlyHeld().frames).toBe(1);
    const joined = await h.join(await h.offer());
    await joined.next();
    await eventually(() => h.relay.earlyHeld().frames === 0);
    // Forwarded: nothing of it is held anywhere the relay keeps it.
    expect(h.relay.upgradeEntries()).toBe(0);
    expect(h.relay.earlyHeld()).toMatchObject({ frames: 0, bytes: 0, queuedBytes: 0 });
  }
});

it("an upgrade that never completes leaves no entry behind", async () => {
  const h = await relayWithHost();
  const socket = await import("node:net").then(({ connect }) =>
    connect(Number(new URL(h.relay.url).port), "127.0.0.1"),
  );
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(
    [
      `GET /client?hostId=${h.daemon.hostId}&early=1 HTTP/1.1`,
      "Host: 127.0.0.1",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      // A bad key: the relay reserves and reads the entry, then the upgrade fails.
      "Sec-WebSocket-Key: not-a-key",
      `Sec-WebSocket-Protocol: ${nkOffer(nkFirst).join(", ")}`,
      "",
      "",
    ].join("\r\n"),
  );
  // The relay answers the bad key; the client then goes away.
  await new Promise((resolve) => socket.once("data", resolve));
  socket.destroy();
  await eventually(() => h.relay.earlyHeld().reserved === 0);
  expect(h.relay.upgradeEntries()).toBe(0);
  expect(h.relay.earlyHeld()).toMatchObject({ reserved: 0, frames: 0 });
});

// Every exit of a first message taken from the upgrade wipes the one buffer the relay holds it
// in (the reader's, handed over without a copy).

/** The buffers the relay hands its readers as early frames, from here on. */
function handedOver() {
  const taken: Uint8Array[] = [];
  const real = FrameReader.prototype.inject;
  const spy = vi.spyOn(FrameReader.prototype, "inject");
  spy.mockImplementation(function (this: FrameReader, frame: Uint8Array) {
    taken.push(frame);
    real.call(this, frame);
  });
  cleanups.push(() => spy.mockRestore());
  return taken;
}
const zero = (bytes: Uint8Array | undefined) =>
  bytes !== undefined && bytes.every((byte) => byte === 0);
const until = async (check: () => boolean) => {
  await eventually(check);
  return true;
};
const nkClientOf = async (h: Awaited<ReturnType<typeof relayWithHost>>) => {
  const client = await openPeer(
    address(h.relay.url, "/client", { hostId: h.daemon.hostId, [EARLY_FRAME.query]: "1" }),
    nkOffer(nkFirst),
  );
  cleanups.push(() => client.close());
  return client;
};

it("forwarded: the host gets the message, then the relay's buffer is wiped", async () => {
  const taken = handedOver();
  const h = await relayWithHost();
  const client = await nkClientOf(h);
  expect(taken).toHaveLength(1);
  const joined = await h.join(await h.offer());
  expect([...(await joined.next())]).toEqual([...nkFirst]);
  expect(await until(() => zero(taken[0]))).toBe(true);
  void client;
});

it.each([
  [
    "expired",
    async (h: Awaited<ReturnType<typeof relayWithHost>>) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      h.relay.sweep();
    },
  ],
  [
    "rejected by the host",
    async (h: Awaited<ReturnType<typeof relayWithHost>>) => {
      const ticket = await h.offer();
      await h.daemon.send(
        h.daemon.transport.send.encrypt(
          new TextEncoder().encode(JSON.stringify({ type: "reject", ticket })),
        ),
      );
    },
  ],
  [
    "its host replaced",
    async (h: Awaited<ReturnType<typeof relayWithHost>>) => {
      const again = await register(h.relay.url, h.keys);
      cleanups.push(() => again.close());
    },
  ],
  [
    "disconnected",
    async (_h: unknown, client: Awaited<ReturnType<typeof openPeer>>) => {
      client.socket.terminate();
    },
  ],
] as const)("%s before pairing: the relay's buffer is wiped", async (_name, exit) => {
  const taken = handedOver();
  const h = await relayWithHost({ ticketTimeoutMs: 200 });
  const client = await nkClientOf(h);
  expect(zero(taken[0])).toBe(false);
  await exit(h, client);
  expect(await until(() => zero(taken[0]))).toBe(true);
});
