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
import { deflateRaw, deflateRawSync, inflateRawSync } from "node:zlib";
import { z } from "zod";
import { FrameReader, sendFrame } from "./socket.ts";
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

/**
 * From this size a deflate runs on zlib's thread pool rather than the event loop (about 9 ms
 * per MiB there); smaller ones stay synchronous, where the hop would cost more than the work.
 */
const ASYNC_DEFLATE_FROM = 256 * 1024;
/** The goodbye is never refused for room; it is at most this long. */
const GOODBYE_LIMIT = 1024;

/** A message's bytes as they go out: JSON, deflated JSON or binary. */
interface Prepared {
  data: Uint8Array;
  kind: FragmentKind;
}

/** Deflates a large JSON message off the event loop; tests may slow it down or make it fail. */
export type DeflateLater = (json: Uint8Array) => Promise<Uint8Array>;

export function deflateLater(json: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    deflateRaw(json, { level: 6 }, (error, result) => (error ? reject(error) : resolve(result))),
  );
}

/** `deflated` when it is smaller than `json` (which is then zeroed); otherwise `json` as is. */
function smaller(json: Uint8Array, deflated: Uint8Array): Prepared {
  if (deflated.length < json.length) {
    json.fill(0);
    return { data: deflated, kind: fragmentKinds.deflated };
  }
  deflated.fill(0);
  return { data: json, kind: fragmentKinds.json };
}

/** Where a channel reports what it recovers from: a deflate that failed. */
export type ChannelLog = (error: Error) => void;

/** The fallback for a deflate that failed: the message as it is, and one line saying so. */
function uncompressed(json: Uint8Array, error: unknown, log: ChannelLog | undefined): Prepared {
  log?.(
    new Error(`Relay deflate failed for a ${json.length}-byte message; sent uncompressed`, {
      cause: error,
    }),
  );
  return { data: json, kind: fragmentKinds.json };
}

/** A JSON message deflated at once on the event loop when asked and when that makes it smaller. */
function prepareNow(json: Uint8Array, compress: boolean, log: ChannelLog | undefined): Prepared {
  if (!compress || json.length < DEFLATE_THRESHOLD) return { data: json, kind: fragmentKinds.json };
  try {
    return smaller(json, deflateRawSync(json, { level: 6 }));
  } catch (error) {
    return uncompressed(json, error, log);
  }
}

/** A large JSON message deflated off the event loop; one whose deflate fails goes as it is. */
function prepareLater(
  json: Uint8Array,
  deflate: DeflateLater,
  log: ChannelLog | undefined,
): Promise<Prepared> {
  // A deflate that throws at once fails like one that rejects.
  return Promise.resolve(json)
    .then(deflate)
    .then(
      (deflated) => smaller(json, deflated),
      (error: unknown) => uncompressed(json, error, log),
    );
}

/**
 * The least a deflate can shrink `size` bytes to: deflate's best ratio is about 1032 to 1. A
 * message that can't fit even at that size is refused before it is deflated.
 */
function leastDeflated(size: number): number {
  return Math.ceil(size / 1032);
}

/** Zero a sent (or dropped) message's bytes; binary bytes are the caller's. */
function release(message: Prepared): void {
  if (message.kind !== fragmentKinds.binary) message.data.fill(0);
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
  sendBinary(bytes: Uint8Array): Promise<void>;
  receiveFrame(): Promise<Incoming | Uint8Array>;
  frames(): AsyncIterable<Incoming | Uint8Array>;
  receive(): Promise<Incoming>;
  close(): void;
  readonly closed: Promise<Error | undefined>;
  /**
   * Bytes queued and not yet written to the socket, plus the socket's own: what callers pace
   * themselves by. A message still being deflated counts once its deflated size is known, as
   * when deflates ran at once; the channel's 16 MiB limit holds room for it meanwhile.
   */
  readonly bufferedBytes: number;
  /** Sends queued and not yet settled: zero once everything sent has gone (or failed). */
  readonly unsentMessages: number;
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
   * Send the channel's goodbye (at most 1 KiB): never deflated and never refused for room, in
   * order after everything sent before it. Only the first call sends; any later one returns
   * the first one's promise.
   */
  sendGoodbye(json: string): Promise<void>;
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
  options: ChannelOptions = {},
): HostChannel {
  return Object.assign(
    createChannel(socket, reader, transport, ClientMessage, ServerMessage, onReceive, options),
    { authorize },
  );
}
export interface ChannelOptions {
  /** Deflates large messages off the event loop; tests slow it down or make it fail. */
  deflate?: DeflateLater | undefined;
  /** Hears about what the channel recovers from on its own (a deflate that failed). */
  log?: ChannelLog | undefined;
}
function createChannel<Incoming extends WireMessage, Outgoing extends WireMessage>(
  socket: WebSocket,
  reader: FrameReader,
  transport: Transport,
  incoming: z.ZodType<Incoming>,
  outgoing: z.ZodType<Outgoing>,
  onReceive?: (message: Incoming | Uint8Array | string) => void,
  options: ChannelOptions = {},
): MessageChannel<Incoming, Outgoing> {
  const deflate = options.deflate ?? deflateLater;
  let resolveClosed: (error: Error | undefined) => void;
  const closed = new Promise<Error | undefined>((resolve) => {
    resolveClosed = resolve;
  });
  let ended = false,
    /**
     * Bytes held for unsent messages, at most 16 MiB: final sizes, and for a message still
     * being deflated off the event loop, its uncompressed size until the deflate finishes.
     */
    readyBytes = 0,
    /** The part of `readyBytes` held for messages still being deflated. */
    deflatingBytes = 0,
    sending = Promise.resolve(),
    receiving = false,
    locallyClosed = false;
  let sendCount = 0,
    receiveCount = 0;
  const flow = new FlowCredit();
  // Fragments decrypted as they arrive, so a credit is seen even while the reader is busy.
  const plainQueue: Uint8Array[] = [];
  let plainBytes = 0;
  let plainWaiter: { resolve(plain: Uint8Array): void; reject(error: Error): void } | undefined;
  let pumpWaiter: (() => void) | undefined;
  const creditWaiters: (() => void)[] = [];
  const wakeSenders = () => {
    for (const wake of creditWaiters.splice(0)) wake();
  };
  /**
   * Every send not yet settled: its bytes counted as ready, and how to settle it. A send leaves
   * the set when it settles, so nothing of a sent message stays reachable from the channel.
   */
  const unsent = new Set<{ counted: number; settle(error?: Error): void }>();
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
    // Every queued and in-flight send is refused at once; a deflate that finishes later is
    // discarded (its bytes zeroed) and counts for nothing.
    // Settling a send removes it from the set, which iteration allows.
    for (const send of unsent) send.settle(new Error("Channel closed"));
    readyBytes = 0;
    deflatingBytes = 0;
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
  /** The goodbye, once sent: there is only ever one. */
  let goodbye: Promise<void> | undefined;
  /**
   * Refuse a message that can't be queued: the channel ended, or `size` more bytes ready to
   * send would pass the 16 MiB limit (the same check, on the same bytes, as before deflates
   * left the event loop).
   */
  const fits = (size: number): void => {
    if (ended) throw new Error("Channel closed");
    if (readyBytes + size > LOGICAL_MESSAGE_LIMIT)
      throw new Error("Logical message or send queue too large");
  };
  /**
   * Queue an admitted message, counted as `counted` ready bytes: its final size, or for one
   * still being deflated its uncompressed size, recounted at its deflated size once known.
   * Messages go strictly in the order they were queued: one still being deflated holds back
   * every message behind it (and the goodbye), as a slow synchronous deflate would, without
   * blocking the event loop meanwhile. If the channel ends first, the send is refused at once.
   */
  const sendData = (prepared: Prepared | Promise<Prepared>, counted: number): Promise<void> => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const record = {
      counted,
      deflating: prepared instanceof Promise,
      settle(error?: Error) {
        if (!unsent.delete(record)) return;
        readyBytes -= record.counted;
        if (record.deflating) deflatingBytes -= record.counted;
        // Never rejects: a failed deflate already fell back to the message as it was.
        void Promise.resolve(prepared).then(release);
        if (error) reject(error);
        else resolve();
      },
    };
    unsent.add(record);
    const ready =
      prepared instanceof Promise
        ? prepared.then((message) => {
            // Settled already (the channel ended): a late deflate counts for nothing.
            if (unsent.has(record)) {
              readyBytes += message.data.length - record.counted;
              deflatingBytes -= record.counted;
              record.counted = message.data.length;
              record.deflating = false;
            }
            return message;
          })
        : prepared;
    const task = sending.then(async () => {
      if (!unsent.has(record)) throw new Error("Channel closed");
      const { data, kind } = await ready;
      const chunkSize = MAX_MESSAGE - 17;
      for (let offset = 0; offset < data.length; offset += chunkSize) {
        const chunk = data.subarray(offset, offset + chunkSize);
        const cost = fragmentCost(chunk.length + 1);
        const waiting = () => !ended && !flow.allows(cost);
        while (waiting()) await new Promise<void>((wake) => creditWaiters.push(wake));
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
    sending = task.then(
      () => record.settle(),
      (error: unknown) => {
        const failure = error instanceof Error ? error : new Error("Send failed");
        // This send's own error first; ending the channel then refuses the rest.
        record.settle(failure);
        end(failure);
      },
    );
    return promise;
  };
  /**
   * Queue JSON bytes, deflated first when asked and when that makes them smaller. A large one
   * is deflated off the event loop when the ready limit has room for it undeflated, held at that
   * size until its deflate finishes; any other is deflated at once and then checked, as before.
   * A send that can't fit even at deflate's best ratio is refused before it is deflated.
   */
  const sendJson = (json: Uint8Array, compress: boolean): Promise<void> => {
    let queued: Promise<void>;
    try {
      queued = queueJson(json, compress);
    } catch (error) {
      // Refused before it was handed over: nothing else holds these bytes.
      json.fill(0);
      return Promise.reject(error instanceof Error ? error : new Error("Send refused"));
    }
    return queued;
  };
  /** Admit and queue JSON bytes (see `sendJson`); throws when it refuses them. */
  const queueJson = (json: Uint8Array, compress: boolean): Promise<void> => {
    const size = json.length;
    if (!compress || size < DEFLATE_THRESHOLD) {
      if (size > LOGICAL_MESSAGE_LIMIT) throw new Error("Logical message or send queue too large");
      fits(size);
      readyBytes += size;
      return sendData({ data: json, kind: fragmentKinds.json }, size);
    }
    // One that can't fit even at deflate's best ratio is refused before any deflate.
    fits(leastDeflated(size));
    if (size >= ASYNC_DEFLATE_FROM && readyBytes + size <= LOGICAL_MESSAGE_LIMIT) {
      // Off the event loop, holding room for its largest outcome (sent as it is) until done.
      readyBytes += size;
      deflatingBytes += size;
      return sendData(prepareLater(json, deflate, options.log), size);
    }
    // Small, or too big to hold room for undeflated: on the event loop, then checked, as a
    // channel always did.
    const now = prepareNow(json, true, options.log);
    try {
      if (now.data.length > LOGICAL_MESSAGE_LIMIT)
        throw new Error("Logical message or send queue too large");
      fits(now.data.length);
    } catch (error) {
      release(now);
      throw error;
    }
    readyBytes += now.data.length;
    return sendData(now, now.data.length);
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
    // As when every deflate ran at once: a message still being deflated counts once its size
    // is known. The channel's own limit holds room for it meanwhile (`readyBytes`).
    get bufferedBytes() {
      return readyBytes - deflatingBytes + socket.bufferedAmount;
    },
    get unsentMessages() {
      return unsent.size;
    },
    close() {
      locallyClosed = true;
      end();
    },
    async send(message) {
      const parsed = outgoing.parse(message);
      const json = new TextEncoder().encode(JSON.stringify(parsed));
      return sendJson(json, compressible?.(parsed) === true);
    },
    compress(allowed) {
      compressible = allowed;
    },
    sendGoodbye(text) {
      goodbye ??= (async () => {
        const json = new TextEncoder().encode(text);
        if (ended) throw new Error("Channel closed");
        if (json.length > GOODBYE_LIMIT) throw new Error("Goodbye too long");
        readyBytes += json.length;
        return sendData({ data: json, kind: fragmentKinds.json }, json.length);
      })();
      return goodbye;
    },
    async sendText(text, compress = false) {
      return sendJson(new TextEncoder().encode(text), compress);
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
      // The caller keeps these bytes immutable until the send completes.
      fits(data.length);
      readyBytes += data.length;
      return sendData({ data, kind: fragmentKinds.binary }, data.length);
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
