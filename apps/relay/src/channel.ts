import { ClientMessage, ServerMessage } from "@ace/protocol";
import type { Transport } from "@ace/secure-channel";
import {
  CREDIT_FLAG,
  FlowCredit,
  FragmentAssembler,
  INTERACTIVE,
  InFlightCap,
  LANE_CREDIT_STEP,
  MAX_MESSAGE,
  fragmentCost,
  fragmentFlag,
  fragmentKinds,
  readCredit,
  type FragmentKind,
  type Lane,
} from "@ace/secure-channel";
import type WebSocket from "ws";
import { deflateRaw, deflateRawSync, inflateRawSync } from "node:zlib";
import { z } from "zod";
import { SendQueue, type QueuedMessage } from "./send-queue.ts";
import { FrameReader, sendFrame } from "./socket.ts";
export type WireMessage = ClientMessage | ServerMessage;
export const BINARY_MESSAGE_LIMIT = 64 * 1024 + 16;
export const LOGICAL_MESSAGE_LIMIT = 16 * 1024 * 1024;
const REKEY_INTERVAL = 1 << 20;
/**
 * Decrypted fragments queued for a reader whose peer is not flow controlled. Past this the
 * channel stops reading the socket, so the relay connection's own backpressure applies.
 */
const PLAIN_HIGH_WATER = 256 * 1024;
/** Smaller JSON messages gain too little to be worth a deflate. */
const DEFLATE_THRESHOLD = 1024;
/**
 * From this size a deflate runs on zlib's thread pool (about 9 ms per MiB on the main thread
 * otherwise); smaller ones stay synchronous, where the hop would cost more than the work.
 */
const ASYNC_DEFLATE_FROM = 256 * 1024;
const CHUNK = MAX_MESSAGE - 17;

/** `deflated` when it is smaller than `json`; otherwise zeroed and undefined. */
function smaller(json: Uint8Array, deflated: Uint8Array): Uint8Array | undefined {
  if (deflated.length < json.length) return deflated;
  deflated.fill(0);
  return undefined;
}

/** Deflates a large JSON message off the event loop; tests may slow it or make it fail. */
export type DeflateLater = (json: Uint8Array) => Promise<Uint8Array>;

export function deflateLater(json: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    deflateRaw(json, { level: 6 }, (error, result) => (error ? reject(error) : resolve(result))),
  );
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
  /** Borrows immutable bytes until the returned promise settles; never clears them. */
  sendBinary(frame: Uint8Array): Promise<void>;
  receiveBinary(): Promise<Uint8Array>;
  close(): void;
  readonly closed: Promise<Error | undefined>;
}
export interface MessageChannel<Incoming extends WireMessage, Outgoing extends WireMessage>
  extends AsyncIterable<Incoming>, BinaryChannel {
  send(message: Outgoing): Promise<void>;
  sendBinary(bytes: Uint8Array, lane?: Lane): Promise<void>;
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
  sendText(json: string, compress?: boolean, lane?: Lane): Promise<void>;
  /**
   * The peer announced lanes (`hello.flowControl` has `lanes`, ADR 0110): from now on this end
   * reads bulk-lane fragments, returns credit every `LANE_CREDIT_STEP`, keeps about two
   * bandwidth-delay products in flight, and lets an interactive message's fragments go between
   * a bulk message's. Without it the channel frames exactly as before.
   */
  lanes?(): void;
  /** Whether `lanes` was called: `lane` arguments only matter then. */
  readonly interleaving?: boolean;
  /** Bytes queued in one lane, not yet handed to the socket. */
  queuedIn?(lane: Lane): number;
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
): ClientChannel {
  return createChannel(socket, reader, transport, ServerMessage, ClientMessage);
}
export function hostMessageChannel(
  socket: WebSocket,
  reader: FrameReader,
  transport: Transport,
  onReceive: (message: ClientMessage | Uint8Array | string) => void,
  authorize: () => void,
  deflate: DeflateLater = deflateLater,
): HostChannel {
  return Object.assign(
    createChannel(socket, reader, transport, ClientMessage, ServerMessage, onReceive, deflate),
    { authorize },
  );
}
function createChannel<Incoming extends WireMessage, Outgoing extends WireMessage>(
  socket: WebSocket,
  reader: FrameReader,
  transport: Transport,
  incoming: z.ZodType<Incoming>,
  outgoing: z.ZodType<Outgoing>,
  onReceive?: (message: Incoming | Uint8Array | string) => void,
  deflate: DeflateLater = deflateLater,
): MessageChannel<Incoming, Outgoing> {
  let resolveClosed: (error: Error | undefined) => void;
  const closed = new Promise<Error | undefined>((resolve) => {
    resolveClosed = resolve;
  });
  let ended = false,
    pendingBytes = 0,
    receiving = false,
    locallyClosed = false,
    pumping = false;
  let sendCount = 0,
    receiveCount = 0;
  const flow = new FlowCredit();
  const queue = new SendQueue();
  /** Set by `lanes`: the sender's own in-flight limit below the reader's window. */
  let pacing: InFlightCap | undefined;
  const assembler = new FragmentAssembler({
    lanes: false,
    binaryLimit: BINARY_MESSAGE_LIMIT,
    logicalLimit: LOGICAL_MESSAGE_LIMIT,
  });
  let laneAssembler: FragmentAssembler | undefined;
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
    assembler.clear();
    laneAssembler?.clear();
    plainWaiter?.reject(error ?? new Error("Channel closed"));
    plainWaiter = undefined;
    pumpWaiter?.();
    wakeSenders();
    for (const message of queue.drain()) message.settle(error ?? new Error("Channel closed"));
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
          const amount = readCredit(plain);
          sendCredit(flow.credited(amount));
          pacing?.credited(amount, performance.now());
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
  /**
   * Send queued fragments while flow control allows, one at a time: each pick takes the
   * interactive lane first, so a message queued now goes before the rest of a bulk one. Every
   * fragment is sealed right before it is written, so nonces follow the order on the wire.
   */
  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        if (ended) return;
        const message = queue.next();
        const data = message?.data;
        if (!message || !data) return;
        const chunk = data.subarray(message.offset, message.offset + CHUNK);
        const cost = fragmentCost(chunk.length + 1);
        if (!flow.allows(cost) || (pacing && flow.limited && !pacing.allows(cost))) {
          pacing?.waiting();
          await new Promise<void>((resolve) => creditWaiters.push(resolve));
          continue;
        }
        flow.spend(cost);
        if (flow.limited) pacing?.spent(cost, performance.now());
        const last = message.offset + chunk.length === data.length;
        const plain = new Uint8Array(chunk.length + 1);
        plain[0] = fragmentFlag(message.kind, last, message.lane);
        plain.set(chunk, 1);
        message.offset += chunk.length;
        queue.sent(message);
        try {
          await sendFrame(socket, seal(plain));
        } finally {
          plain.fill(0);
        }
        if (last) {
          queue.finish(message);
          message.settle();
        }
      }
    } catch (error) {
      end(error instanceof Error ? error : new Error("Send failed"));
    } finally {
      pumping = false;
    }
  };
  /**
   * Queue one message. `data` is undefined while `later` deflates it; the message keeps its
   * place in its lane meanwhile. Binary bytes are the caller's; anything else is zeroed after.
   */
  const enqueue = (
    data: Uint8Array | undefined,
    size: number,
    kind: FragmentKind,
    lane: Lane,
    later?: Promise<{ data: Uint8Array; kind: FragmentKind }>,
  ): Promise<void> => {
    if (ended) return Promise.reject(new Error("Channel closed"));
    if (size > LOGICAL_MESSAGE_LIMIT || pendingBytes + size > LOGICAL_MESSAGE_LIMIT)
      return Promise.reject(new Error("Logical message or send queue too large"));
    pendingBytes += size;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const message: QueuedMessage = {
        lane: queue.laneFor(lane),
        kind,
        data,
        offset: 0,
        bytes: size,
        settle(error) {
          if (settled) return;
          settled = true;
          pendingBytes -= message.bytes;
          if (message.kind !== fragmentKinds.binary) message.data?.fill(0);
          if (error) reject(error);
          else resolve();
        },
      };
      queue.push(message);
      later?.then(
        (done) => {
          if (ended) {
            done.data.fill(0);
            return;
          }
          pendingBytes += done.data.length - message.bytes;
          queue.recount(message, done.data.length);
          message.kind = done.kind;
          message.data = done.data;
          void pump();
        },
        (error: unknown) => end(error instanceof Error ? error : new Error("Deflate failed")),
      );
      void pump();
    }).catch((error: unknown) => {
      end(error instanceof Error ? error : new Error("Send failed"));
      throw error;
    });
  };
  /** JSON bytes, deflated first when asked and when that makes them smaller. */
  const sendJson = (json: Uint8Array, compress: boolean, lane: Lane): Promise<void> => {
    if (!compress || json.length < DEFLATE_THRESHOLD)
      return enqueue(json, json.length, fragmentKinds.json, lane);
    if (json.length < ASYNC_DEFLATE_FROM) {
      const deflated = smaller(json, deflateRawSync(json, { level: 6 }));
      if (!deflated) return enqueue(json, json.length, fragmentKinds.json, lane);
      json.fill(0);
      return enqueue(deflated, deflated.length, fragmentKinds.deflated, lane);
    }
    // A deflate that fails sends the message as it is: compression is only ever a saving.
    // A deflate that throws at once fails like one that rejects.
    const later = Promise.resolve(json)
      .then(deflate)
      .then(
        (result) => {
          const deflated = smaller(json, result);
          if (!deflated) return { data: json, kind: fragmentKinds.json };
          json.fill(0);
          return { data: deflated, kind: fragmentKinds.deflated };
        },
        () => ({ data: json, kind: fragmentKinds.json }),
      );
    return enqueue(undefined, json.length, fragmentKinds.json, lane, later);
  };
  /** One whole message: binary bytes, or its JSON text (inflated and UTF-8 checked). */
  const receivePayload = async (): Promise<Uint8Array | { text: string }> => {
    if (receiving) throw new Error("Concurrent receive is unsupported");
    receiving = true;
    let jsonBytes: Uint8Array | undefined;
    try {
      const assembling = laneAssembler ?? assembler;
      let whole = assembling.add(await nextPlain());
      while (!whole) whole = assembling.add(await nextPlain());
      const { kind, data } = whole;
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
    lanes() {
      if (queue.interleaving) return;
      queue.interleave();
      pacing = new InFlightCap();
      flow.creditOften(LANE_CREDIT_STEP);
      // Assembly so far had no lanes; what follows may, and nothing partial is ever moved.
      laneAssembler = new FragmentAssembler({
        lanes: true,
        binaryLimit: BINARY_MESSAGE_LIMIT,
        logicalLimit: LOGICAL_MESSAGE_LIMIT,
      });
    },
    get interleaving() {
      return queue.interleaving;
    },
    queuedIn(lane) {
      return queue.bytesIn(queue.laneFor(lane));
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
      return sendJson(json, compressible?.(parsed) === true, INTERACTIVE);
    },
    compress(allowed) {
      compressible = allowed;
    },
    async sendText(text, compress = false, lane = INTERACTIVE) {
      return sendJson(new TextEncoder().encode(text), compress, lane);
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
    async sendBinary(bytes, lane = INTERACTIVE) {
      const data = z.instanceof(Uint8Array).parse(bytes);
      if (!data.length || data.length > BINARY_MESSAGE_LIMIT)
        return Promise.reject(new Error("Binary message too large"));
      // The caller keeps these bytes immutable until the send completes.
      return enqueue(data, data.length, fragmentKinds.binary, lane);
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
