import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { discoverProviders, type DiscoveryOptions } from "@ace/provider-kit/discovery";
import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import { readSse } from "@ace/provider-kit/sse";
import type { Frame } from "@ace/engine-api";
import { supportedVersion } from "./capabilities.ts";
import { object, string } from "./data.ts";
export type ServerConsumer = {
  receive(data: unknown): void;
  frame(dir: Frame["dir"], channel: string, data: unknown): void;
  disconnected(): void;
  buffered(data: unknown): void;
  recovered(): void;
  resync(): Promise<void>;
  exited(deliberate: boolean, message?: string): void;
};
export type ServerOptions = { discovery?: DiscoveryOptions; startupTimeoutMs?: number };
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot allocate OpenCode port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
/** One owner per adapter instance, shared by all thread sessions. */
export class OpenCodeServer {
  private consumers = new Set<ServerConsumer>();
  private process?: SupervisedProcess;
  private controller = new AbortController();
  private opening: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private base?: URL;
  private authorization = "";
  private stream?: Promise<void>;
  private deliberate = false;
  private recovering = false;
  private buffered: unknown[] = [];
  private recovery: Promise<void> | undefined;
  private sequences = new Map<string, number>();
  private pendingLogs: { dir: Frame["dir"]; channel: string; data: unknown }[] = [];
  private options: ServerOptions;
  constructor(options: ServerOptions = {}) {
    this.options = options;
  }
  subscribe(consumer: ServerConsumer): () => void {
    this.consumers.add(consumer);
    for (const log of this.pendingLogs.splice(0)) consumer.frame(log.dir, log.channel, log.data);
    return () => this.consumers.delete(consumer);
  }
  async ready(): Promise<void> {
    if (this.closing) await this.closing;
    if (this.controller.signal.aborted) {
      this.controller = new AbortController();
      this.opening = undefined;
      this.deliberate = false;
      this.sequences.clear();
      this.pendingLogs = [];
      this.buffered = [];
      this.recovering = false;
    }
    this.opening ??= this.start();
    await this.opening;
  }
  private async start(): Promise<void> {
    const cli = (await discoverProviders(this.options.discovery)).opencode;
    if (!cli.installed || !cli.path) throw new Error(cli.error ?? "OpenCode is not installed");
    if (!supportedVersion(cli.version)) throw new Error("OpenCode >=1.18.33 and <2 is required");
    this.controller.signal.throwIfAborted();
    const password = randomBytes(32).toString("base64url");
    const port = await freePort();
    this.controller.signal.throwIfAborted();
    this.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    const proc = spawnSupervised({
      command: cli.path,
      args: ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
      env: {
        ...this.options.discovery?.env,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_SERVER_USERNAME: "opencode",
        OPENCODE_CLIENT: "cli",
        OPENCODE_EXPERIMENTAL_PLAN_MODE: "1",
      },
      name: "opencode-server",
    });
    this.process = proc;
    const log = (dir: Frame["dir"], channel: string, data: unknown) => {
      if (!this.consumers.size) this.pendingLogs.push({ dir, channel, data });
      else for (const c of this.consumers) c.frame(dir, channel, data);
    };
    proc.stdout.on("line", (line) => log("recv", "stdout", line));
    proc.stderr.on("line", (line) => log("stderr", "stderr", line));
    void proc.exited.then((exit) => {
      this.controller.abort();
      for (const c of this.consumers) c.exited(this.deliberate, `OpenCode exited: ${exit.reason}`);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("OpenCode startup timed out"));
        }, this.options.startupTimeoutMs ?? 30_000);
        const onLine = (line: string) => {
          if (/opencode server listening on/.test(line)) {
            this.base = new URL(`http://127.0.0.1:${port}`);
            cleanup();
            resolve();
          }
        };
        const onAbort = () => {
          cleanup();
          reject(new Error("OpenCode exited before listening"));
        };
        const cleanup = () => {
          clearTimeout(timer);
          proc.stdout.off("line", onLine);
          proc.signal.removeEventListener("abort", onAbort);
        };
        proc.stdout.on("line", onLine);
        proc.signal.addEventListener("abort", onAbort, { once: true });
        if (proc.signal.aborted) onAbort();
      });
      let connected: (() => void) | undefined;
      const connection = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("OpenCode SSE handshake timed out"));
        }, this.options.startupTimeoutMs ?? 30_000);
        const onAbort = () => {
          cleanup();
          reject(new Error("OpenCode exited during SSE handshake"));
        };
        const cleanup = () => {
          clearTimeout(timer);
          this.controller.signal.removeEventListener("abort", onAbort);
        };
        connected = () => {
          cleanup();
          resolve();
        };
        this.controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      this.stream = readSse(new URL("/global/event", this.base), {
        signal: this.controller.signal,
        headers: { authorization: this.authorization },
        onEvent: ({ data }) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = { payload: { type: "malformed", properties: { data } } };
          }
          const p = object(object(parsed).payload);
          if (p.type === "server.connected") connected?.();
          const sync = object(p.syncEvent);
          if (
            p.type === "sync" &&
            typeof sync.seq === "number" &&
            typeof sync.aggregateID === "string"
          ) {
            const before = this.sequences.get(sync.aggregateID);
            this.sequences.set(sync.aggregateID, sync.seq);
            if (before !== undefined && sync.seq > before + 1) {
              this.beginRecovery();
              void this.recover();
            }
          }
          if (this.recovering) {
            this.buffered.push(parsed);
            if (p.type === "server.connected") void this.recover();
          } else for (const c of this.consumers) c.receive(parsed);
        },
        onReconnect: () => this.beginRecovery(),
        heartbeat: {
          gapMs: 25_000,
          onGap: () => {
            this.beginRecovery();
            void this.recover();
          },
        },
      });
      void this.stream.catch(() => {
        this.controller.abort();
        void proc.stop({ graceMs: 0 });
      });
      await connection;
    } catch (error) {
      this.deliberate = true;
      this.controller.abort();
      await proc.stop({ graceMs: 0 });
      throw error;
    }
  }
  private beginRecovery(): void {
    if (this.recovering) return;
    this.recovering = true;
    for (const c of this.consumers) c.disconnected();
  }
  private recover(): Promise<void> {
    this.recovery ??= (async () => {
      try {
        let changed: boolean;
        do {
          for (const c of this.consumers) await c.resync();
          const buffered = this.buffered.splice(0);
          changed = buffered.some(
            (data) =>
              !["server.connected", "server.heartbeat"].includes(
                string(object(object(data).payload).type),
              ),
          );
          // REST snapshots include some stream deltas received during the read.
          // Retain those frames as raw evidence, then refetch until the stream is quiet.
          for (const data of buffered) for (const c of this.consumers) c.buffered(data);
        } while (changed && !this.controller.signal.aborted);
        this.recovering = false;
        for (const c of this.consumers) c.recovered();
      } catch {
        this.controller.abort();
        await this.process?.stop({ graceMs: 0 });
      } finally {
        this.recovery = undefined;
      }
    })();
    return this.recovery;
  }
  async request(
    method: string,
    path: string,
    directory: string,
    body: unknown,
    frame: (dir: Frame["dir"], channel: string, data: unknown) => void,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    await this.ready();
    signal.throwIfAborted();
    const url = new URL(path, this.base);
    url.searchParams.set("directory", directory);
    frame("send", "http", { method, path, ...(body === undefined ? {} : { body }) });
    const response = await fetch(url, {
      method,
      headers: { authorization: this.authorization, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, this.controller.signal]),
    });
    const text = await response.text();
    let result: unknown;
    try {
      result = text ? JSON.parse(text) : null;
    } catch {
      result = text;
    }
    frame("recv", "http", { method, path, status: response.status, body: result });
    if (!response.ok) throw new Error(`OpenCode ${method} ${path}: HTTP ${response.status}`);
    return result;
  }
  async release(): Promise<void> {
    if (this.consumers.size === 0) await this.close();
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.deliberate = true;
      this.controller.abort();
      await this.opening?.catch(() => {});
      await this.process?.stop();
      await this.stream;
    })().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }
}
export function eventSession(data: unknown): string {
  const p = object(object(object(data).payload).properties);
  return string(p.sessionID, string(object(p.info).sessionID, string(object(p.part).sessionID)));
}
