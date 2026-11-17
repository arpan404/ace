import { logError, logFields } from "@ace/diagnostics";
import { incompatibleData } from "@ace/provider-kit/incompatible-data";
import { Resources } from "./resources.ts";
import { bounded, systemStartup, validateRuntime, within } from "./startup-runtime.ts";
import type { StartupRuntime } from "./startup-runtime.ts";
import { criticalServices } from "./service-criticality.ts";
import type { ServiceContext, Services } from "./types.ts";
import type { startServer } from "../server.ts";

export interface ServiceDefinition {
  name: string;
  phase: "core" | "listener";
  /** Dependencies must have completed startup. A failure skips this service. */
  requires: readonly string[];
  /** Optional dependencies must be attempted first, but may be degraded. */
  after: readonly string[];
  /**
   * Without it the daemon cannot do its job, so a failure stops startup before the daemon
   * listens or reports ready. Other services may degrade; `/v1/status` names them.
   * Only core-phase services can be essential: listener services start after discovery.
   */
  essential?: boolean;
  start(context: ServiceContext): void | Promise<void>;
}
/**
 * A listener-phase service that only the service list names loads its module when it starts,
 * after the daemon listens, so its code is not on the path to the first client's welcome.
 * A start that timed out, or a daemon stopping, while the module loaded never runs it: its
 * resources are already closed, and anything it installed would outlive them.
 */
export function loadOnStart<Name extends string>(
  load: () => Promise<Record<Name, ServiceDefinition["start"]>>,
  name: Name,
): ServiceDefinition["start"] {
  return async (context) => {
    const loaded = await load();
    context.signal.throwIfAborted();
    return loaded[name](context);
  };
}
/** An essential service failed to start; the daemon must not listen without it. */
export class EssentialServiceError extends Error {
  readonly service: string;
  constructor(service: string, detail: string | undefined) {
    super(`Daemon cannot start: ${detail ?? `Service ${service} failed to start`}`);
    this.name = "EssentialServiceError";
    this.service = service;
  }
}
/**
 * Persisted data this build cannot read stops startup with that one message. Degrading
 * would only repeat it as every dependent service reports its dependency unavailable.
 */
function stopOnIncompatibleData(error: unknown): void {
  if (incompatibleData(error)) throw error;
}
export interface ServiceStatus {
  name: string;
  state: "starting" | "ready" | "degraded";
  error?: string;
  /** Safe mode left this service off for the run; it is never retried. */
  skipped?: true;
  /** For a degraded service: another attempt is scheduled or will follow; false once none is. */
  retrying?: boolean;
}
export { systemStartup, type StartupRuntime } from "./startup-runtime.ts";

/**
 * What a failed or timed-out start does (ADR 0175). The store, lock and socket are opened before
 * any service and are fatal on their own. Of the services, an essential one and everything it
 * requires (`criticalServices`) stop the daemon: without them the essential one cannot start.
 * Every other service degrades, says so in `/v1/status`, and is retried with backoff.
 */
export type FailurePolicy = "stop-daemon" | "degrade-and-retry";
export function failurePolicy(
  definition: Pick<ServiceDefinition, "name">,
  critical: ReadonlySet<string>,
): FailurePolicy {
  return critical.has(definition.name) ? "stop-daemon" : "degrade-and-retry";
}

function boundedCleanup(
  name: string,
  resources: Resources,
  runtime: StartupRuntime,
): Promise<void> {
  return bounded(
    name,
    () => resources.close(),
    { ...runtime, timeoutMs: runtime.cleanupTimeoutMs ?? 6_000 },
    undefined,
    "cleanup",
  );
}

type Server = Awaited<ReturnType<typeof startServer>>;
interface ServiceListener {
  name: string;
  start: ServiceContext["onListen"][number];
  disable(): void;
}

/** Ordered startup with private publication and resource ownership for each attempt. */
export class ServiceStartup {
  private readonly readiness = new Map<
    string,
    () => { state: "starting" | "ready" | "degraded"; error?: string }
  >();
  private readonly statuses = new Map<string, ServiceStatus>();
  /** Core services' listeners, run once the daemon listens. */
  private readonly listeners: ServiceListener[] = [];
  private readonly runtime: StartupRuntime;
  private deferred: readonly ServiceDefinition[] = [];
  private definitions: readonly ServiceDefinition[] = [];
  private readonly cleanups = new Map<
    string,
    { dependencies: readonly string[]; close(): Promise<void> }
  >();
  /**
   * Per service, how much of its work is still running: a start, a listener or a cleanup,
   * counted until the call itself settles, not until a deadline stops waiting for it. A retry
   * starts only once nothing is left, so it never takes resources an earlier owner still holds.
   */
  private readonly inflight = new Map<string, number>();
  private readonly retriesUsed = new Map<string, number>();
  private readonly retryTimers = new Map<string, () => void>();
  /** Set once the daemon listens; retries start after that. */
  private server: Server | undefined;
  /** One budget for every service's cleanup at shutdown, started by the first to close. */
  private budget: Promise<void> | undefined;
  private readonly skip: ReadonlySet<string>;
  private critical: ReadonlySet<string> = new Set();
  /**
   * `skip` names services this start leaves off (safe mode, after starts that never finished
   * them). An essential service is never skipped.
   */
  constructor(
    privateContext: ServiceContext,
    runtime: StartupRuntime = systemStartup,
    skip: readonly string[] = [],
  ) {
    this.context = privateContext;
    this.runtime = runtime;
    this.skip = new Set(skip);
    validateRuntime(runtime);
    privateContext.resources.onShutdown(() => {
      for (const cancel of this.retryTimers.values()) cancel();
      this.retryTimers.clear();
    });
  }
  private readonly context: ServiceContext;
  status = (): ServiceStatus[] =>
    [...this.statuses.values()].map(({ name, state, error, skipped }) => {
      const warming = state !== "degraded" ? this.readiness.get(name)?.() : undefined;
      const result: ServiceStatus = {
        name,
        state:
          state === "ready" || warming?.state === "degraded" ? (warming?.state ?? state) : state,
      };
      error = warming?.error ?? error;
      if (error !== undefined) result.error = error;
      if (skipped) result.skipped = true;
      if (result.state === "degraded" && !skipped) result.retrying = this.willRetry(name);
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
  private readonly changeListeners = new Set<() => void>();
  /** Tells `listener` whenever a service's status changes; returns how to stop. */
  onChange = (listener: () => void): (() => void) => {
    this.changeListeners.add(listener);
    return () => void this.changeListeners.delete(listener);
  };
  private changed(): void {
    for (const listener of this.changeListeners) listener();
  }
  private record(name: string, status: ServiceStatus): void {
    this.statuses.set(name, status);
    this.report(name);
    this.changed();
  }
  private degraded(name: string, error: unknown, skipped = false): void {
    const message = `Service ${name}: ${error instanceof Error ? error.message : String(error)}`;
    this.record(name, { name, state: "degraded", error: message, ...(skipped ? { skipped } : {}) });
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
      if (definition.essential && definition.phase !== "core")
        throw new Error(`Essential service ${definition.name} must start in the core phase`);
      if (definition.phase === "listener") listenerPhase = true;
      else if (listenerPhase)
        throw new Error(`Core service ${definition.name} follows listener services`);
      seen.add(definition.name);
      this.record(definition.name, { name: definition.name, state: "starting" });
    }
    this.definitions = definitions;
    this.critical = criticalServices(definitions);
    this.deferred = definitions.filter((definition) => definition.phase === "listener");
    for (const definition of definitions.filter((entry) => entry.phase === "core"))
      this.listeners.push(...(await this.startOne(definition)));
    for (const definition of definitions) {
      if (failurePolicy(definition, this.critical) !== "stop-daemon") continue;
      const status = this.statuses.get(definition.name);
      if (status?.state === "degraded")
        throw new EssentialServiceError(definition.name, status.error);
    }
  }
  /** Returns the listeners the service registered, to run once the daemon listens. */
  private async startOne(definition: ServiceDefinition): Promise<ServiceListener[]> {
    this.context.signal.throwIfAborted();
    const { name } = definition;
    const unavailable = definition.requires.find(
      (dependency) => this.statuses.get(dependency)?.state !== "ready",
    );
    if (unavailable) {
      this.degraded(name, new Error(`Dependency ${unavailable} is unavailable`));
      return [];
    }
    if (this.skip.has(name) && failurePolicy(definition, this.critical) !== "stop-daemon") {
      // Never retried: the person's next restart of ace starts it again.
      this.retriesUsed.set(name, Number.POSITIVE_INFINITY);
      this.degraded(
        name,
        new Error("Turned off for this run: it was still starting when ace last stopped"),
        true,
      );
      return [];
    }
    this.record(name, { name, state: "starting" });
    // A disposer the start registers after cleanup began counts as this service's work too.
    const resources = new Resources({ lateWork: (work) => this.hold(name, work) });
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
    let closing: Promise<void> | undefined;
    let awaitingDependents = false;
    const close = (): Promise<void> => {
      closing ??= Promise.resolve().then(async () => {
        const budget = this.shutdownBudget();
        // Preserve dependency lifetimes while unrelated branches drain together, until the
        // shared budget is spent: then a stuck dependent no longer holds this one open.
        awaitingDependents = true;
        await within(
          Promise.allSettled(
            [...this.cleanups.values()]
              .filter((entry) => entry.dependencies.includes(name))
              .map((entry) => entry.close()),
          ),
          budget,
        );
        awaitingDependents = false;
        const own = boundedCleanup(name, resources, this.runtime).catch(async (error: unknown) => {
          this.context.log.log(
            "error",
            "Service cleanup failed",
            logFields([
              ["service", name],
              ["error", error instanceof Error ? error.message : String(error)],
            ]),
          );
          // A timeout reports the slow owner, but does not retire its dependencies.
          await Promise.allSettled([resources.close()]);
          throw new Error(`Service ${name} cleanup failed`, { cause: error });
        });
        if ((await within(own, budget)) === "done") return own;
        // The process exits next; what is still closing is named by `pending()` meanwhile.
        void own.catch(() => {});
        this.context.log.log(
          "warn",
          "Service cleanup left running at shutdown",
          logFields([["service", name]]),
        );
      });
      return closing;
    };
    this.cleanups.set(name, { dependencies: [...definition.requires, ...definition.after], close });
    this.context.resources.ownParallel(close, {
      name: `service ${name}`,
      pending: () => (awaitingDependents ? ["waiting for dependents"] : resources.pending()),
    });
    // The start itself, which may outlive its deadline. Held from here until the real calls
    // are tracked, so the count never drops to zero in between.
    let attempt: Promise<unknown> = Promise.resolve();
    const registering = Promise.withResolvers<void>();
    this.hold(name, registering.promise);
    try {
      await bounded(
        name,
        () => {
          attempt = Promise.resolve(
            this.inService(name, () =>
              definition.start({
                ...this.context,
                resources,
                services,
                onListen,
                signal: controller.signal,
                readiness: (read) => {
                  this.readiness.set(name, read);
                  this.report(name);
                  this.changed();
                },
              }),
            ),
          );
          return attempt;
        },
        this.runtime,
        this.context.signal,
      );
      this.hold(name, attempt);
      registering.resolve();
      this.context.signal.throwIfAborted();
      Object.assign(this.context.services, published);
      committed = true;
      const disable = () => {
        resources.beginShutdown();
        for (const key of Object.keys(published))
          Reflect.deleteProperty(this.context.services, key);
        // The deadline only stops the log waiting; the close itself fences the next retry.
        this.hold(name, resources.close());
        void boundedCleanup(name, resources, this.runtime).catch((failure: unknown) =>
          this.context.log.log("error", "Degraded service cleanup failed", logError(failure)),
        );
      };
      this.record(name, { name, state: onListen.length ? "starting" : "ready" });
      return onListen.map((start) => ({ name, start, disable }));
    } catch (error) {
      resources.beginShutdown();
      this.degraded(name, error);
      // A stuck disposer must not hold startup either. Shutdown retains the cleanup promise;
      // the next retry waits for the close itself, however long it takes.
      this.hold(name, attempt);
      this.hold(name, resources.close());
      registering.resolve();
      void boundedCleanup(name, resources, this.runtime).catch((failure: unknown) =>
        this.context.log.log("error", "Degraded service cleanup failed", logError(failure)),
      );
      this.context.signal.throwIfAborted();
      stopOnIncompatibleData(error);
      return [];
    }
  }
  /**
   * Starts listener-phase services once the daemon listens. Each one waits only for the
   * services it names in `requires` and `after` (their start and their listeners), so
   * independent services start together instead of one after another.
   */
  async listening(server: Server): Promise<void> {
    this.server = server;
    // Core services' listeners first: a listener-phase dependency must find them ready.
    await this.runListeners(this.listeners.splice(0), server);
    const settled = new Map<string, Promise<void>>();
    for (const definition of this.deferred) {
      const dependencies = [...definition.requires, ...definition.after].flatMap(
        (dependency) => settled.get(dependency) ?? [],
      );
      settled.set(
        definition.name,
        Promise.all(dependencies).then(async () => {
          await this.runListeners(await this.startOne(definition), server);
        }),
      );
    }
    await Promise.all(settled.values());
    for (const definition of this.definitions)
      if (this.retriable(definition)) this.retryLater(definition);
  }
  /**
   * Another attempt is scheduled or still to come: the service has retries left and none of what
   * it requires has run out of its own (a dependent starts again when its dependency does).
   * Only a service whose start failed is retried: a warmup that failed after a good start leaves
   * it running, and ace says so until it restarts. What a stuck cleanup still holds is not a
   * retry; the budget alone says whether another comes.
   */
  private willRetry(name: string): boolean {
    const definition = this.definitions.find((entry) => entry.name === name);
    if (!definition || failurePolicy(definition, this.critical) !== "degrade-and-retry")
      return false;
    if (this.skip.has(name) || this.context.signal.aborted) return false;
    if (this.statuses.get(name)?.state !== "degraded") return false;
    if (this.retryTimers.has(name)) return true;
    const own = (this.retriesUsed.get(name) ?? 0) < (this.runtime.retryDelaysMs?.length ?? 0);
    const required = definition.requires.filter(
      (dependency) => this.statuses.get(dependency)?.state === "degraded",
    );
    return required.length ? required.every((d) => this.willRetry(d)) : own;
  }
  /** Degraded, not essential, with every required service ready, and retries left. */
  private retriable(definition: ServiceDefinition): boolean {
    return (
      failurePolicy(definition, this.critical) === "degrade-and-retry" &&
      this.statuses.get(definition.name)?.state === "degraded" &&
      definition.requires.every((dependency) => this.statuses.get(dependency)?.state === "ready")
    );
  }
  private retryLater(definition: ServiceDefinition): void {
    const { name } = definition;
    const used = this.retriesUsed.get(name) ?? 0;
    const delay = this.runtime.retryDelaysMs?.[used];
    if (delay === undefined || this.context.signal.aborted || this.retryTimers.has(name)) return;
    this.retriesUsed.set(name, used + 1);
    const cancel = this.runtime.schedule(
      `retry ${name}`,
      () => {
        this.retryTimers.delete(name);
        // With the last retry fired, "retrying" turns false before the attempt reports anything.
        this.changed();
        void this.retry(definition).catch((error: unknown) => {
          // A stop during the retry aborts it; that is not a failure.
          if (!this.context.signal.aborted)
            this.context.log.log("error", "Service retry failed", logError(error));
        });
      },
      delay,
    );
    this.retryTimers.set(name, cancel);
    this.changed();
  }
  /** Starts a degraded service again; once it is ready, the services that require it follow. */
  private async retry(definition: ServiceDefinition): Promise<void> {
    const { server } = this;
    if (!server || this.context.signal.aborted || !this.retriable(definition)) return;
    const { name } = definition;
    // The last attempt is still stuck in a call: starting another would only stack them.
    if (this.inflight.has(name)) return this.retryLater(definition);
    this.context.log.log("info", "Retrying daemon service", logFields([["service", name]]));
    await this.runListeners(await this.startOne(definition), server);
    if (this.statuses.get(name)?.state !== "ready") return this.retryLater(definition);
    this.context.log.log("info", "Daemon service recovered", logFields([["service", name]]));
    this.retriesUsed.delete(name);
    for (const dependent of this.definitions)
      if (dependent.requires.includes(name)) await this.retry(dependent);
  }
  /** The shutdown budget, started by the first service to close. */
  private shutdownBudget(): Promise<void> {
    this.budget ??= new Promise((resolve) => {
      this.runtime.schedule("shutdown", resolve, this.runtime.cleanupTimeoutMs ?? 6_000);
    });
    return this.budget;
  }
  private inService<T>(name: string, work: () => T): T {
    return this.runtime.inService ? this.runtime.inService(name, work) : work();
  }
  /** Counts `work` against `name` until it settles; the attempt marker follows the count. */
  private hold(name: string, work: Promise<unknown>): void {
    const running = this.inflight.get(name) ?? 0;
    this.inflight.set(name, running + 1);
    if (running === 0) this.observeAttempt(name, true);
    const release = () => {
      const left = (this.inflight.get(name) ?? 1) - 1;
      if (left > 0) return void this.inflight.set(name, left);
      this.inflight.delete(name);
      this.observeAttempt(name, false);
    };
    work.then(release, release);
  }
  private observeAttempt(name: string, running: boolean): void {
    try {
      this.runtime.onAttempt?.(name, running);
    } catch (error) {
      this.context.log.log("error", "Startup observer failed", logError(error));
    }
  }
  private async runListeners(listeners: readonly ServiceListener[], server: Server): Promise<void> {
    for (const listener of listeners) {
      if (this.statuses.get(listener.name)?.state === "degraded") continue;
      // The listener's own call, which may outlive its deadline.
      let started: Promise<unknown> = Promise.resolve();
      const registering = Promise.withResolvers<void>();
      this.hold(listener.name, registering.promise);
      try {
        await bounded(
          listener.name,
          async () => {
            started = Promise.resolve(this.inService(listener.name, () => listener.start(server)));
            await started;
          },
          this.runtime,
          this.context.signal,
        ).finally(() => {
          this.hold(listener.name, started);
          registering.resolve();
        });
        this.record(listener.name, { name: listener.name, state: "ready" });
      } catch (error) {
        listener.disable();
        this.degraded(listener.name, error);
        this.context.signal.throwIfAborted();
        stopOnIncompatibleData(error);
      }
    }
  }
}
