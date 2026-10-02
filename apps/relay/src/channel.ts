import { ClientMessage, ServerMessage } from "@ace/protocol";
import type { Transport } from "@ace/secure-channel";
import { MAX_MESSAGE } from "@ace/secure-channel";
import type WebSocket from "ws";
import type { z } from "zod";
import { FrameReader, sendFrame } from "./socket.ts";
export type WireMessage = ClientMessage | ServerMessage;
export const LOGICAL_MESSAGE_LIMIT = 16 * 1024 * 1024;
const REKEY_INTERVAL = 1 << 20;
export interface MessageChannel<
  Incoming extends WireMessage,
  Outgoing extends WireMessage,
> extends AsyncIterable<Incoming> {
  send(message: Outgoing): Promise<void>;
  receive(): Promise<Incoming>;
  close(): void;
  readonly closed: Promise<Error | undefined>;
  readonly bufferedBytes: number;
  readonly bufferedReceiveBytes: number;
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
  onReceive: (message: ClientMessage) => void,
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
  onReceive?: (message: Incoming) => void,
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
      if (ended) throw new Error("Channel closed");
      const data = new TextEncoder().encode(JSON.stringify(outgoing.parse(message)));
      if (data.length > LOGICAL_MESSAGE_LIMIT || pendingBytes + data.length > LOGICAL_MESSAGE_LIMIT)
        throw new Error("Logical message or send queue too large");
      pendingBytes += data.length;
      const task = sending.then(async () => {
        const chunkSize = MAX_MESSAGE - 17;
        for (let offset = 0; offset < data.length; offset += chunkSize) {
          if (ended) throw new Error("Channel closed");
          const chunk = data.subarray(offset, offset + chunkSize);
          const plain = new Uint8Array(chunk.length + 1);
          plain[0] = offset + chunk.length === data.length ? 1 : 0;
          plain.set(chunk, 1);
          await sendFrame(socket, transport.send.encrypt(plain));
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
      }
    },
    async receive() {
      if (receiving) throw new Error("Concurrent receive is unsupported");
      receiving = true;
      try {
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const plain = transport.receive.decrypt(await reader.next());
          if (++receiveCount % REKEY_INTERVAL === 0) transport.receive.rekey();
          if (
            plain.length < 2 ||
            (plain[0] !== 0 && plain[0] !== 1) ||
            (plain[0] === 0 && plain.length !== MAX_MESSAGE - 16)
          )
            throw new Error("Invalid encrypted fragment");
          size += plain.length - 1;
          if (size > LOGICAL_MESSAGE_LIMIT) throw new Error("Logical message too large");
          chunks.push(plain.subarray(1));
          if (plain[0] === 1) break;
        }
        const data = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.length;
        }
        const message = incoming.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)),
        );
        onReceive?.(message);
        return message;
      } catch (error) {
        end(error instanceof Error ? error : new Error("Invalid message"));
        throw error;
      } finally {
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
