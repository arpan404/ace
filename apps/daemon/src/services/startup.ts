import { logError, logFields } from "@ace/diagnostics";
import { Resources } from "./resources.ts";
import type { ServiceContext, Services } from "./types.ts";
import type { startServer } from "../server.ts";

export interface ServiceDefinition {
  name: string;
  phase: "core" | "listener";
  /** Dependencies must have completed startup. A failure skips this service. */
  requires: readonly string[];
  /** Optional dependencies must be attempted first, but may be degraded. */
  after: readonly string[];
  start(context: ServiceContext): void | Promise<void>;
}
export interface ServiceStatus {
  name: string;
  state: "starting" | "ready" | "degraded";
  error?: string;
}
export interface StartupRuntime {
  timeoutMs: number;
  cleanupTimeoutMs?: number;
  onStatus?(status: ServiceStatus): void;
  schedule(name: string, expire: () => void, milliseconds: number): () => void;
}
export const systemStartup: StartupRuntime = {
  timeoutMs: 15_000,
  cleanupTimeoutMs: 4_000,
  schedule(_name, expire, milliseconds) {
    const timer = setTimeout(expire, milliseconds);
    return () => clearTimeout(timer);
  },
};

/** A deadline is a backstop; services start finite initialization, never their lifetime loop. */
async function bounded<T>(
  name: string,
  run: () => T | Promise<T>,
  runtime: StartupRuntime,
  signal?: AbortSignal,
  operation = "startup",
): Promise<T> {
  signal?.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal?.reason ?? new Error("Daemon startup aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  let cancel: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    cancel = runtime.schedule(
      name,
      () => reject(new Error(`Service ${name} ${operation} exceeded ${runtime.timeoutMs}ms`)),
      runtime.timeoutMs,
    );
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal?.throwIfAborted();
        return run();
      }),
      deadline,
      aborted,
    ]);
  } finally {
    cancel?.();
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

function boundedCleanup(
  name: string,
  resources: Resources,
  runtime: StartupRuntime,
): Promise<void> {
  return bounded(
    name,
    () => resources.close(),
    { ...runtime, timeoutMs: runtime.cleanupTimeoutMs ?? 4_000 },
    undefined,
    "cleanup",
  );
}

/** Ordered startup with private publication and resource ownership for each attempt. */
export class ServiceStartup {
  private readonly readiness = new Map<
    string,
    () => { state: "starting" | "ready" | "degraded"; error?: string }
  >();
  private readonly statuses = new Map<string, ServiceStatus>();
  private readonly listeners: {
    name: string;
    start: ServiceContext["onListen"][number];
    disable(): void;
  }[] = [];
  private readonly runtime: StartupRuntime;
  private deferred: readonly ServiceDefinition[] = [];
  private readonly cleanups: (() => Promise<void>)[] = [];
  constructor(privateContext: ServiceContext, runtime: StartupRuntime = systemStartup) {
    this.context = privateContext;
    this.runtime = runtime;
    privateContext.resources.own(async () => {
      const results = await Promise.allSettled(this.cleanups.splice(0).map((close) => close()));
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "Service cleanup failed");
    });
    if (!Number.isFinite(runtime.timeoutMs) || runtime.timeoutMs < 1)
      throw new Error("Invalid service startup deadline");
    if (
      runtime.cleanupTimeoutMs !== undefined &&
      (!Number.isFinite(runtime.cleanupTimeoutMs) || runtime.cleanupTimeoutMs < 1)
    )
      throw new Error("Invalid service cleanup deadline");
  }
  private readonly context: ServiceContext;
  status = (): ServiceStatus[] =>
    [...this.statuses.values()].map(({ name, state, error }) => {
      const warming = state !== "degraded" ? this.readiness.get(name)?.() : undefined;
      const result: ServiceStatus = {
        name,
        state:
          state === "ready" || warming?.state === "degraded" ? (warming?.state ?? state) : state,
      };
      error = warming?.error ?? error;
      if (error !== undefined) result.error = error;
      return result;
    });
  private report(name: string): void {
    if (!this.runtime.onStatus) return;
    const status = this.status().find((entry) => entry.name === name);
    if (!status) return;
    try {
      this.runtime.onStatus?.(status);
    } catch (error) {
      this.context.log.log("error", "Startup observer failed", logError(error));
    }
  }
  private record(name: string, status: ServiceStatus): void {
    this.statuses.set(name, status);
    this.report(name);
  }
  private degraded(name: string, error: unknown): void {
    const message = `Service ${name}: ${error instanceof Error ? error.message : String(error)}`;
    this.record(name, { name, state: "degraded", error: message });
    this.context.log.log(
      "error",
      "Daemon service degraded",
      logFields([
        ["service", name],
        ["error", message],
      ]),
    );
  }
  async start(definitions: readonly ServiceDefinition[]): Promise<void> {
    // Validate the entire order before starting any service.
    const seen = new Set<string>();
    let listenerPhase = false;
    for (const definition of definitions) {
      if (seen.has(definition.name)) throw new Error(`Duplicate service ${definition.name}`);
      for (const dependency of [...definition.requires, ...definition.after])
        if (!seen.has(dependency))
          throw new Error(`Service ${definition.name} must start after ${dependency}`);
      if (definition.phase === "listener") listenerPhase = true;
      else if (listenerPhase)
        throw new Error(`Core service ${definition.name} follows listener services`);
      seen.add(definition.name);
      this.record(definition.name, { name: definition.name, state: "starting" });
    }
    this.deferred = definitions.filter((definition) => definition.phase === "listener");
    for (const definition of definitions.filter((entry) => entry.phase === "core"))
      await this.startOne(definition);
  }
  private async startOne(definition: ServiceDefinition): Promise<void> {
    this.context.signal.throwIfAborted();
    const { name } = definition;
    const unavailable = definition.requires.find(
      (dependency) => this.statuses.get(dependency)?.state !== "ready",
    );
    if (unavailable) {
      this.degraded(name, new Error(`Dependency ${unavailable} is unavailable`));
      return;
    }
    this.record(name, { name, state: "starting" });
    const resources = new Resources();
    const controller = new AbortController();
    const published: Partial<Services> = {};
    let committed = false;
    // Callbacks may read services created later. Failed attempts never publish late writes.
    const services = new Proxy(published, {
      get: (target, key) =>
        committed
          ? Reflect.get(this.context.services, key)
          : Reflect.has(target, key)
            ? Reflect.get(target, key)
            : Reflect.get(this.context.services, key),
      set: (target, key, value) => {
        if (controller.signal.aborted) return true;
        return Reflect.set(committed ? this.context.services : target, key, value);
      },
    });
    const onListen: ServiceContext["onListen"] = [];
    resources.onShutdown(() => controller.abort());
    this.context.resources.onShutdown(() => resources.beginShutdown());
    this.cleanups.push(() => boundedCleanup(name, resources, this.runtime));
    try {
      await bounded(
        name,
        () =>
          definition.start({
            ...this.context,
            resources,
            services,
            onListen,
            signal: controller.signal,
            readiness: (read) => {
              this.readiness.set(name, read);
              this.report(name);
            },
          }),
        this.runtime,
        this.context.signal,
      );
      this.context.signal.throwIfAborted();
      Object.assign(this.context.services, published);
      committed = true;
      const disable = () => {
        resources.beginShutdown();
        for (const key of Object.keys(published))
          Reflect.deleteProperty(this.context.services, key);
        void boundedCleanup(name, resources, this.runtime).catch((failure: unknown) =>
          this.context.log.log("error", "Degraded service cleanup failed", logError(failure)),
        );
      };
      this.listeners.push(...onListen.map((start) => ({ name, start, disable })));
      this.record(name, { name, state: onListen.length ? "starting" : "ready" });
    } catch (error) {
      resources.beginShutdown();
      this.degraded(name, error);
      // A stuck disposer must not hold startup either. Shutdown retains the cleanup promise.
      void boundedCleanup(name, resources, this.runtime).catch((failure: unknown) =>
        this.context.log.log("error", "Degraded service cleanup failed", logError(failure)),
      );
      this.context.signal.throwIfAborted();
    }
  }
  async listening(server: Awaited<ReturnType<typeof startServer>>): Promise<void> {
    for (const definition of this.deferred) await this.startOne(definition);
    for (const listener of this.listeners) {
      if (this.statuses.get(listener.name)?.state === "degraded") continue;
      try {
        await bounded(
          listener.name,
          async () => {
            await listener.start(server);
          },
          this.runtime,
          this.context.signal,
        );
        this.record(listener.name, { name: listener.name, state: "ready" });
      } catch (error) {
        listener.disable();
        this.degraded(listener.name, error);
        this.context.signal.throwIfAborted();
      }
    }
  }
}
