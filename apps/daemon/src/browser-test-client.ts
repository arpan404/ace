import { once } from "node:events";
import { WebSocket } from "ws";
import { z } from "zod";
import { BrowserServerMessage, ServerMessage } from "@ace/protocol";

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
  constructor(url: string, options: import("ws").ClientOptions = {}) {
    this.socket = new WebSocket(url, options);
    this.socket.on("message", (data) => {
      const message = Message.parse(JSON.parse(data.toString()));
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
