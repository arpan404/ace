import { expect, it } from "vitest";
import { CipherState, NoiseXX, creditFragment, fingerprint, keyPair } from "@ace/secure-channel";
import type { Transport } from "@ace/secure-channel";
import { decodeKeyBlock } from "@ace/media/key-block";
import { STREAM_PROLOGUE } from "@ace/relay/wire";
import { HostId } from "@ace/protocol";
import { handOverMediaStream, type MediaAdmission, type StreamPipe } from "./handover.ts";

/** Two queues: what the daemon sends goes to the client, and the reverse. */
function wire() {
  const toClient: Uint8Array[] = [];
  const toDaemon: Uint8Array[] = [];
  type Waiter = ((frame: Uint8Array) => void) | undefined;
  const waiters: { daemon: Waiter; client: Waiter } = { daemon: undefined, client: undefined };
  let pulls = 0;
  const take = (queue: Uint8Array[], side: "daemon" | "client") =>
    queue.length
      ? Promise.resolve(queue.shift() as Uint8Array)
      : new Promise<Uint8Array>((resolve) => (waiters[side] = resolve));
  const put = (queue: Uint8Array[], side: "daemon" | "client", frame: Uint8Array) => {
    const waiter = waiters[side];
    waiters[side] = undefined;
    if (waiter) waiter(frame);
    else queue.push(frame);
  };
  const daemon: StreamPipe = {
    send: async (frame) => put(toClient, "client", frame),
    next: () => {
      pulls++;
      return take(toDaemon, "daemon");
    },
  };
  return {
    daemon,
    client: {
      send: (frame: Uint8Array) => put(toDaemon, "daemon", frame),
      next: () => take(toClient, "client"),
    },
    /** Frames the client sent that the daemon never pulled: ace-media's from here on. */
    unpulled: () => toDaemon.length,
    pulls: () => pulls,
  };
}

const host = keyPair();
const hello = (extra: Record<string, unknown> = {}) => ({
  type: "hello",
  protocolVersion: 1,
  deviceId: "phone",
  token: "t",
  channel: "media",
  mediaTicket: "A".repeat(43),
  ...extra,
});
const welcome = {
  type: "welcome",
  hostId: HostId.parse(fingerprint(host.publicKey)),
  protocolVersion: 1,
  headSeq: 0,
} as const;

function jsonFragment(message: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(message));
  const plain = new Uint8Array(json.length + 1);
  plain[0] = 1;
  plain.set(json, 1);
  return plain;
}

async function clientHandshake(link: ReturnType<typeof wire>): Promise<Transport> {
  const noise = new NoiseXX({
    initiator: true,
    staticKey: keyPair(),
    ephemeralKey: keyPair(),
    prologue: STREAM_PROLOGUE,
    pinnedFingerprint: fingerprint(host.publicKey),
  });
  link.client.send(noise.writeMessage());
  noise.readMessage(await link.client.next());
  link.client.send(noise.writeMessage());
  return noise.transport;
}

function run(
  link: ReturnType<typeof wire>,
  admit: () => MediaAdmission<string> = () => ({ ok: true, welcome, grant: "mc_grant" }),
) {
  return handOverMediaStream(link.daemon, {
    hostKeys: host,
    ephemeralKey: keyPair(),
    signal: new AbortController().signal,
    admit: async () => admit(),
  });
}

it("the block resumes the stream exactly where the daemon left it, in both directions", async () => {
  const link = wire();
  const done = run(link);
  const client = await clientHandshake(link);
  link.client.send(client.send.encrypt(jsonFragment(hello({ flowControl: ["credit"] }))));
  // The client keeps talking before it hears the welcome; the daemon must not take these.
  link.client.send(client.send.encrypt(creditFragment(0)));
  link.client.send(client.send.encrypt(jsonFragment({ type: "ping" })));
  const result = await done;
  if (!result.ok) throw new Error(result.reason);
  expect(result.grant).toBe("mc_grant");
  // The flow start, then the welcome.
  expect([...client.receive.decrypt(await link.client.next())]).toEqual([...creditFragment(0)]);
  const welcomed = client.receive.decrypt(await link.client.next());
  expect(JSON.parse(new TextDecoder().decode(welcomed.subarray(1)))).toEqual(welcome);
  expect(link.unpulled()).toBe(2);

  const block = decodeKeyBlock(result.block);
  expect(block).toMatchObject({
    sendNonce: 2n,
    receiveNonce: 1n,
    framesSent: 2n,
    framesReceived: 1n,
    flags: 1,
    window: 1024 * 1024 - 4096,
  });
  // ace-media's side, rebuilt from the block: it opens the next client frame and seals the next
  // one the client expects. Nothing is lost or replayed.
  const mediaReceive = new CipherState(block.receiveKey, block.receiveNonce);
  const mediaSend = new CipherState(block.sendKey, block.sendNonce);
  const unpulled = await link.daemon.next();
  expect([...mediaReceive.decrypt(unpulled)]).toEqual([...creditFragment(0)]);
  const reply = mediaSend.encrypt(jsonFragment({ type: "pong" }));
  expect(new TextDecoder().decode(client.receive.decrypt(reply).subarray(1))).toBe(
    '{"type":"pong"}',
  );
});

it("a refused hello hears the refusal, and no block comes back", async () => {
  const link = wire();
  const done = run(link, () => ({
    ok: false,
    refusal: { type: "error", code: "unauthorized", message: "Valid hello required" },
  }));
  const client = await clientHandshake(link);
  link.client.send(client.send.encrypt(jsonFragment(hello())));
  expect(await done).toEqual({ ok: false, reason: "refused" });
  const refusal = client.receive.decrypt(await link.client.next());
  expect(JSON.parse(new TextDecoder().decode(refusal.subarray(1)))).toMatchObject({
    code: "unauthorized",
  });
});

it("anything but a hello as the first message ends the stream without admission", async () => {
  const link = wire();
  let asked = false;
  const done = run(link, () => {
    asked = true;
    return { ok: true, welcome, grant: "x" };
  });
  const client = await clientHandshake(link);
  link.client.send(client.send.encrypt(jsonFragment({ type: "ping" })));
  expect((await done).ok).toBe(false);
  expect(asked).toBe(false);
  const refusal = client.receive.decrypt(await link.client.next());
  expect(JSON.parse(new TextDecoder().decode(refusal.subarray(1)))).toMatchObject({
    type: "error",
    code: "unauthorized",
  });
});

it("a hand-over cancelled while admission is pending exports no keys and sends nothing, even when admission then admits", async () => {
  const link = wire();
  const cancel = new AbortController();
  const admission = Promise.withResolvers<MediaAdmission<string>>();
  const asked = Promise.withResolvers<AbortSignal>();
  const done = handOverMediaStream(link.daemon, {
    hostKeys: host,
    ephemeralKey: keyPair(),
    signal: cancel.signal,
    admit: (_hello, signal) => {
      asked.resolve(signal);
      return admission.promise;
    },
  });
  const client = await clientHandshake(link);
  link.client.send(client.send.encrypt(jsonFragment(hello({ flowControl: ["credit"] }))));
  const seen = await asked.promise;
  cancel.abort();
  // Admission is told, and its late answer changes nothing.
  expect(seen.aborted).toBe(true);
  admission.resolve({ ok: true, welcome, grant: "mc_late" });
  const result = await done;
  expect(result).toEqual({ ok: false, reason: "cancelled" });
  expect("block" in result).toBe(false);
  // Neither a flow start nor a welcome was sealed for the client: the ciphers were spent.
  const nothing = await Promise.race([
    link.client.next().then(() => "frame"),
    new Promise((resolve) => setTimeout(() => resolve("nothing"), 20)),
  ]);
  expect(nothing).toBe("nothing");
});

it("the ephemeral key it was given is wiped on every path: hand-over, refusal, cancellation and a bad key", async () => {
  const zeroed = (key: Uint8Array) => key.every((byte) => byte === 0);
  // Handed over.
  {
    const link = wire();
    const ephemeral = keyPair();
    const done = handOverMediaStream(link.daemon, {
      hostKeys: host,
      ephemeralKey: ephemeral,
      signal: new AbortController().signal,
      admit: async () => ({ ok: true, welcome, grant: "g" }),
    });
    const client = await clientHandshake(link);
    link.client.send(client.send.encrypt(jsonFragment(hello())));
    expect((await done).ok).toBe(true);
    expect(zeroed(ephemeral.privateKey)).toBe(true);
  }
  // Refused.
  {
    const link = wire();
    const ephemeral = keyPair();
    const done = handOverMediaStream(link.daemon, {
      hostKeys: host,
      ephemeralKey: ephemeral,
      signal: new AbortController().signal,
      admit: async () => ({ ok: false }),
    });
    const client = await clientHandshake(link);
    link.client.send(client.send.encrypt(jsonFragment(hello())));
    expect((await done).ok).toBe(false);
    expect(zeroed(ephemeral.privateKey)).toBe(true);
  }
  // Cancelled before the client said anything.
  {
    const link = wire();
    const ephemeral = keyPair();
    const cancel = new AbortController();
    const done = handOverMediaStream(link.daemon, {
      hostKeys: host,
      ephemeralKey: ephemeral,
      signal: cancel.signal,
      admit: async () => ({ ok: true, welcome, grant: "g" }),
    });
    // Wiped as soon as Noise has its copy, before anything arrives.
    expect(zeroed(ephemeral.privateKey)).toBe(true);
    cancel.abort();
    link.client.send(new Uint8Array(32));
    expect((await done).ok).toBe(false);
  }
  // A key Noise can't take: the constructor fails, and the buffer is wiped all the same.
  {
    const bad = { publicKey: new Uint8Array(32), privateKey: new Uint8Array(31).fill(7) };
    await expect(
      handOverMediaStream(wire().daemon, {
        hostKeys: host,
        ephemeralKey: bad,
        signal: new AbortController().signal,
        admit: async () => ({ ok: false }),
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(zeroed(bad.privateKey)).toBe(true);
  }
});
