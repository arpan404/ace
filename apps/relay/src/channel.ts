import { ClientMessage, ServerMessage } from "@ace/protocol";
import type { Transport } from "@ace/secure-channel";
import { MAX_MESSAGE } from "@ace/secure-channel";
import type WebSocket from "ws";
import { deflateRawSync, inflateRawSync } from "node:zlib";
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
   * From now on, deflate each JSON message `allowed` passes, alone (no context carries over),
   * before it is encrypted. Only for a peer that said it inflates (`hello.compression`).
   */
  compress?(allowed: (message: Outgoing) => boolean): void;
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
  onReceive: (message: ClientMessage | Uint8Array) => void,
  authorize: () => void,
): HostChannel {
  return Object.assign(
    createChannel(socket, reader, transport, ClientMessage, ServerMessage, onReceive),
    { authorize },
  );
}
function createChannel<Incoming extends WireMessage, Outgoing extends WireMessage>(
  socket: WebSocket,
  reader: FrameReader,
  transport: Transport,
  incoming: z.ZodType<Incoming>,
  outgoing: z.ZodType<Outgoing>,
  onReceive?: (message: Incoming | Uint8Array) => void,
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
  const end = (error?: Error) => {
    if (ended) return;
    ended = true;
    transport.destroy();
    reader.fail(error ?? new Error("Channel closed"));
    socket.terminate();
    resolveClosed(error);
  };
  socket.once("close", (code) => end(new Error(`Channel connection closed (${code})`)));
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
        if (ended) throw new Error("Channel closed");
        const chunk = data.subarray(offset, offset + chunkSize);
        const plain = new Uint8Array(chunk.length + 1);
        plain[0] = kind + (offset + chunk.length === data.length ? 1 : 0);
        plain.set(chunk, 1);
        try {
          await sendFrame(socket, transport.send.encrypt(plain));
        } finally {
          plain.fill(0);
        }
        if (++sendCount % REKEY_INTERVAL === 0) transport.send.rekey();
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
  const channel: MessageChannel<Incoming, Outgoing> = {
    closed,
    get bufferedReceiveBytes() {
      return reader.bufferedBytes;
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
      if (receiving) throw new Error("Concurrent receive is unsupported");
      receiving = true;
      const chunks: Uint8Array[] = [];
      let jsonBytes: Uint8Array | undefined;
      try {
        let size = 0;
        let kind: number | undefined;
        while (true) {
          const plain = transport.receive.decrypt(await reader.next());
          chunks.push(plain.subarray(1));
          if (++receiveCount % REKEY_INTERVAL === 0) transport.receive.rekey();
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
        if (kind === fragmentKinds.binary) {
          onReceive?.(data);
          return data;
        }
        jsonBytes = data;
        if (kind === fragmentKinds.deflated) {
          const inflated = inflateMessage(data);
          data.fill(0);
          jsonBytes = inflated;
        }
        const message = incoming.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes)),
        );
        onReceive?.(message);
        return message;
      } catch (error) {
        end(error instanceof Error ? error : new Error("Invalid message"));
        throw error;
      } finally {
        for (const chunk of chunks) chunk.fill(0);
        jsonBytes?.fill(0);
        receiving = false;
      }
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
