import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { z } from "zod";
import type { DiscoveryOptions } from "@ace/provider-kit/discovery";
import type { SupervisedProcess } from "@ace/provider-kit/process";
import { runtime, type Runtime } from "./runtime.ts";
import { NativeEvent, loopback, validateSpec, version } from "./boundaries.ts";
import { observedFetch, sanitize, type Observe } from "./observation.ts";
import { Routes } from "./routes.ts";
import { RecentMap } from "./cache.ts";
export { eventSession } from "./boundaries.ts";
export type ServerConsumer = {
  accepts(data: unknown, watermark: number): boolean;
  receive(data: unknown): void;
  frame: Observe;
  disconnected(started: number): void;
  reconcile(data: unknown, watermark: number): void;
  buffered(data: unknown, watermark: number): void;
  recovered(): void;
  resync(): Promise<void>;
  finalizeSnapshots(): void;
  prepareReplay(): void;
  close(): Promise<void>;
  exited(deliberate: boolean, message?: string): void;
};
export type ServerOptions = {
  /** Ephemeral scoped MCP credentials must be redacted from observed server frames. */
  redactSecrets?: readonly string[];
  discovery?: DiscoveryOptions;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  runtime?: Partial<Runtime>;
  /** Explicit external attachment never owns or stops the attached process. */
  attach?: { url: string; authorization: string; version: string };
};
const Identity = z.object({ version: z.string(), pid: z.number().int().positive() }).passthrough();
/** One process/stream/reconnect owner per adapter instance. */
export class OpenCodeServer {
  readonly runtime: Runtime;
  private options: ServerOptions;
  private consumers = new Set<ServerConsumer>();
  private routes = new Routes();
  private readyWaiters = 0;
  private process: SupervisedProcess | undefined;
  private controller = new AbortController();
  private opening: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private stopping = false;
  private stream: Promise<void> | undefined;
  private base: URL | undefined;
  private authorization = "";
  private secrets: string[] = [];
  private client: OpenCodeClient | undefined;
  private identity: z.infer<typeof Identity> | undefined;
  private deliberate = false;
  private recovering = false;
  private recoveryStarted = 0;
  private recovery: Promise<void> | undefined;
  private buffered: { data: unknown; watermark: number; bytes: number }[] = [];
  private bufferedBytes = 0;
  private sequences = new RecentMap<number>(1024);
  private sequence = 0;
  get eventWatermark(): number {
    return this.sequence;
  }
  get shutdownTimeoutMs(): number {
    return this.options.shutdownTimeoutMs ?? 1000;
  }
  redact(value: unknown): unknown {
    return sanitize(value, this.secrets);
  }
  constructor(options: ServerOptions = {}) {
    this.options = options;
    this.runtime = runtime(options.runtime);
  }
  subscribe(consumer: ServerConsumer): () => void {
    if (this.consumers.size >= 128) throw new Error("OpenCode session limit reached");
    this.routes.clear();
    this.consumers.add(consumer);
    if (this.recovering) consumer.disconnected(this.recoveryStarted);
    return () => {
      this.consumers.delete(consumer);
      this.routes.clear();
    };
  }
  async ready(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.closing) await this.closing;
    if (this.controller.signal.aborted) {
      await this.opening?.catch(() => {});
      this.identity = undefined;
      this.controller = new AbortController();
      this.opening = undefined;
      this.deliberate = false;
      this.recovering = false;
      this.buffered = [];
      this.bufferedBytes = 0;
      this.sequences.clear();
    }
    if (this.readyWaiters >= 128) throw new Error("OpenCode startup waiter limit");
    this.readyWaiters++;
    this.opening ??= this.start();
    try {
      if (!signal) await this.opening;
      else
        await new Promise<void>((resolve, reject) => {
          const aborted = () => reject(new Error("OpenCode startup caller cancelled"));
          signal.addEventListener("abort", aborted, { once: true });
          void this.opening
            ?.then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", aborted));
          if (signal.aborted) aborted();
        });
      this.controller.signal.throwIfAborted();
    } finally {
      this.readyWaiters--;
      if (signal?.aborted && !this.readyWaiters && !this.consumers.size) await this.close();
    }
  }
  scoped(directory: string, frame: Observe, signal: AbortSignal): OpenCodeClient {
    if (!this.base) throw new Error("OpenCode server is not ready");
    return OpenCode.make({
      baseUrl: this.base.href,
      headers: { "x-opencode-directory": directory },
      fetch: observedFetch(
        this.runtime,
        this.authorization,
        this.secrets,
        AbortSignal.any([signal, this.controller.signal]),
        frame,
      ),
    });
  }
  private frame: Observe = (dir, channel, data) => {
    // Server identity/spec are transport metadata. Session-specific bodies use scoped observers.
    for (const c of this.consumers) c.frame(dir, channel, data);
  };
  private async start(): Promise<void> {
    const cancel = this.runtime.schedule(
      () => this.controller.abort(),
      this.options.startupTimeoutMs ?? 30000,
    );
    try {
      let expected: string;
      if (this.options.attach) {
        expected = this.options.attach.version;
        this.base = loopback(this.options.attach.url);
        this.authorization = this.options.attach.authorization;
        this.secrets = [this.authorization, ...(this.options.redactSecrets ?? [])];
      } else {
        const cli = (
          await this.runtime.discover({ ...this.options.discovery, signal: this.controller.signal })
        ).opencode;
        if (!cli.installed || !cli.path) throw new Error("OpenCode is not installed");
        expected = cli.version ?? "";
        if (!version(expected))
          throw new Error("OpenCode 2.0.22 is required; upgrade v1 or review the new contract");
        const password = this.runtime.entropy(32);
        this.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
        this.secrets = [
          password,
          this.authorization,
          this.authorization.slice(6),
          ...(this.options.redactSecrets ?? []),
        ];
        this.controller.signal.throwIfAborted();
        const proc = this.runtime.spawn({
          command: cli.path,
          args: ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"],
          env: {
            ...this.options.discovery?.env,
            OPENCODE_PASSWORD: password,
            OPENCODE_SERVER_PASSWORD: undefined,
            OPENCODE_SERVER_USERNAME: undefined,
          },
          name: "opencode-server",
          maxLineBytes: 65536,
        });
        this.process = proc;
        // stdout/stderr are intentionally not observed: startup/config logs may contain secrets.
        const generation = this.controller;
        void proc.exited.then(() => {
          if (this.process !== proc) return;
          generation.abort();
          if (generation !== this.controller) return;
          for (const c of this.consumers)
            c.exited(this.deliberate, "OpenCode owned process exited");
        });
        this.base = await new Promise<URL>((resolve, reject) => {
          const cleanup = () => {
            proc.stdout.off("line", line);
            this.controller.signal.removeEventListener("abort", abort);
          };
          const abort = () => {
            cleanup();
            reject(new Error("OpenCode startup cancelled or process exited"));
          };
          const line = (text: string) => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch {
              return;
            }
            const readiness = z.object({ url: z.string() }).safeParse(parsed);
            if (!readiness.success) return;
            try {
              const base = loopback(readiness.data.url);
              cleanup();
              resolve(base);
            } catch {
              cleanup();
              reject(new Error("Invalid OpenCode readiness URL"));
            }
          };
          proc.stdout.on("line", line);
          this.controller.signal.addEventListener("abort", abort, { once: true });
          if (this.controller.signal.aborted) abort();
        });
      }
      if (!version(expected)) throw new Error("OpenCode 2.0.22 is required");
      this.client = this.scoped("", this.frame, this.controller.signal);
      await this.verify(expected);
      const fetch = observedFetch(
        this.runtime,
        this.authorization,
        this.secrets,
        this.controller.signal,
        () => {},
      );
      const spec = await (await fetch(new URL("/openapi.json", this.base))).json();
      validateSpec(spec);
      let connected: (() => void) | undefined;
      const handshake = new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error("OpenCode SSE handshake cancelled"));
        this.controller.signal.addEventListener("abort", abort, { once: true });
        connected = () => {
          this.controller.signal.removeEventListener("abort", abort);
          resolve();
        };
      });
      this.stream = this.consumeEvents(() => connected?.());
      await handshake;
    } catch {
      this.deliberate = true;
      this.controller.abort();
      await this.process?.stop({ graceMs: 0 });
      throw new Error("OpenCode startup failed: requires 2.0.22 and matching JSON API contract");
    } finally {
      cancel();
    }
  }
  private async verify(expected: string): Promise<void> {
    const info = Identity.parse(await this.client?.server.info({ signal: this.controller.signal }));
    if (
      info.version !== expected ||
      !version(info.version) ||
      (this.identity && info.pid !== this.identity.pid) ||
      (this.process?.pid !== undefined && info.pid !== this.process.pid)
    )
      throw new Error("OpenCode process/version identity mismatch");
    this.identity = info;
  }
  reconcileNow(): Promise<void> {
    this.beginRecovery();
    return this.recover();
  }
  private beginRecovery(started = this.sequence): void {
    if (this.recovering) return;
    this.recovering = true;
    this.recoveryStarted = started;
    for (const c of this.consumers) c.disconnected(started);
  }
  private async consumeEvents(connected: () => void): Promise<void> {
    while (!this.controller.signal.aborted) {
      const connection = new AbortController();
      let cancelSilence: (() => void) | undefined;
      const activity = () => {
        cancelSilence?.();
        cancelSilence = this.runtime.schedule(() => connection.abort(), 25000);
        for (const c of this.consumers) c.frame("note", "transport.activity", {});
      };
      try {
        activity();
        const client = this.client;
        if (!client) throw new Error("Missing OpenCode client");
        for await (const native of client.event.subscribe({
          signal: AbortSignal.any([connection.signal, this.controller.signal]),
          onActivity: activity,
        })) {
          const data = sanitize(native, this.secrets),
            event = NativeEvent.parse(data),
            watermark = ++this.sequence;
          if (event.type === "server.connected") {
            connected();
            if (this.recovering) void this.recover();
            continue;
          }
          const targets = this.routes.select(data, watermark, this.consumers);
          if (!targets.length) continue;
          const durable = event.durable;
          if (durable) {
            const previous = this.sequences.get(durable.aggregateID);
            // The first seq may include an inherited fork prefix. Establish baseline first.
            if (previous !== undefined && durable.seq > previous + 1) {
              this.beginRecovery(watermark - 1);
              void this.recover();
            }
            if (previous === undefined || durable.seq > previous)
              this.sequences.set(durable.aggregateID, durable.seq);
          }
          if (this.recovering) {
            const bytes = Buffer.byteLength(JSON.stringify(data));
            this.bufferedBytes += bytes;
            this.buffered.push({ data, watermark, bytes });
            if (this.buffered.length > 4096 || this.bufferedBytes > 8 * 1024 * 1024) {
              this.buffered = [];
              this.bufferedBytes = 0;
              this.controller.abort();
              if (this.process) void this.process.stop({ graceMs: 0 });
              throw new Error("OpenCode recovery overflow");
            }
            for (const c of targets) {
              c.buffered(data, watermark);
              c.frame("note", "recovery.buffered", { id: event.id, type: event.type, watermark });
            }
          } else for (const c of targets) c.receive(data);
        }
      } catch {
        /* One reconnect owner handles EOF, malformed JSON, overflow and stalls. */
      } finally {
        cancelSilence?.();
        connection.abort();
      }
      if (!this.controller.signal.aborted) {
        this.beginRecovery();
        await new Promise<void>((resolve) => {
          const cancel = this.runtime.schedule(done, 100);
          const signal = this.controller.signal;
          function done() {
            cancel();
            signal.removeEventListener("abort", done);
            resolve();
          }
          signal.addEventListener("abort", done, { once: true });
          if (signal.aborted) done();
        });
      }
    }
  }
  private recover(): Promise<void> {
    this.recovery ??= (async () => {
      const cancel = this.runtime.schedule(() => this.controller.abort(), 30000);
      try {
        await this.verify("2.0.22");
        for (let pass = 0; pass < 2; pass++) for (const c of this.consumers) await c.resync();
        // Positive work must be established before newer terminal evidence is replayed.
        for (const c of this.consumers) c.prepareReplay();
        for (const entry of this.buffered)
          for (const c of this.consumers) c.reconcile(entry.data, entry.watermark);
        for (const c of this.consumers) c.finalizeSnapshots();
        this.buffered = [];
        this.bufferedBytes = 0;
        this.recovering = false;
        for (const c of this.consumers) c.recovered();
      } catch {
        // Failed completeness leaves external servers disconnected; never kill an external owner.
        if (this.process) {
          this.controller.abort();
          await this.process.stop({ graceMs: 0 });
        }
      } finally {
        cancel();
        this.recovery = undefined;
      }
    })();
    return this.recovery;
  }
  async release(): Promise<void> {
    if (!this.stopping && !this.consumers.size && !this.readyWaiters) await this.close();
  }
  close(): Promise<void> {
    this.stopping = true;
    this.closing ??= (async () => {
      this.deliberate = true;
      this.controller.abort();
      this.process?.stdin.end();
      await Promise.all([...this.consumers].map((c) => c.close()));
      await this.opening?.catch(() => {});
      await this.process?.stop({ graceMs: this.shutdownTimeoutMs });
      await this.stream;
      this.identity = undefined;
      this.client = undefined;
      this.process = undefined;
      this.authorization = "";
      this.secrets = [];
    })().finally(() => {
      this.closing = undefined;
      this.stopping = false;
    });
    return this.closing;
  }
}
