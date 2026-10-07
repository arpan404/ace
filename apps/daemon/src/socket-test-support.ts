import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { DeviceId, ServerMessage, type ClientMessage } from "@ace/protocol";
import { createDevThread, stubHandler, type CommandHandler } from "./commands.ts";
import { startServer, type ServerOptions } from "./server.ts";
import { Store } from "./store.ts";

export const token = "a".repeat(64);
export class Client {
  readonly socket: WebSocket;
  private messages: ServerMessage[] = [];
  private waiters: { resolve(message: ServerMessage): void; reject(error: Error): void }[] = [];
  private closed = false;
  constructor(url: string, options: import("ws").ClientOptions = {}) {
    this.socket = new WebSocket(url, options);
    this.socket.on("message", (data) => {
      const message = ServerMessage.parse(JSON.parse(data.toString()));
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(message);
      else this.messages.push(message);
    });
    this.socket.on("close", () => {
      this.closed = true;
      for (const waiter of this.waiters.splice(0))
        waiter.reject(new Error("Socket closed before next message"));
    });
  }
  next(): Promise<ServerMessage> {
    const message = this.messages.shift();
    return message
      ? Promise.resolve(message)
      : this.closed
        ? Promise.reject(new Error("Socket closed before next message"))
        : new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  /** The next message that isn't an unsolicited push of `type`, which may arrive at any time. */
  async nextSkipping(type: ServerMessage["type"]): Promise<ServerMessage> {
    for (;;) {
      const message = await this.next();
      if (message.type !== type) return message;
    }
  }
  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }
  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, "close");
    this.socket.close();
    await closed;
  }
}
export async function fixture(
  options: Partial<Omit<ServerOptions, "store" | "token" | "hostId" | "port">> = {},
) {
  const home = mkdtempSync(join(tmpdir(), "ace-socket-"));
  const store = new Store(join(home, "events.sqlite"));
  const workspace = store.createWorkspace("/repo", "Repo");
  const thread = createDevThread(store, workspace);
  const handler: CommandHandler = options.handler ?? stubHandler({ development: true });
  const server = await startServer({ port: 0, token, hostId: "host", store, handler, ...options });
  const clients: Client[] = [];
  const open = async () => {
    const client = new Client(server.url);
    clients.push(client);
    await once(client.socket, "open");
    return client;
  };
  return {
    home,
    store,
    thread,
    workspace,
    server,
    open,
    async connect(auth = token) {
      const client = await open();
      client.send({
        type: "hello",
        protocolVersion: 1,
        deviceId: DeviceId.parse("device"),
        token: auth,
      });
      return client;
    },
    async close() {
      for (const client of clients) await client.close();
      await server.close();
      await store.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
