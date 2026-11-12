import { ClientMessage, ServerMessage } from "@ace/protocol";
import type { Transport } from "@ace/secure-channel";
import {
  CREDIT_FLAG,
  FlowCredit,
  MAX_MESSAGE,
  fragmentCost,
  readCredit,
} from "@ace/secure-channel";
import type WebSocket from "ws";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { z } from "zod";
import { FrameReader, sendFrame } from "./socket.ts";
import type { Clock } from "./clock.ts";
import { FramePace } from "./frame-pace.ts";
export type WireMessage = ClientMessage | ServerMessage;
export const BINARY_MESSAGE_LIMIT = 64 * 1024 + 16;
export const LOGICAL_MESSAGE_LIMIT = 16 * 1024 * 1024;
const REKEY_INTERVAL = 1 << 20;
/**
 * A fragment's first byte: its message's kind plus 1 on the message's last fragment. Deflated
 * JSON goes only to a peer that asked for it, so older peers never see kind 4.
 */
const fragmentKinds = { json: 0, binary: 2, deflated: 4 } as const;
type FragmentKind = (typeof fragmentKinds)[keyof typeof fragmentKinds];
/**
 * Decrypted fragments queued for a reader whose peer is not flow controlled. Past this the
 * channel stops reading the socket, so the relay connection's own backpressure applies.
 */
const PLAIN_HIGH_WATER = 256 * 1024;
/** Smaller JSON messages gain too little to be worth a deflate. */
const DEFLATE_THRESHOLD = 1024;

/** A JSON message deflated alone, or undefined when that wouldn't make it smaller. */
function deflateMessage(json: Uint8Array): Uint8Array | undefined {
  if (json.length < DEFLATE_THRESHOLD) return undefined;
  const deflated = deflateRawSync(json, { level: 6 });
  if (deflated.length < json.length) return deflated;
  deflated.fill(0);
  return undefined;
}

/**
 * The relay closed the stream's socket: its WebSocket close code and reason. ace's hosted relay
 * closes a stream with 1000 "Peer closed" when the other end went away, and with its own code
 * when it ends the stream itself (1008 rate limit, 1009 frame too large, 1011 relay state).
 */
export class RelayStreamClosed extends Error {
  readonly code: number;
  readonly reason: string;
  constructor(code: number, reason: string) {
    super(`Relay stream closed (${code}${reason ? ` ${reason}` : ""})`);
    this.name = "RelayStreamClosed";
    this.code = code;
    this.reason = reason;
  }
}
/** Inflate a peer's message, never past the logical message limit. */
function inflateMessage(deflated: Uint8Array): Uint8Array {
  return inflateRawSync(deflated, { maxOutputLength: LOGICAL_MESSAGE_LIMIT });
}
export interface BinaryChannel {
  sendBinary(frame: Uint8Array): Promise<void>;
  receiveBinary(): Promise<Uint8Array>;
  close(): void;
  readonly closed: Promise<Error | undefined>;
}
export interface MessageChannel<Incoming extends WireMessage, Outgoing extends WireMessage>
  extends AsyncIterable<Incoming>, BinaryChannel {
  send(message: Outgoing): Promise<void>;
  sendBinary(bytes: Uint8Array): Promise<void>;
  receiveFrame(): Promise<Incoming | Uint8Array>;
  frames(): AsyncIterable<Incoming | Uint8Array>;
  receive(): Promise<Incoming>;
  close(): void;
  readonly closed: Promise<Error | undefined>;
  readonly bufferedBytes: number;
  readonly bufferedReceiveBytes: number;
  /**
   * The peer said it takes credit fragments (`hello.flowControl` has `credit`): from now on
   * both directions are flow controlled end to end, so a slow reader holds back the sender
   * instead of filling the relay. Messages the sender can't write yet count in `bufferedBytes`.
   */
  flowControl?(): void;
  /**
   * From now on, deflate each JSON message `allowed` passes, alone (no context carries over),
   * before it is encrypted. Only for a peer that said it inflates (`hello.compression`).
   */
  compress?(allowed: (message: Outgoing) => boolean): void;
  /**
   * Send JSON text the caller already serialized from a valid message, deflated when
   * `compress` is set and it shrinks (only for a peer that said it inflates). Skips the schema
   * check `send` runs, for a caller whose messages are typed already (the daemon's main channel).
   */
  sendText(json: string, compress?: boolean): Promise<void>;
  /**
   * The next message as received: JSON text (inflated, valid UTF-8, not schema-checked) or
   * binary bytes. The caller parses the text, as a direct socket's handler would.
   */
  receiveRaw(): Promise<string | Uint8Array>;
}
export interface HostChannel extends MessageChannel<ClientMessage, ServerMessage> {
  /** Call only after the daemon verifies the device token in the first hello. */
  authorize(): void;
}
export type ClientChannel = MessageChannel<ServerMessage, ClientMessage>;
export function clientMessageChannel(
  socket: WebSocket,
  reader: FrameReader,
  transport: Transport,
  clock: Clock,
): ClientChannel {
  return createChannel(socket, reader, transport, clock, ServerMessage, ClientMessage);
}
export function hostMessageChannel(
  socket: WebSocket,
  reader: FrameReader,
  transport: Transport,
  onReceive: (message: ClientMessage | Uint8Array | string) => void,
  authorize: () => void,
  clock: Clock,
): HostChannel {
  return Object.assign(
    createChannel(socket, reader, transport, clock, ClientMessage, ServerMessage, onReceive),
    { authorize },
  );
}
function createChannel<Incoming extends WireMessage, Outgoing extends WireMessage>(
  socket: WebSocket,
  reader: FrameReader,
  transport: Transport,
  clock: Clock,
  incoming: z.ZodType<Incoming>,
  outgoing: z.ZodType<Outgoing>,
  onReceive?: (message: Incoming | Uint8Array | string) => void,
): MessageChannel<Incoming, Outgoing> {
  let resolveClosed: (error: Error | undefined) => void;
  const closed = new Promise<Error | undefined>((resolve) => {
    resolveClosed = resolve;
  });
  let ended = false,
    pendingBytes = 0,
    sending = Promise.resolve(),
    receiving = false,
    locallyClosed = false;
  let sendCount = 0,
    receiveCount = 0;
  const flow = new FlowCredit();
  // Every frame this end writes counts against the hosted relay's per-socket budget.
  const pace = new FramePace();
  // Fragments decrypted as they arrive, so a credit is seen even while the reader is busy.
  const plainQueue: Uint8Array[] = [];
  let plainBytes = 0;
  let plainWaiter: { resolve(plain: Uint8Array): void; reject(error: Error): void } | undefined;
  let pumpWaiter: (() => void) | undefined;
  const creditWaiters: (() => void)[] = [];
  const wakeSenders = () => {
    for (const wake of creditWaiters.splice(0)) wake();
  };
  const end = (error?: Error) => {
    if (ended) return;
    ended = true;
    transport.destroy();
    reader.fail(error ?? new Error("Channel closed"));
    socket.terminate();
    for (const plain of plainQueue.splice(0)) plain.fill(0);
    plainBytes = 0;
    plainWaiter?.reject(error ?? new Error("Channel closed"));
    plainWaiter = undefined;
    pumpWaiter?.();
    wakeSenders();
    resolveClosed(error);
  };
  /** Encrypt the next outgoing fragment; rekeys right after the frame that reaches the interval. */
  const seal = (plain: Uint8Array): Uint8Array => {
    const frame = transport.send.encrypt(plain);
    if (++sendCount % REKEY_INTERVAL === 0) transport.send.rekey();
    return frame;
  };
  /** A credit goes out at once, ahead of data still waiting for the peer's credit. */
  const sendCredit = (plain: Uint8Array | undefined) => {
    if (!plain || ended) return;
    // A credit never waits; its frame still counts, so data after it waits a little longer.
    pace.take(clock.now());
    void sendFrame(socket, seal(plain)).catch((error: unknown) =>
      end(error instanceof Error ? error : new Error("Send failed")),
    );
  };
  void (async () => {
    try {
      // A flow-controlled peer can't overrun its window; any other is held back by the socket.
      const held = () => !ended && !flow.counting && plainBytes >= PLAIN_HIGH_WATER;
      for (;;) {
        while (held()) await new Promise<void>((resolve) => (pumpWaiter = resolve));
        if (ended) return;
        const plain = transport.receive.decrypt(await reader.next());
        if (++receiveCount % REKEY_INTERVAL === 0) transport.receive.rekey();
        if (plain[0] === CREDIT_FLAG) {
          sendCredit(flow.credited(readCredit(plain)));
          wakeSenders();
          continue;
        }
        if (!flow.received(fragmentCost(plain.length)))
          throw new Error("Peer overran its flow window");
        if (plainWaiter) {
          const waiter = plainWaiter;
          plainWaiter = undefined;
          waiter.resolve(plain);
        } else {
          plainQueue.push(plain);
          plainBytes += plain.length;
        }
      }
    } catch (error) {
      end(error instanceof Error ? error : new Error("Invalid message"));
    }
  })();
  /** The next decrypted data fragment; returns its credit once enough is consumed. */
  const nextPlain = async (): Promise<Uint8Array> => {
    let plain = plainQueue.shift();
    if (plain) {
      plainBytes -= plain.length;
      if (plainBytes < PLAIN_HIGH_WATER / 2) {
        const resume = pumpWaiter;
        pumpWaiter = undefined;
        resume?.();
      }
    } else {
      if (ended) throw new Error("Channel closed");
      plain = await new Promise<Uint8Array>((resolve, reject) => {
        plainWaiter = { resolve, reject };
      });
    }
    sendCredit(flow.consumed(fragmentCost(plain.length)));
    return plain;
  };
  socket.once("close", (code, reason) =>
    end(new RelayStreamClosed(code, reason.toString("utf8").slice(0, 123))),
  );
  socket.once("error", end);
  let compressible: ((message: Outgoing) => boolean) | undefined;
  const sendData = async (data: Uint8Array, kind: FragmentKind): Promise<void> => {
    if (ended) throw new Error("Channel closed");
    if (data.length > LOGICAL_MESSAGE_LIMIT || pendingBytes + data.length > LOGICAL_MESSAGE_LIMIT)
      throw new Error("Logical message or send queue too large");
    pendingBytes += data.length;
    const task = sending.then(async () => {
      const chunkSize = MAX_MESSAGE - 17;
      for (let offset = 0; offset < data.length; offset += chunkSize) {
        const chunk = data.subarray(offset, offset + chunkSize);
        const cost = fragmentCost(chunk.length + 1);
        const waiting = () => !ended && !flow.allows(cost);
        while (waiting()) await new Promise<void>((resolve) => creditWaiters.push(resolve));
        const wait = pace.take(clock.now());
        if (wait > 0) await new Promise<void>((resolve) => clock.schedule(wait, resolve));
        if (ended) throw new Error("Channel closed");
        flow.spend(cost);
        const plain = new Uint8Array(chunk.length + 1);
        plain[0] = kind + (offset + chunk.length === data.length ? 1 : 0);
        plain.set(chunk, 1);
        try {
          await sendFrame(socket, seal(plain));
        } finally {
          plain.fill(0);
        }
      }
    });
    sending = task.catch(() => {});
    try {
      await task;
    } catch (error) {
      end(error instanceof Error ? error : new Error("Send failed"));
      throw error;
    } finally {
      pendingBytes -= data.length;
      data.fill(0);
    }
  };
  /** One whole message: binary bytes, or its JSON text (inflated and UTF-8 checked). */
  const receivePayload = async (): Promise<Uint8Array | { text: string }> => {
    if (receiving) throw new Error("Concurrent receive is unsupported");
    receiving = true;
    const chunks: Uint8Array[] = [];
    let jsonBytes: Uint8Array | undefined;
    try {
      let size = 0;
      let kind: number | undefined;
      while (true) {
        const plain = await nextPlain();
        chunks.push(plain.subarray(1));
        const flag = plain[0];
        if (
          plain.length < 2 ||
          flag === undefined ||
          flag > 5 ||
          (flag % 2 === 0 && plain.length !== MAX_MESSAGE - 16)
        )
          throw new Error("Invalid encrypted fragment");
        const fragmentKind = flag - (flag % 2);
        if (kind !== undefined && kind !== fragmentKind) throw new Error("Mixed fragment kinds");
        kind = fragmentKind;
        size += plain.length - 1;
        if (kind === fragmentKinds.binary && size > BINARY_MESSAGE_LIMIT)
          throw new Error("Binary message too large");
        if (size > LOGICAL_MESSAGE_LIMIT) throw new Error("Logical message too large");
        if (flag % 2 === 1) break;
      }
      const data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      if (kind === fragmentKinds.binary) return data;
      jsonBytes = data;
      if (kind === fragmentKinds.deflated) {
        const inflated = inflateMessage(data);
        data.fill(0);
        jsonBytes = inflated;
      }
      return {
        text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(jsonBytes),
      };
    } catch (error) {
      end(error instanceof Error ? error : new Error("Invalid message"));
      throw error;
    } finally {
      for (const chunk of chunks) chunk.fill(0);
      jsonBytes?.fill(0);
      receiving = false;
    }
  };
  const channel: MessageChannel<Incoming, Outgoing> = {
    closed,
    get bufferedReceiveBytes() {
      return reader.bufferedBytes + plainBytes;
    },
    flowControl() {
      sendCredit(flow.start());
    },
    get bufferedBytes() {
      return pendingBytes + socket.bufferedAmount;
    },
    close() {
      locallyClosed = true;
      end();
    },
    async send(message) {
      const parsed = outgoing.parse(message);
      const json = new TextEncoder().encode(JSON.stringify(parsed));
      const deflated = compressible?.(parsed) ? deflateMessage(json) : undefined;
      if (!deflated) return sendData(json, fragmentKinds.json);
      json.fill(0);
      return sendData(deflated, fragmentKinds.deflated);
    },
    compress(allowed) {
      compressible = allowed;
    },
    async sendText(text, compress = false) {
      const json = new TextEncoder().encode(text);
      const deflated = compress ? deflateMessage(json) : undefined;
      if (!deflated) return sendData(json, fragmentKinds.json);
      json.fill(0);
      return sendData(deflated, fragmentKinds.deflated);
    },
    async receiveRaw() {
      const payload = await receivePayload();
      if (payload instanceof Uint8Array) {
        onReceive?.(payload);
        return payload;
      }
      onReceive?.(payload.text);
      return payload.text;
    },
    async sendBinary(bytes) {
      const data = z.instanceof(Uint8Array).parse(bytes);
      if (!data.length || data.length > BINARY_MESSAGE_LIMIT)
        return Promise.reject(new Error("Binary message too large"));
      // Retain immutable admitted bytes while earlier sends drain.
      return sendData(Uint8Array.from(data), fragmentKinds.binary);
    },
    async receiveBinary() {
      const frame = await channel.receiveFrame();
      if (!(frame instanceof Uint8Array)) {
        const error = new Error("Expected encrypted binary frame");
        end(error);
        throw error;
      }
      return frame;
    },
    async receive() {
      const message = await channel.receiveFrame();
      if (message instanceof Uint8Array) {
        const error = new Error("Expected JSON message");
        end(error);
        throw error;
      }
      return message;
    },
    async *frames() {
      while (true) {
        if (ended) return;
        try {
          yield await channel.receiveFrame();
        } catch (error) {
          if (locallyClosed) return;
          throw error;
        }
      }
    },
    async receiveFrame() {
      const payload = await receivePayload();
      if (payload instanceof Uint8Array) {
        onReceive?.(payload);
        return payload;
      }
      let message: Incoming;
      try {
        message = incoming.parse(JSON.parse(payload.text));
      } catch (error) {
        end(error instanceof Error ? error : new Error("Invalid message"));
        throw error;
      }
      onReceive?.(message);
      return message;
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (ended) return;
        try {
          yield await channel.receive();
        } catch (error) {
          if (locallyClosed) return;
          throw error;
        }
      }
    },
  };
  return channel;
}
