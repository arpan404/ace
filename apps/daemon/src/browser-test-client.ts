import { once } from "node:events";
import { WebSocket } from "ws";
import { z } from "zod";
import { BrowserServerMessage, ServerMessage } from "@ace/protocol";
import { StreamAssembler, decodeStreamMessage, type StreamMessage } from "@ace/browser/stream";

const Message = z.union([BrowserServerMessage, ServerMessage]);
type Message = z.infer<typeof Message>;
export class BrowserClient {
  readonly socket: WebSocket;
  private messages: Message[] = [];
  private waiters: {
    predicate: (message: Message) => boolean;
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
  }[] = [];
  private closed = false;
  receiveCatalogPushes = false;
  constructor(url: string, options: import("ws").ClientOptions = {}) {
    this.socket = new WebSocket(url, options);
    this.socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.receiveStream(data);
        return;
      }
      const message = Message.parse(JSON.parse(data.toString()));
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
    });
  }
  /** Binary stream messages (video, audio, pictures) received so far, decoded. */
  readonly streamed: StreamMessage[] = [];
  private assembler = new StreamAssembler();
  private streamWaiters: { predicate: (message: StreamMessage) => boolean; resolve(): void }[] = [];
  private receiveStream(data: import("ws").RawData): void {
    const pieces = Array.isArray(data) ? data : [data];
    for (const piece of pieces) {
      const envelope = this.assembler.push(new Uint8Array(piece));
      const message = envelope && decodeStreamMessage(envelope);
      if (!message) continue;
      this.streamed.push(message);
      this.streamWaiters = this.streamWaiters.filter((waiter) => {
        if (!waiter.predicate(message)) return true;
        waiter.resolve();
        return false;
      });
    }
  }
  /** Resolves once a binary stream message matching `predicate` has arrived. */
  untilStreamed(predicate: (message: StreamMessage) => boolean): Promise<void> {
    if (this.streamed.some(predicate)) return Promise.resolve();
    return new Promise((resolve) => this.streamWaiters.push({ predicate, resolve }));
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
