import { logFields } from "@ace/diagnostics";
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
  start(context: ServiceContext): Promise<void>;
}
export interface ServiceStatus {
  name: string;
  state: "starting" | "ready" | "degraded";
  error?: string;
}
export interface StartupRuntime {
  timeoutMs: number;
  schedule(name: string, expire: () => void, milliseconds: number): () => void;
}
export const systemStartup: StartupRuntime = {
  timeoutMs: 15_000,
  schedule(_name, expire, milliseconds) {
    const timer = setTimeout(expire, milliseconds);
    return () => clearTimeout(timer);
  },
};

/** A deadline is a backstop; services start finite initialization, never their lifetime loop. */
async function bounded<T>(
  name: string,
  run: () => Promise<T>,
  runtime: StartupRuntime,
): Promise<T> {
  let cancel: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    cancel = runtime.schedule(
      name,
      () => reject(new Error(`Service ${name} startup exceeded ${runtime.timeoutMs}ms`)),
      runtime.timeoutMs,
    );
  });
  try {
    return await Promise.race([Promise.resolve().then(run), deadline]);
  } finally {
    cancel?.();
  }
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
  constructor(privateContext: ServiceContext, runtime: StartupRuntime = systemStartup) {
    this.context = privateContext;
    this.runtime = runtime;
    if (!Number.isFinite(runtime.timeoutMs) || runtime.timeoutMs < 1)
      throw new Error("Invalid service startup deadline");
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
  private degraded(name: string, error: unknown): void {
    const message = `Service ${name}: ${error instanceof Error ? error.message : String(error)}`;
    this.statuses.set(name, { name, state: "degraded", error: message });
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
      this.statuses.set(definition.name, { name: definition.name, state: "starting" });
    }
    this.deferred = definitions.filter((definition) => definition.phase === "listener");
    for (const definition of definitions.filter((entry) => entry.phase === "core"))
      await this.startOne(definition);
  }
  private async startOne(definition: ServiceDefinition): Promise<void> {
    const { name } = definition;
    const unavailable = definition.requires.find(
      (dependency) => this.statuses.get(dependency)?.state !== "ready",
    );
    if (unavailable) {
      this.degraded(name, new Error(`Dependency ${unavailable} is unavailable`));
      return;
    }
    this.statuses.set(name, { name, state: "starting" });
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
    this.context.resources.own(() =>
      bounded(`${name} cleanup`, () => resources.close(), this.runtime),
    );
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
            readiness: (read) => this.readiness.set(name, read),
          }),
        this.runtime,
      );
      Object.assign(this.context.services, published);
      committed = true;
      const disable = () => {
        resources.beginShutdown();
        for (const key of Object.keys(published))
          Reflect.deleteProperty(this.context.services, key);
        void bounded(`${name} cleanup`, () => resources.close(), this.runtime).catch(
          (failure: unknown) =>
            this.context.log.log("error", "Degraded service cleanup failed", failure),
        );
      };
      this.listeners.push(...onListen.map((start) => ({ name, start, disable })));
      this.statuses.set(name, { name, state: onListen.length ? "starting" : "ready" });
    } catch (error) {
      resources.beginShutdown();
      this.degraded(name, error);
      // A stuck disposer must not hold startup either. Shutdown retains the cleanup promise.
      void bounded(`${name} cleanup`, () => resources.close(), this.runtime).catch(
        (failure: unknown) =>
          this.context.log.log("error", "Degraded service cleanup failed", failure),
      );
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
        );
        this.statuses.set(listener.name, { name: listener.name, state: "ready" });
      } catch (error) {
        listener.disable();
        this.degraded(listener.name, error);
      }
    }
  }
}
