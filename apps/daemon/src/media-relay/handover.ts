import { ClientMessage, type ServerMessage } from "@ace/protocol";
import {
  CREDIT_FLAG,
  FlowCredit,
  MAX_MESSAGE,
  NoiseXX,
  fragmentCost,
  readCredit,
  type KeyPair,
  type SessionKeys,
  type Transport,
} from "@ace/secure-channel";
import { crc32c } from "@ace/media/key-block";
import { STREAM_PROLOGUE } from "@ace/relay/wire";

/*
 * The daemon's half of a relay media stream (docs/media/plan.md, "Media connection
 * authorization" and "Key hand-over"). ace-media holds the socket; the daemon runs the Noise
 * responder and reads the client's hello through it, one frame per pull, so it never takes a
 * frame it doesn't need. Once the hello is admitted it seals the welcome and writes the
 * stream's cipher states and flow accounting into the 120-byte key block for ace-media.
 */

type Hello = Extract<ClientMessage, { type: "hello" }>;

/**
 * The 120-byte key block from a finished handshake's cipher states, whichever Noise pattern made
 * them (XX or NK split the same way, ADR 0155): keys and next nonces, frame counts, flow state,
 * CRC. Spends both cipher states.
 */
export function writeKeyBlock(
  keys: SessionKeys,
  frames: { sent: bigint; received: bigint },
  flow: FlowCredit,
  block: Uint8Array,
): void {
  const state = flow.exportState();
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  keys.send.exportInto(block, 0, 64);
  keys.receive.exportInto(block, 32, 72);
  view.setBigUint64(80, frames.sent);
  view.setBigUint64(88, frames.received);
  view.setUint8(96, (state.limited ? 1 : 0) | (state.counting ? 2 : 0));
  view.setUint32(100, state.window);
  view.setUint32(104, state.unacked);
  view.setUint32(108, state.owed);
  view.setUint32(112, state.uncounted);
  view.setUint32(116, crc32c(block.subarray(0, 116)));
}

/** One relay stream's frames, carried by ace-media (`relay.out`, `relay.pull` → `relay.in`). */
export type StreamPipe = {
  send(frame: Uint8Array): Promise<void>;
  next(): Promise<Uint8Array>;
};

/** What admitting a hello decides: the welcome and the grant to hand over, or a refusal. */
export type MediaAdmission<Grant> =
  | { ok: true; welcome: ServerMessage; grant: Grant }
  | { ok: false; refusal?: ServerMessage };

export type HandoverResult<Grant> =
  | { ok: true; block: Uint8Array; grant: Grant }
  | { ok: false; reason: string };

/** The rekey schedule both ends follow: a rekey right after every 2^20th frame. */
export const REKEY_INTERVAL = 1n << 20n;
/** Fragment kinds, as `apps/relay/src/channel.ts` frames them: JSON 0, plus 1 on the last. */
const JSON_LAST = 1;
const JSON_MORE = 0;
/** The longest hello the daemon reads (its main socket's first-message bound). */
const HELLO_LIMIT = 64 * 1024;

class Sealed {
  sent = 0n;
  received = 0n;
  readonly flow = new FlowCredit();
  readonly #transport: Transport;
  readonly #pipe: StreamPipe;
  constructor(transport: Transport, pipe: StreamPipe) {
    this.#transport = transport;
    this.#pipe = pipe;
  }
  async send(plain: Uint8Array): Promise<void> {
    const frame = this.#transport.send.encrypt(plain);
    plain.fill(0);
    if (++this.sent % REKEY_INTERVAL === 0n) this.#transport.send.rekey();
    await this.#pipe.send(frame);
  }
  async open(): Promise<Uint8Array> {
    const plain = this.#transport.receive.decrypt(await this.#pipe.next());
    if (++this.received % REKEY_INTERVAL === 0n) this.#transport.receive.rekey();
    return plain;
  }
  /** One JSON message, credits answered as they come. */
  async receiveJson(): Promise<string> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const plain = await this.open();
        if (plain[0] === CREDIT_FLAG) {
          const reply = this.flow.credited(readCredit(plain));
          if (reply) await this.send(reply);
          continue;
        }
        const flag = plain[0];
        if (
          plain.length < 2 ||
          (flag !== JSON_LAST && flag !== JSON_MORE) ||
          (flag === JSON_MORE && plain.length !== MAX_MESSAGE - 16)
        )
          throw new Error("A media hello is one JSON message");
        const cost = fragmentCost(plain.length);
        if (!this.flow.received(cost)) throw new Error("Peer overran its flow window");
        const credit = this.flow.consumed(cost);
        if (credit) await this.send(credit);
        size += plain.length - 1;
        if (size > HELLO_LIMIT) throw new Error("Hello too large");
        chunks.push(plain.subarray(1));
        if (flag === JSON_LAST) break;
      }
      const joined = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(joined);
      joined.fill(0);
      return text;
    } finally {
      for (const chunk of chunks) chunk.fill(0);
    }
  }
  /** One JSON message, in one fragment (a welcome or refusal always fits), within the window. */
  async sendJson(message: ServerMessage): Promise<void> {
    const json = new TextEncoder().encode(JSON.stringify(message));
    if (json.length > MAX_MESSAGE - 17) throw new Error("Message too large");
    const plain = new Uint8Array(json.length + 1);
    plain[0] = JSON_LAST;
    plain.set(json, 1);
    const cost = fragmentCost(plain.length);
    if (!this.flow.allows(cost)) throw new Error("No flow credit for the welcome");
    this.flow.spend(cost);
    await this.send(plain);
  }
  /** Writes the key block and spends both cipher states (docs/media/plan.md, "Key hand-over"). */
  exportInto(block: Uint8Array): void {
    writeKeyBlock(this.#transport, { sent: this.sent, received: this.received }, this.flow, block);
  }
  destroy(): void {
    this.#transport.destroy();
  }
}

/**
 * Runs a relay media stream up to the key hand-over: the Noise XX responder with the host's
 * static key, the hello, `admit`'s decision, the flow start (for a client that asked) and the
 * welcome. On success the result holds the 120-byte block, which the caller hands to ace-media
 * and wipes; on any failure every key is destroyed and nothing is returned.
 *
 * `ephemeralKey` is this hand-over's alone: its private key is wiped as soon as Noise has its own
 * copy, whatever happens next.
 *
 * `signal` cancels it (the hand-over deadline): every key is destroyed at once, admission is
 * told through the same signal, and nothing is sealed or exported after it, whatever admission
 * answers later.
 */
export async function handOverMediaStream<Grant>(
  pipe: StreamPipe,
  options: {
    hostKeys: KeyPair;
    ephemeralKey: KeyPair;
    signal: AbortSignal;
    admit(hello: Hello, signal: AbortSignal): Promise<MediaAdmission<Grant>>;
  },
): Promise<HandoverResult<Grant>> {
  const { signal } = options;
  let noise: NoiseXX;
  try {
    noise = new NoiseXX({
      initiator: false,
      staticKey: options.hostKeys,
      ephemeralKey: options.ephemeralKey,
      prologue: STREAM_PROLOGUE,
    });
  } catch {
    return failed("handshake key");
  } finally {
    // Noise holds its own copy now (or failed to take one): the caller's is wiped either way.
    options.ephemeralKey.privateKey.fill(0);
  }
  let sealed: Sealed | undefined;
  const spend = () => {
    noise.destroy();
    sealed?.destroy();
  };
  if (signal.aborted) spend();
  signal.addEventListener("abort", spend, { once: true });
  try {
    if (noise.readMessage(await pipe.next()).length) return failed("handshake payload");
    await pipe.send(noise.writeMessage());
    if (noise.readMessage(await pipe.next()).length) return failed("handshake payload");
    if (signal.aborted) return failed("cancelled");
    sealed = new Sealed(noise.transport, pipe);
    const hello = ClientMessage.safeParse(JSON.parse(await sealed.receiveJson()));
    if (!hello.success || hello.data.type !== "hello") {
      // As on a direct socket: the client stops instead of retrying a hello that won't work.
      await sealed
        .sendJson({ type: "error", code: "unauthorized", message: "Valid hello required" })
        .catch(() => {});
      return failed("not a hello");
    }
    const admitted = await options.admit(hello.data, signal);
    if (signal.aborted) return failed("cancelled");
    if (!admitted.ok) {
      if (admitted.refusal) await sealed.sendJson(admitted.refusal).catch(() => {});
      return failed("refused");
    }
    // Credit fragments go only to a client that asked; its first one precedes the welcome.
    if (hello.data.flowControl?.includes("credit")) {
      const start = sealed.flow.start();
      if (start) await sealed.send(start);
    }
    await sealed.sendJson(admitted.welcome);
    if (signal.aborted) return failed("cancelled");
    const block = new Uint8Array(120);
    sealed.exportInto(block);
    return { ok: true, block, grant: admitted.grant };
  } catch (error) {
    if (signal.aborted) return failed("cancelled");
    return failed(error instanceof Error ? error.message : "handover failed");
  } finally {
    signal.removeEventListener("abort", spend);
    spend();
  }
}

function failed(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}
