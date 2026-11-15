import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  authenticateLane,
  controlFrameReader,
  LaneWriter,
  nodeByteSource,
  type ByteSink,
  type LaneSocket,
} from "./lanes.ts";
import { decodeFromMedia, decodeToMedia, encodeControl, type FromMedia } from "./wire.ts";

const pong: FromMedia = {
  type: "pong",
  id: "p1",
  stats: {
    sources: 1,
    viewers: 2,
    connections: 3,
    cpuMs: 4,
    rssBytes: 5,
    bytesOut: 6,
    priorityLagMs: 7,
  },
};
function bytesOf(message: FromMedia, lane: "normal" | "priority", payload = new Uint8Array(0)) {
  const { header } = encodeControl(message, payload, lane);
  const out = new Uint8Array(header.length + payload.length);
  out.set(header);
  out.set(payload, header.length);
  return out;
}

class ManualSink implements ByteSink {
  writes: { chunk: Uint8Array; done: (error?: Error | null) => void }[] = [];
  open = true;
  #drain = () => {};
  write(chunk: Uint8Array, done: (error?: Error | null) => void): boolean {
    this.writes.push({ chunk, done });
    return this.open;
  }
  onDrain(listener: () => void): void {
    this.#drain = listener;
  }
  drain(): void {
    this.open = true;
    this.#drain();
  }
}

describe("control frame reader", () => {
  it("yields each frame whole however the stream is chunked", () => {
    const stream = new Uint8Array([
      ...bytesOf(pong, "normal"),
      ...bytesOf(
        { type: "still.done", request: "s", width: 1, height: 1, steps: [] },
        "normal",
        Uint8Array.of(9, 9),
      ),
    ]);
    for (const size of [1, 3, 7, stream.length]) {
      const reader = controlFrameReader("normal");
      const frames: Uint8Array[] = [];
      for (let i = 0; i < stream.length; i += size)
        frames.push(...reader.push(stream.subarray(i, i + size)));
      const decoded = frames.map((frame) => decodeFromMedia(frame, "normal"));
      expect(decoded.map(({ message }) => message.type)).toEqual(["pong", "still.done"]);
      expect([...(decoded[1]?.payload ?? [])]).toEqual([9, 9]);
    }
  });

  it("rejects a priority frame longer than 64 KiB before buffering it", () => {
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, 64 * 1024 + 1);
    expect(() => controlFrameReader("priority").push(head)).toThrow(/priority lane frame length/);
  });
});

describe("LaneWriter", () => {
  it("holds frames while backpressured and writes them in order on drain", () => {
    const sink = new ManualSink();
    sink.open = false;
    const writer = new LaneWriter("normal", sink, () => {});
    writer.send({ type: "ping", id: "a" });
    writer.send({ type: "ping", id: "b" });
    expect(sink.writes).toHaveLength(1);
    sink.drain();
    const ids = sink.writes.map(({ chunk }) => decodeToMedia(chunk, "normal").message);
    expect(ids).toEqual([
      { type: "ping", id: "a" },
      { type: "ping", id: "b" },
    ]);
  });

  it("wipes a key block once its write completes, and one that is dropped unwritten", () => {
    const sink = new ManualSink();
    const writer = new LaneWriter("normal", sink, () => {});
    const owner = {
      session: "s",
      device: "d",
      admission: { kind: "account" as const, account: "a" },
    };
    const written = new Uint8Array(120).fill(7);
    writer.send({ type: "relay.keys", stream: "s1", connection: "c", owner, issued: 1 }, written);
    expect(written[0]).toBe(7);
    sink.writes[1]?.done();
    expect(written.every((byte) => byte === 0)).toBe(true);

    sink.open = false;
    writer.send({ type: "ping", id: "fill" });
    const queued = new Uint8Array(120).fill(7);
    writer.send({ type: "relay.keys", stream: "s2", connection: "c", owner, issued: 2 }, queued);
    expect(writer.drop((message) => message.type === "relay.keys").map((m) => m.type)).toEqual([
      "relay.keys",
    ]);
    expect(queued.every((byte) => byte === 0)).toBe(true);
  });

  it("leaves non-secret payloads untouched", () => {
    const sink = new ManualSink();
    const writer = new LaneWriter("normal", sink, () => {});
    const jpeg = Uint8Array.of(1, 2, 3);
    writer.send({ type: "source.picture", source: "s", ageMs: 0, epoch: 0 }, jpeg);
    sink.writes[1]?.done();
    expect([...jpeg]).toEqual([1, 2, 3]);
  });
});

function socketPair() {
  const data: ((chunk: Uint8Array) => void)[] = [];
  const end: ((error?: Error) => void)[] = [];
  const written: Uint8Array[] = [];
  let destroyed = false;
  const socket: LaneSocket = {
    write(chunk, done) {
      written.push(chunk.slice());
      done();
      return true;
    },
    onDrain() {},
    onData: (listener) => void data.push(listener),
    onEnd: (listener) => void end.push(listener),
    destroy() {
      destroyed = true;
    },
  };
  return {
    socket,
    written,
    destroyed: () => destroyed,
    emit: (chunk: Uint8Array) => data.forEach((listener) => listener(chunk)),
    close: () => end.forEach((listener) => listener()),
  };
}

describe("authenticateLane", () => {
  const vectors = z
    .object({
      secret: z.string(),
      clientNonce: z.string(),
      serverNonce: z.string(),
      serverLabel: z.string(),
      clientLabel: z.string(),
      cases: z.array(
        z.object({ tag: z.number(), serverProof: z.string(), clientProof: z.string() }),
      ),
    })
    .parse(
      JSON.parse(
        readFileSync(
          new URL("../../../native/media/vectors/lane/proofs.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
  const secret = bytes(vectors.secret);
  const clientNonce = bytes(vectors.clientNonce);
  const serverNonce = bytes(vectors.serverNonce);
  const mac = (key: Uint8Array, ...parts: Uint8Array[]) => {
    const hmac = createHmac("sha256", key);
    for (const part of parts) hmac.update(part);
    return new Uint8Array(hmac.digest());
  };
  const label = (text: string) => new TextEncoder().encode(text);
  const priority = vectors.cases.find((entry) => entry.tag === 1);
  if (!priority) throw new Error("no priority vector");
  /** Every nonce the daemon drew, in order. */
  const drawn = (nonces: Uint8Array[]) => (length: number) => {
    const next = nonces.shift();
    if (!next || next.length !== length) throw new Error("no nonce left");
    return next.slice();
  };

  it("proves the server first, then itself, as the shared vectors say, and hands over what follows", async () => {
    const pair = socketPair();
    const lane = authenticateLane(pair.socket, "priority", secret.slice(), drawn([clientNonce]));
    // The hello: magic, tag, the nonce. Nothing derived from the secret yet.
    expect([...(pair.written[0] ?? [])]).toEqual([0x41, 0x43, 0x45, 0x4c, 1, ...clientNonce]);
    const reply = Uint8Array.from([...bytes(priority.serverProof), ...serverNonce]);
    // The reply may come in any chunks.
    pair.emit(reply.subarray(0, 10));
    pair.emit(reply.subarray(10));
    expect([...(pair.written[1] ?? [])]).toEqual([...bytes(priority.clientProof)]);
    pair.emit(Uint8Array.of(1, 42));
    pair.emit(Uint8Array.of(43));
    const received: number[] = [];
    (await lane).onData((chunk) => received.push(...chunk));
    pair.emit(Uint8Array.of(44));
    expect(received).toEqual([42, 43, 44]);
  });

  const refusals: [string, () => Uint8Array][] = [
    // A squatting server that doesn't hold the secret can only guess.
    ["a squatter's guess", () => new Uint8Array(32).fill(9)],
    // A proof ace-media made for another connection's nonce.
    [
      "a replayed proof",
      () => mac(secret, label(vectors.serverLabel), Uint8Array.of(1), new Uint8Array(32).fill(1)),
    ],
    // The daemon's direction label: a reflected proof.
    [
      "the wrong direction label",
      () => mac(secret, label(vectors.clientLabel), Uint8Array.of(1), clientNonce),
    ],
  ];
  for (const [name, proof] of refusals)
    it(`refuses ${name} and sends nothing after its hello`, async () => {
      const pair = socketPair();
      const lane = authenticateLane(pair.socket, "priority", secret.slice(), drawn([clientNonce]));
      pair.emit(Uint8Array.from([...proof(), ...serverNonce]));
      await expect(lane).rejects.toThrow(/did not prove/);
      expect(pair.written).toHaveLength(1);
      expect(pair.destroyed()).toBe(true);
    });

  it("refuses an all-zero secret before anything goes on the wire", async () => {
    const pair = socketPair();
    await expect(
      authenticateLane(pair.socket, "egress", new Uint8Array(32), drawn([clientNonce])),
    ).rejects.toThrow(/secret/);
    expect(pair.written).toHaveLength(0);
  });

  it("draws a fresh nonce for every attempt", () => {
    const nonces = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)];
    const first = socketPair();
    const second = socketPair();
    void authenticateLane(first.socket, "priority", secret.slice(), drawn(nonces)).catch(() => {});
    void authenticateLane(second.socket, "priority", secret.slice(), drawn(nonces)).catch(() => {});
    expect(first.written[0]?.subarray(5)).not.toEqual(second.written[0]?.subarray(5));
    expect(nonces).toHaveLength(0);
  });

  it("fails when ace-media closes the lane instead of answering", async () => {
    const pair = socketPair();
    const lane = authenticateLane(pair.socket, "egress", secret.slice(), drawn([clientNonce]));
    expect(pair.written[0]?.[4]).toBe(2);
    pair.close();
    await expect(lane).rejects.toThrow(/egress lane closed/);
  });
});

describe("nodeByteSource", () => {
  it("reports an end that happened before the listener was added", () => {
    const stream = new EventEmitter();
    const source = nodeByteSource(stream);
    stream.emit("close");
    let ended = 0;
    source.onEnd(() => ended++);
    stream.emit("close");
    expect(ended).toBe(1);
  });
});
