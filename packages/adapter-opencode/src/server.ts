import { aceConfigEnvironment } from "./mcp-ready.ts";
import { metadataFailure } from "./metadata-failure.ts";
import { discoveryFailureCode } from "@ace/provider-kit/discovery-failure";
import { SessionOpenError } from "@ace/provider-kit/open-error";
import type { OpenCode, OpenCodeClient } from "@opencode/client";
import { z } from "zod";
import type { DiscoveryOptions } from "@ace/provider-kit/discovery";
import type { SupervisedProcess } from "@ace/provider-kit/process";
import { runtime, type Runtime } from "./runtime.ts";
import { NativeEvent, loopback } from "./boundaries.ts";
import { basicAuthorization, ownedServerReady, spawnOwnedServer } from "./owned-server.ts";
import { validateSpec, version, versionRefusal } from "./contract.ts";
import { observedFetch, sanitize, type Observe } from "./observation.ts";
import { Routes } from "./routes.ts";
import { RecentMap } from "./cache.ts";
import { waitForOutput } from "@ace/provider-kit/flow-control";
import { transientFailure } from "./recovery-failure.ts";
export { eventSession } from "./boundaries.ts";
export type ServerConsumer = {
  outputFlow?: import("@ace/provider-kit/flow-control").OutputFlow;
  accepts(data: unknown, watermark: number): boolean;
  receive(data: unknown): void;
  frame: Observe;
  disconnected(started: number): void;
  reconcile(data: unknown, watermark: number): void;
  buffered(data: unknown, watermark: number): void;
  recovered(): void;
  resync(): Promise<void>;
  finalizeSnapshots(): void;
  prepareReplay(): void | Promise<void>;
  close(): Promise<void>;
  exited(deliberate: boolean, message?: string): void;
};
export type ServerOptions = {
  /** Credential-free native catalog readiness plugin, installed only for owned MCP sessions. */
  mcpReadyPlugin?: string;
  /** ace's shipped skill directories, added to the person's own OpenCode skills. */
  skillDirectories?: readonly string[];
  discovery?: DiscoveryOptions;
  /** Session-scoped credentials to remove before emitting provider evidence. */
  secrets?: readonly string[];
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  runtime?: Partial<Runtime>;
  /** Explicit external attachment never owns or stops the attached process. */
  attach?: { url: string; authorization: string; version: string };
};
/** Recovery retries a failed pass after this long, doubling up to `maxRecoveryBackoffMs`. */
const recoveryBackoffMs = 100;
const maxRecoveryBackoffMs = 5000;
/** A different OpenCode process answered: nothing recovered from it can be trusted. */
class IdentityChanged extends Error {
  readonly code = "unreachable";
}
/** One session's part of a recovery pass failed; the others are not at fault. */
class ConsumerFailure extends Error {
  readonly consumer: ServerConsumer;
  constructor(consumer: ServerConsumer, cause: unknown) {
    super("OpenCode session recovery failed", { cause });
    this.consumer = consumer;
  }
}
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
  private factory: typeof OpenCode | undefined;
  private identity: z.infer<typeof Identity> | undefined;
  private deliberate = false;
  private recovering = false;
  private recoveryStarted = 0;
  private recovery: Promise<void> | undefined;
  /** Buffered events were dropped, so the next pass must start from a fresh snapshot. */
  private recoveryStale = false;
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
    this.options = {
      ...options,
      secrets: z
        .array(z.string().min(1).max(4096))
        .max(32)
        .parse(options.secrets ?? []),
    };
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
    if (!this.base || !this.factory) throw new Error("OpenCode server is not ready");
    return this.factory.make({
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
        this.secrets = [...(this.options.secrets ?? []), this.authorization];
      } else {
        const discovery = { ...this.options.discovery, signal: this.controller.signal };
        const cli = this.options.runtime?.discover
          ? (await this.runtime.discover(discovery)).opencode
          : await this.runtime.discoverProvider("opencode", discovery);
        if (!cli.installed || !cli.path)
          throw Object.assign(new Error("OpenCode is not installed"), { code: "not_configured" });
        expected = cli.version ?? "";
        if (!version(expected)) throw versionRefusal(cli.version);
        const password = this.runtime.entropy(32);
        this.authorization = basicAuthorization(password);
        this.secrets = [
          ...(this.options.secrets ?? []),
          password,
          this.authorization,
          this.authorization.slice(6),
        ];
        this.controller.signal.throwIfAborted();
        const providerEnv = this.options.discovery?.env;
        const env =
          this.options.mcpReadyPlugin || this.options.skillDirectories?.length
            ? aceConfigEnvironment(
                providerEnv,
                providerEnv?.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT ?? "{}",
                { plugin: this.options.mcpReadyPlugin, skills: this.options.skillDirectories },
              )
            : providerEnv;
        const proc = spawnOwnedServer({
          spawn: this.runtime.spawn,
          command: cli.path,
          env,
          password,
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
        this.base = await ownedServerReady(proc, this.controller.signal);
      }
      if (!version(expected)) throw versionRefusal(expected);
      this.factory = (await import("@opencode/client")).OpenCode;
      this.controller.signal.throwIfAborted();
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
      validateSpec(spec, expected);
      let connected: (() => void) | undefined;
      let failed: ((error: unknown) => void) | undefined;
      const handshake = new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error("OpenCode SSE handshake cancelled"));
        this.controller.signal.addEventListener("abort", abort, { once: true });
        connected = () => {
          this.controller.signal.removeEventListener("abort", abort);
          resolve();
        };
        failed = (error) => {
          this.controller.signal.removeEventListener("abort", abort);
          reject(error);
        };
      });
      this.stream = this.consumeEvents(
        () => connected?.(),
        (error) => failed?.(error),
      );
      await handshake;
    } catch (error) {
      const failure = new SessionOpenError(
        "OpenCode startup failed",
        metadataFailure(error),
        { env: this.options.discovery?.env },
        (value) => this.redact(value),
      );
      this.deliberate = true;
      this.controller.abort();
      await this.process?.stop({ graceMs: 0 }).catch(() => {});
      // Preserve our classified HTTP failure through the client Transport wrapper.
      // Session errors and discovery retain sanitized details and a safe category.
      throw Object.assign(failure, { discoveryCode: discoveryFailureCode(metadataFailure(error)) });
    } finally {
      cancel();
    }
  }
  private async verify(expected: string): Promise<void> {
    const info = Identity.parse(await this.client?.server.info({ signal: this.controller.signal }));
    if ((this.runtime.platform ?? process.platform) === "win32")
      return this.verifyShimmed(info, expected);
    if (
      info.version !== expected ||
      !version(info.version) ||
      (this.identity && info.pid !== this.identity.pid) ||
      (this.process?.pid !== undefined && info.pid !== this.process.pid)
    )
      // The binary changed between discovery and start (e.g. an update): rediscover and retry.
      throw new IdentityChanged("OpenCode process/version identity mismatch");
    this.identity = info;
  }
  /**
   * Windows launches an npm install through its `.cmd` shim (cmd.exe, then Node's launcher), so
   * the pid ace spawned is never the server's own. Version and pid stability still identify it.
   */
  private verifyShimmed(info: z.infer<typeof Identity>, expected: string): void {
    if (
      info.version !== expected ||
      !version(info.version) ||
      (this.identity && info.pid !== this.identity.pid)
    )
      throw new IdentityChanged("OpenCode process/version identity mismatch");
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
  private async consumeEvents(
    connected: () => void,
    failed: (error: unknown) => void,
  ): Promise<void> {
    let established = false;
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
        const signal = AbortSignal.any([connection.signal, this.controller.signal]);
        for await (const native of client.event.subscribe({
          signal,
          onActivity: activity,
        })) {
          for (const consumer of this.consumers) await waitForOutput(consumer.outputFlow, signal);
          const data = sanitize(native, this.secrets),
            event = NativeEvent.parse(data),
            watermark = ++this.sequence;
          if (event.type === "server.connected") {
            established = true;
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
              // Memory stays bounded; a fresh snapshot after this point covers what is dropped.
              this.buffered = [];
              this.bufferedBytes = 0;
              this.recoveryStale = true;
              for (const c of targets) c.frame("note", "recovery.restarted", { watermark });
              continue;
            }
            for (const c of targets) {
              c.buffered(data, watermark);
              c.frame("note", "recovery.buffered", { id: event.id, type: event.type, watermark });
            }
          } else for (const c of targets) c.receive(data);
        }
      } catch (error) {
        if (!established) {
          failed(error);
          return;
        }
        /* One reconnect owner handles EOF, malformed JSON, overflow and stalls. */
      } finally {
        cancelSilence?.();
        connection.abort();
      }
      if (!this.controller.signal.aborted) {
        this.beginRecovery();
        await this.pause(100);
      }
    }
  }
  /** Waits, or stops waiting as soon as the server shuts down. */
  private pause(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const signal = this.controller.signal;
      const cancel = this.runtime.schedule(done, ms);
      function done() {
        cancel();
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
  private recover(): Promise<void> {
    this.recovery ??= this.recoverUntilSettled().finally(() => {
      this.recovery = undefined;
    });
    return this.recovery;
  }
  /**
   * Recovery has no deadline. A slow or unreachable pass leaves every session disconnected, never
   * done, and retries with backoff; a session that cannot be restored is failed alone.
   */
  private async recoverUntilSettled(): Promise<void> {
    let fresh = false;
    for (let failures = 0; !this.controller.signal.aborted;) {
      if (fresh || this.recoveryStale) this.restartRecovery();
      fresh = true;
      try {
        if (await this.recoverOnce()) return;
        continue;
      } catch (error) {
        if (this.controller.signal.aborted) return;
        if (error instanceof IdentityChanged) {
          // Another process answers. An owned server is replaced; an external one stays
          // disconnected until its stream reconnects and recovery starts again.
          if (this.process) {
            this.controller.abort();
            await this.process.stop({ graceMs: 0 });
          }
          return;
        }
        if (error instanceof ConsumerFailure && !transientFailure(error.cause)) {
          // OpenCode answered, and this session cannot be restored from what it said (its
          // session is gone or its data can't be represented). Only it ends; the rest go on.
          error.consumer.exited(false, "OpenCode could not restore this session");
          continue;
        }
      }
      failures++;
      await this.pause(Math.min(recoveryBackoffMs * 2 ** (failures - 1), maxRecoveryBackoffMs));
    }
  }
  private async eachConsumer(step: (c: ServerConsumer) => void | Promise<void>): Promise<void> {
    for (const c of this.consumers) {
      if (!this.consumers.has(c)) continue;
      try {
        await step(c);
      } catch (error) {
        throw new ConsumerFailure(c, error);
      }
    }
  }
  /** A retry starts as a new disconnect: its own snapshots cover everything before it. */
  private restartRecovery(): void {
    this.recoveryStale = false;
    this.buffered = [];
    this.bufferedBytes = 0;
    this.recoveryStarted = this.sequence;
    for (const c of this.consumers) c.disconnected(this.sequence);
  }
  /** One complete pass. False when buffered events were dropped and a new pass must run. */
  private async recoverOnce(): Promise<boolean> {
    const expected = this.identity?.version;
    if (!expected) throw new Error("OpenCode startup identity is unavailable");
    await this.verify(expected);
    for (let pass = 0; pass < 2; pass++) await this.eachConsumer((c) => c.resync());
    // Positive work must be established before newer terminal evidence is replayed.
    await this.eachConsumer((c) => c.prepareReplay());
    if (this.recoveryStale) return false;
    for (const entry of this.buffered)
      for (const c of this.consumers) c.reconcile(entry.data, entry.watermark);
    for (const c of this.consumers) c.finalizeSnapshots();
    this.buffered = [];
    this.bufferedBytes = 0;
    this.recovering = false;
    for (const c of this.consumers) c.recovered();
    return true;
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
