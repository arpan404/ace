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
  private waiters: ((message: ServerMessage) => void)[] = [];
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (data) => {
      const message = ServerMessage.parse(JSON.parse(data.toString()));
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.messages.push(message);
    });
  }
  next(): Promise<ServerMessage> {
    const message = this.messages.shift();
    return message
      ? Promise.resolve(message)
      : new Promise((resolve) => this.waiters.push(resolve));
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
  return {
    home,
    store,
    thread,
    workspace,
    server,
    async connect(auth = token) {
      const client = new Client(server.url);
      clients.push(client);
      await once(client.socket, "open");
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
      store.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
