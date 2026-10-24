import { once } from "node:events";
import { WebSocket, type RawData } from "ws";
import { z } from "zod";
import { BrowserServerMessage, ServerMessage } from "@ace/protocol";
import { decodeStreamMessage, StreamAssembler, type StreamMessage } from "@ace/browser/stream";

const Message = z.union([BrowserServerMessage, ServerMessage]);
type Message = z.infer<typeof Message>;

export type { StreamMessage };

function toBytes(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}
export class BrowserClient {
  readonly socket: WebSocket;
  private messages: Message[] = [];
  private waiters: {
    predicate: (message: Message) => boolean;
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
  }[] = [];
  private assembler = new StreamAssembler();
  private streams: StreamMessage[] = [];
  private streamWaiters: {
    predicate: (message: StreamMessage) => boolean;
    resolve: (message: StreamMessage) => void;
    reject: (error: Error) => void;
  }[] = [];
  private closed = false;
  private streamError: Error | undefined;
  receiveCatalogPushes = false;
  constructor(url: string, options: import("ws").ClientOptions = {}) {
    this.socket = new WebSocket(url, options);
    this.socket.on("message", (data, isBinary) => {
      if (isBinary) {
        let stream: StreamMessage | undefined;
        try {
          const envelope = this.assembler.push(toBytes(data));
          if (!envelope) return;
          stream = decodeStreamMessage(envelope);
        } catch (error) {
          this.streamError = error instanceof Error ? error : new Error("Invalid browser stream");
          for (const waiter of this.streamWaiters.splice(0)) waiter.reject(this.streamError);
          this.socket.terminate();
          return;
        }
        if (!stream) return;
        const decoded = stream;
        const index = this.streamWaiters.findIndex((waiter) => waiter.predicate(decoded));
        const waiter = this.streamWaiters[index];
        if (waiter) {
          this.streamWaiters.splice(index, 1);
          waiter.resolve(stream);
        } else this.streams.push(stream);
        return;
      }
      const bytes = toBytes(data);
      const message = Message.parse(JSON.parse(new TextDecoder().decode(bytes)));
      if (message.type === "models.changed" && !this.receiveCatalogPushes) return;
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      const waiter = this.waiters[index];
      if (waiter) {
        this.waiters.splice(index, 1);
        waiter.resolve(message);
      } else this.messages.push(message);
    });
    this.socket.on("close", () => {
      this.closed = true;
      for (const waiter of this.waiters.splice(0))
        waiter.reject(new Error("Browser socket closed"));
      for (const waiter of this.streamWaiters.splice(0))
        waiter.reject(new Error("Browser socket closed"));
    });
  }
  next(predicate: (message: Message) => boolean): Promise<Message> {
    const index = this.messages.findIndex(predicate);
    const message = this.messages[index];
    if (message) {
      this.messages.splice(index, 1);
      return Promise.resolve(message);
    }
    if (this.closed) return Promise.reject(new Error("Browser socket closed"));
    return new Promise((resolve, reject) => this.waiters.push({ predicate, resolve, reject }));
  }
  nextStream(predicate: (message: StreamMessage) => boolean): Promise<StreamMessage> {
    if (this.streamError) return Promise.reject(this.streamError);
    const index = this.streams.findIndex(predicate);
    const message = this.streams[index];
    if (message) {
      this.streams.splice(index, 1);
      return Promise.resolve(message);
    }
    if (this.closed) return Promise.reject(new Error("Browser socket closed"));
    return new Promise((resolve, reject) =>
      this.streamWaiters.push({ predicate, resolve, reject }),
    );
  }
  async hello(token: string) {
    if (this.socket.readyState === WebSocket.CONNECTING) await once(this.socket, "open");
    this.send({ type: "hello", protocolVersion: 1, deviceId: "device", token });
    return this.next((message) => message.type === "welcome");
  }
  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }
  async request(message: { type: string; requestId: string; [key: string]: unknown }) {
    this.send(message);
    return this.next(
      (reply) => reply.type === "browser.result" && reply.requestId === message.requestId,
    );
  }
  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, "close");
    // Teardown must not wait for a peer close handshake under worker load.
    this.socket.terminate();
    await closed;
  }
}
