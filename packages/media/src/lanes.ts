import { createHmac, timingSafeEqual } from "node:crypto";
import { createConnection } from "node:net";
import { encodeControl, type ControlLane, type ToMedia } from "./wire.ts";

/**
 * The byte plumbing of ace-media's three control lanes (docs/media/plan.md, "Transport"):
 * splitting inbound bytes into whole frames, queueing outbound frames behind backpressure, and
 * the hello that authenticates a socket lane. No timers and no process handling; the supervisor
 * owns those.
 */

/** Largest frame (after its length field) each lane accepts, as the plan fixes. */
export const laneFrameLimit: Record<ControlLane, number> = {
  normal: 8 * 1024 * 1024,
  priority: 64 * 1024,
};

/** A writable byte stream. `write` returns false once the stream is backpressured. */
export interface ByteSink {
  write(chunk: Uint8Array, done: (error?: Error | null) => void): boolean;
  onDrain(listener: () => void): void;
}

/**
 * A readable byte stream. `onEnd` fires once, on close or error; a listener added after the end
 * is called at once.
 */
export interface ByteSource {
  onData(listener: (chunk: Uint8Array) => void): void;
  onEnd(listener: (error?: Error) => void): void;
}

/** One connection to ace-media's private control socket. */
export interface LaneSocket extends ByteSink, ByteSource {
  destroy(): void;
}

/** Accumulates chunks and hands out whole frames whose length the caller's rule reads. */
class Splitter {
  #chunks: Uint8Array[] = [];
  #buffered = 0;

  private readonly prefix: number;
  /** The frame's total length once `prefix` bytes are buffered; throws on an invalid one. */
  private readonly lengthOf: (head: DataView) => number;

  constructor(prefix: number, lengthOf: (head: DataView) => number) {
    this.prefix = prefix;
    this.lengthOf = lengthOf;
  }

  /** Every frame completed by `chunk`, each a fresh copy. Throws on an invalid length. */
  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.length > 0) {
      this.#chunks.push(chunk);
      this.#buffered += chunk.length;
    }
    const frames: Uint8Array[] = [];
    while (this.#buffered >= this.prefix) {
      const head = this.#peek(this.prefix);
      const length = this.lengthOf(new DataView(head.buffer, head.byteOffset, head.byteLength));
      if (this.#buffered < length) break;
      frames.push(this.#take(length));
    }
    return frames;
  }

  #peek(count: number): Uint8Array {
    const first = this.#chunks[0];
    if (first && first.length >= count) return first.subarray(0, count);
    const out = new Uint8Array(count);
    let offset = 0;
    for (const chunk of this.#chunks) {
      const part = chunk.subarray(0, count - offset);
      out.set(part, offset);
      offset += part.length;
      if (offset === count) break;
    }
    return out;
  }

  #take(count: number): Uint8Array {
    const out = new Uint8Array(count);
    let offset = 0;
    while (offset < count) {
      const chunk = this.#chunks[0];
      if (!chunk) throw new Error("Splitter underflow");
      const part = chunk.subarray(0, count - offset);
      out.set(part, offset);
      offset += part.length;
      if (part.length === chunk.length) this.#chunks.shift();
      else this.#chunks[0] = chunk.subarray(part.length);
    }
    this.#buffered -= count;
    return out;
  }
}

/** Splits a normal or priority lane's bytes into whole control frames for `decodeFromMedia`. */
export function controlFrameReader(lane: ControlLane): { push(chunk: Uint8Array): Uint8Array[] } {
  const limit = laneFrameLimit[lane];
  return new Splitter(4, (head) => {
    const length = head.getUint32(0);
    if (length < 4 || length > limit) throw new Error(`Invalid ${lane} lane frame length`);
    return 4 + length;
  });
}

/** Egress frames: the 12-byte egress header, then a `MediaFrame` (header length H, payload). */
const egressMaxBytes = 12 + 4096 + 8 * 1024 * 1024;
export function egressFrameReader(): { push(chunk: Uint8Array): Uint8Array[] } {
  return new Splitter(24, (head) => {
    if (head.getUint32(0) !== 0x41434545) throw new Error("Invalid egress magic");
    const length = 12 + head.getUint16(18) + head.getUint32(20);
    if (head.getUint16(18) < 44 || length > egressMaxBytes)
      throw new Error("Invalid egress length");
    return length;
  });
}

/**
 * Lane authentication (`media_wire::lane`, plan "K1 contract clarifications"). The daemon sends
 * `"ACEL"`, a u8 lane tag (1 priority, 2 egress) and a fresh 32-byte nonce. ace-media answers
 * with its proof, HMAC-SHA256 keyed by the lane secret over the server label, the tag and that
 * nonce, then a nonce of its own. Only once that proof checks out does the daemon send its own,
 * over the client label, the tag and both nonces; ace-media then answers `laneAccepted`, and the
 * connection carries that lane's frames. A server that doesn't hold the secret (a squatting pipe
 * instance on Windows) learns one random nonce and nothing else. ace-media refuses a wrong proof,
 * a repeated tag or a connection after both lanes are up by closing without a word.
 */
export const laneTags = { priority: 1, egress: 2 } as const;
export type SocketLane = keyof typeof laneTags;
export const laneAccepted = 0x01;
const nonceBytes = 32;
const proofBytes = 32;
const serverLabel = new TextEncoder().encode("ace-media lane v1 server");
const clientLabel = new TextEncoder().encode("ace-media lane v1 client");

function proof(secret: Uint8Array, ...parts: Uint8Array[]): Uint8Array {
  const hmac = createHmac("sha256", secret);
  for (const part of parts) hmac.update(part);
  return new Uint8Array(hmac.digest());
}

/**
 * Proves ace-media and then the daemon on a socket lane, and waits for ace-media's accept byte.
 * Resolves with the source of the lane's frames (any bytes after the accept byte included);
 * rejects if ace-media's proof is wrong (the connection is destroyed, having carried only the
 * hello), if the lane is refused, or if it closes first. `random` gives the attempt's nonce,
 * fresh each call; the secret's copies made here are zeroed once used.
 */
export function authenticateLane(
  socket: LaneSocket,
  lane: SocketLane,
  secret: Uint8Array,
  random: (length: number) => Uint8Array,
): Promise<ByteSource> {
  if (secret.length !== 32 || secret.every((byte) => byte === 0))
    return Promise.reject(new Error("The lane secret must be 32 bytes, not all zero"));
  const tag = Uint8Array.of(laneTags[lane]);
  const nonce = random(nonceBytes);
  if (nonce.length !== nonceBytes) return Promise.reject(new Error("A lane nonce is 32 bytes"));
  const hello = new Uint8Array(5 + nonceBytes);
  new DataView(hello.buffer).setUint32(0, 0x4143454c);
  hello.set(tag, 4);
  hello.set(nonce, 5);
  const expected = proof(secret, serverLabel, tag, nonce);
  return new Promise((resolve, reject) => {
    let phase: "proof" | "accept" | "open" | "failed" = "proof";
    let reply = new Uint8Array(0);
    let listener: ((chunk: Uint8Array) => void) | undefined;
    const held: Uint8Array[] = [];
    const deliver = (chunk: Uint8Array) => {
      if (chunk.length === 0) return;
      if (listener) listener(chunk);
      else held.push(chunk);
    };
    const fail = (error: Error) => {
      phase = "failed";
      expected.fill(0);
      reject(error);
    };
    const accept = (chunk: Uint8Array) => {
      if (chunk.length === 0) return;
      if (chunk[0] !== laneAccepted) return fail(new Error(`ace-media refused the ${lane} lane`));
      phase = "open";
      deliver(chunk.subarray(1));
      resolve({
        onData(next) {
          listener = next;
          for (const queued of held.splice(0)) next(queued);
        },
        onEnd: (next) => socket.onEnd(next),
      });
    };
    socket.onData((chunk) => {
      if (phase === "failed") return;
      if (phase === "open") return deliver(chunk);
      if (phase === "accept") return accept(chunk);
      reply = Uint8Array.from([...reply, ...chunk]);
      if (reply.length < proofBytes + nonceBytes) return;
      const presented = reply.subarray(0, proofBytes);
      if (!timingSafeEqual(presented, expected)) {
        socket.destroy();
        return fail(new Error(`The ${lane} lane's server did not prove the lane secret`));
      }
      expected.fill(0);
      const serverNonce = reply.slice(proofBytes, proofBytes + nonceBytes);
      const rest = reply.subarray(proofBytes + nonceBytes);
      phase = "accept";
      const answer = proof(secret, clientLabel, tag, nonce, serverNonce);
      socket.write(answer, () => answer.fill(0));
      accept(rest);
    });
    socket.onEnd((error) => {
      if (phase === "open" || phase === "failed") return;
      fail(error ?? new Error(`The ${lane} lane closed during authentication`));
    });
    socket.write(hello, () => hello.fill(0));
  });
}

/** Payloads that carry secrets: zeroed once written, dropped or abandoned (plan, "Key hand-over"). */
const secretPayloads = new Set<ToMedia["type"]>([
  "init",
  "media.ticket",
  "source.open",
  "relay.keys",
  "listen",
]);

export type QueuedMessage = { readonly message: ToMedia; readonly payload: Uint8Array };

type Entry = QueuedMessage & { header: Uint8Array; onWritten: (() => void) | undefined };

/**
 * Writes control frames to one lane in order, holding the rest while the sink is backpressured.
 * Each frame's header and payload go as separate chunks, so a secret payload is never copied in
 * JS; it is zeroed after its write callback, on a write error, or when the entry is dropped.
 */
export class LaneWriter {
  #queue: Entry[] = [];
  #blocked = false;
  #closed = false;
  /** Chunks handed to the sink whose write callback hasn't fired. */
  #inFlight = 0;
  #completed = 0;

  private readonly lane: ControlLane;
  private readonly sink: ByteSink;
  private readonly onError: (error: Error) => void;

  constructor(lane: ControlLane, sink: ByteSink, onError: (error: Error) => void) {
    this.lane = lane;
    this.sink = sink;
    this.onError = onError;
    sink.onDrain(() => {
      this.#blocked = false;
      this.#flush();
    });
  }

  /**
   * How far writing has got: frames and chunks not yet completed, and a count of completed
   * writes that grows whenever the reader makes progress.
   */
  progress(): { pending: number; completed: number } {
    return { pending: this.#queue.length + this.#inFlight, completed: this.#completed };
  }

  /**
   * Encodes and queues one message. `onWritten` runs once all of its bytes have been handed to
   * the reader (the sink's write callbacks), never for a message that is dropped. Throws (after
   * zeroing a secret payload) if the message is invalid.
   */
  send(message: ToMedia, payload: Uint8Array = new Uint8Array(0), onWritten?: () => void): void {
    let header: Uint8Array;
    try {
      header = encodeControl(message, payload, this.lane).header;
    } catch (error) {
      wipe(message, payload);
      throw error;
    }
    if (this.#closed) {
      wipe(message, payload);
      return;
    }
    this.#queue.push({ message, payload, header, onWritten });
    this.#flush();
  }

  /** Removes queued, unwritten messages that `match` (a revocation's grants) and returns them. */
  drop(match: (message: ToMedia) => boolean): ToMedia[] {
    const dropped: ToMedia[] = [];
    this.#queue = this.#queue.filter((entry) => {
      if (!match(entry.message)) return true;
      wipe(entry.message, entry.payload);
      dropped.push(entry.message);
      return false;
    });
    return dropped;
  }

  /** Drops everything queued; later sends are discarded. */
  close(): void {
    this.#closed = true;
    for (const entry of this.#queue) wipe(entry.message, entry.payload);
    this.#queue = [];
  }

  #flush(): void {
    while (!this.#blocked && !this.#closed) {
      const entry = this.#queue.shift();
      if (!entry) return;
      const { message, payload, header, onWritten } = entry;
      let remaining = payload.length > 0 ? 2 : 1;
      let failedOnce = false;
      const done = (error?: Error | null) => {
        this.#inFlight--;
        this.#completed++;
        if (error) {
          failedOnce = true;
          if (!this.#closed) this.onError(error);
        }
        if (--remaining === 0 && !failedOnce && !this.#closed) onWritten?.();
      };
      this.#inFlight += remaining;
      let open = this.sink.write(header, done);
      if (payload.length > 0)
        open =
          this.sink.write(payload, (error) => {
            wipe(message, payload);
            done(error);
          }) && open;
      this.#blocked = !open;
    }
  }
}

function wipe(message: ToMedia, payload: Uint8Array): void {
  if (secretPayloads.has(message.type)) payload.fill(0);
}

type NodeWritable = {
  write(chunk: Uint8Array, done: (error?: Error | null) => void): boolean;
  on(event: "drain", listener: () => void): unknown;
};
type NodeReadable = {
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  once(event: "close" | "error", listener: (error?: Error) => void): unknown;
};

export function nodeByteSink(stream: NodeWritable): ByteSink {
  return {
    write: (chunk, done) => stream.write(chunk, done),
    onDrain: (listener) => void stream.on("drain", listener),
  };
}

/**
 * A Node stream as a `ByteSource`. Its end is observed from creation, so a listener added after
 * the stream closed still hears of it.
 */
export function nodeByteSource(stream: NodeReadable): ByteSource {
  let ended: { error: Error | undefined } | undefined;
  const listeners: ((error?: Error) => void)[] = [];
  const end = (error?: Error) => {
    if (ended) return;
    ended = { error };
    for (const listener of listeners.splice(0)) listener(error);
  };
  stream.once("error", end);
  stream.once("close", () => end());
  return {
    onData: (listener) => void stream.on("data", listener),
    onEnd(listener) {
      if (ended) listener(ended.error);
      else listeners.push(listener);
    },
  };
}

/** Connects to ace-media's control socket (a Unix socket path or a Windows named pipe). */
export function connectLane(path: string): Promise<LaneSocket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      // Errors also close the socket; the close listener reports them.
      socket.on("error", () => {});
      resolve({
        ...nodeByteSink(socket),
        ...nodeByteSource(socket),
        destroy: () => socket.destroy(),
      });
    });
  });
}
