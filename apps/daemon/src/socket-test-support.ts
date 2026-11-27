import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  /** Catalog pushes can arrive between any request and its reply; only catalog tests read them. */
  receiveCatalogPushes = false;
  receiveQuotaPushes = false;
  constructor(url: string, options: import("ws").ClientOptions = {}) {
    this.socket = new WebSocket(url, options);
    this.socket.on("message", (data) => {
      const message = ServerMessage.parse(JSON.parse(data.toString()));
      if (
        (message.type === "models.changed" || message.type === "providers.changed") &&
        !this.receiveCatalogPushes
      )
        return;
      if (message.type === "usage.limits_changed" && !this.receiveQuotaPushes) return;
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
/**
 * `ACE_TEST_DAEMON_BINARY`, test-only: run these fixtures against `ace-daemon-bin`
 * instead of the in-process server. The binary gets the fixture's own token and
 * `host-id` so a test's hello and `hostId` are unchanged; no TypeScript runs in it.
 */
const daemonBinary = () => process.env.ACE_TEST_DAEMON_BINARY;

async function binaryFixture(
  options: Partial<Omit<ServerOptions, "store" | "token" | "hostId" | "port">> & {
    binaryEnv?: Record<string, string | undefined>;
  },
) {
  const home = mkdtempSync(join(tmpdir(), "ace-bin-"));
  writeFileSync(join(home, "daemon-token"), token, { mode: 0o600 });
  writeFileSync(join(home, "host-id"), "host", { mode: 0o600 });
  // The current format, so the binary adopts this home instead of setting it aside.
  writeFileSync(
    join(home, "ace-format.json"),
    `${JSON.stringify({ format: "ace-v1", createdAt: new Date(0).toISOString() })}\n`,
    { mode: 0o600 },
  );
  const remote = options.remote !== undefined;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.binaryEnv,
    HOME: home,
    ACE_HOME: home,
    ACE_PORT: "0",
    ACE_LOG_LEVEL: "silent",
    ACE_LISTEN: remote ? "lan" : "local",
    ACE_ADVERTISE_HOST: "127.0.0.1",
    ACE_REMOTE_PORT: "0",
    // No provider CLI is reachable from a fixture's daemon.
    PATH: "",
  };
  if (options.ready) env.ACE_TEST_STARTUP_HOLD_MS = "600";
  const limits = (options as { ticketLimits?: Record<string, number> }).ticketLimits;
  if (limits) env.ACE_TEST_TICKET_LIMITS = JSON.stringify(limits);
  const child = spawn(daemonBinary() ?? "", ["serve", "--json"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr?.on("data", (chunk: Buffer) => (errors += chunk.toString()));
  const started = await new Promise<{ url: string; remoteUrl?: string; fingerprint?: string }>(
    (resolve, reject) => {
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const line = output.split("\n")[0];
        if (!line?.startsWith("{")) return;
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error(`ace-daemon-bin wrote no start line: ${output}`));
        }
      });
      child.once("exit", (code) =>
        reject(new Error(`ace-daemon-bin exited ${code} before ready: ${errors}`)),
      );
    },
  );
  const httpUrl = readFileSync(join(home, "daemon-endpoint"), "utf8");
  const clients: Client[] = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const client of clients) await client.close().catch(() => {});
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    rmSync(home, { recursive: true, force: true });
  };
  const open = async (socketOptions: import("ws").ClientOptions = {}) => {
    const client = new Client(started.url, socketOptions);
    clients.push(client);
    await once(client.socket, "open");
    return client;
  };
  const unavailable = new Proxy(
    {},
    {
      get() {
        throw new Error(
          "The in-process store is unavailable against ace-daemon-bin; use its HTTP routes",
        );
      },
    },
  );
  return {
    binary: true as const,
    home,
    store: unavailable,
    thread: unavailable,
    workspace: unavailable,
    server: {
      url: started.url,
      httpUrl,
      remoteUrl: started.remoteUrl,
      fingerprint: started.fingerprint,
      close,
    },
    open,
    async connect(auth = token, socketOptions: import("ws").ClientOptions = {}) {
      const client = await open(socketOptions);
      client.send({
        type: "hello",
        protocolVersion: 1,
        deviceId: DeviceId.parse("device"),
        token: auth,
      });
      return client;
    },
    close,
  };
}

export async function fixture(
  options: Partial<Omit<ServerOptions, "store" | "token" | "hostId" | "port">> & {
    /** Test-only environment for `ace-daemon-bin`. */
    binaryEnv?: Record<string, string | undefined>;
  } = {},
  /** Services that need the fixture's own store and home. */
  withStore?: (
    store: Store,
    home: string,
  ) => Partial<Omit<ServerOptions, "store" | "token" | "hostId" | "port">>,
) {
  if (daemonBinary()) return (await binaryFixture(options)) as never;
  const home = mkdtempSync(join(tmpdir(), "ace-socket-"));
  const store = new Store(join(home, "events.sqlite"));
  options = { ...options, ...withStore?.(store, home) };
  const workspace = store.createWorkspace("/repo", "Repo");
  const thread = createDevThread(store, workspace);
  const handler: CommandHandler = options.handler ?? stubHandler({ development: true });
  const server = await startServer({ port: 0, token, hostId: "host", store, handler, ...options });
  const clients: Client[] = [];
  const open = async (socketOptions: import("ws").ClientOptions = {}) => {
    const client = new Client(server.url, socketOptions);
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
    async connect(auth = token, socketOptions: import("ws").ClientOptions = {}) {
      const client = await open(socketOptions);
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
