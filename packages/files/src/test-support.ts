import { once } from "node:events";
import { fork } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { FilesServerMessage, type FileOperation } from "@ace/protocol";
import { attachFilesSocket, FilesService, type FilesOptions } from "./index.ts";

const Metrics = z.object({ type: z.literal("test.metrics"), rss: z.number(), peak: z.number() });
export type Message = FilesServerMessage | z.infer<typeof Metrics> | Buffer;
export class Client {
  readonly socket: WebSocket;
  readonly changes: Extract<FilesServerMessage, { type: "files.changed" }>[] = [];
  readonly frames: Buffer[] = [];
  private queued: Message[] = [];
  private waiters: { resolve(message: Message): void; reject(error: Error): void }[] = [];
  private ended = false;
  constructor(url: string) {
    this.socket = new WebSocket(url, { maxPayload: 1024 * 1024 });
    this.socket.on("message", (data, binary) => {
      const message = binary
        ? z.instanceof(Buffer).parse(data)
        : z.union([FilesServerMessage, Metrics]).parse(JSON.parse(data.toString()));
      if (!Buffer.isBuffer(message) && message.type === "files.changed") {
        this.changes.push(message);
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(message);
      else this.queued.push(message);
    });
    this.socket.on("close", () => {
      this.ended = true;
      for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("Socket closed"));
    });
  }
  next(): Promise<Message> {
    const message = this.queued.shift();
    if (message) return Promise.resolve(message);
    if (this.ended) return Promise.reject(new Error("Socket closed"));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }
  async request(operation: FileOperation): Promise<FilesServerMessage> {
    this.send({ type: "files.request", requestId: "req", operation });
    const response = await this.next();
    if (Buffer.isBuffer(response) || response.type === "test.metrics")
      throw new Error("Unexpected data");
    return response;
  }
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, "close");
    this.socket.close();
    await closed;
  }
}
export async function fixture(options: Partial<FilesOptions> = {}) {
  const home = await mkdtemp(join(tmpdir(), "ace-files-"));
  const root = join(home, "workspace");
  await mkdir(root);
  let service = await FilesService.create({
    workspace: root,
    artifactRoots: [root],
    dataDir: join(home, "data"),
    now: Date.now,
    id: randomUUID,
    authorize: (device, scope) => device !== "readonly" || scope === "files.read",
    ...options,
  });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 1024 * 1024 });
  server.on("connection", (socket, request) => {
    const session = attachFilesSocket(
      service,
      socket,
      request.url === "/readonly" ? "readonly" : "writer",
    );
    socket.on("message", (data, binary) => {
      if (binary) session.binary(z.instanceof(Buffer).parse(data));
      else session.accept(JSON.parse(data.toString()));
    });
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const clients: Client[] = [];
  const connect = async (readonly = false) => {
    const client = new Client(`ws://127.0.0.1:${address.port}/${readonly ? "readonly" : ""}`);
    clients.push(client);
    await once(client.socket, "open");
    return client;
  };
  return {
    home,
    root,
    get service() {
      return service;
    },
    connect,
    async restart() {
      for (const client of clients) await client.close();
      await service.close();
      service = await FilesService.create({
        workspace: root,
        dataDir: join(home, "data"),
        now: Date.now,
        id: randomUUID,
        authorize: () => true,
        ...options,
      });
    },
    async close() {
      for (const client of clients) await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await service.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
export async function isolated(root: string, data: string) {
  const child = fork(new URL("./test-server.ts", import.meta.url), [root, data], {
    execArgv: [],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const startup = await Promise.race([
    once(child, "message"),
    once(child, "exit").then(([code, signal]) => {
      throw new Error(`Transfer server exited: ${code}/${signal}`);
    }),
  ]);
  const { url } = z.object({ url: z.string() }).parse(startup[0]);
  const client = new Client(url);
  await once(client.socket, "open");
  return {
    client,
    async close() {
      await client.close();
      const exit = once(child, "exit");
      child.kill();
      await exit;
    },
  };
}
