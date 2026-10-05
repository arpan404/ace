import { createModelView, providerConfiguration } from "./preferences.ts";
import type { ProviderConfigurations } from "@ace/protocol";
import { createHash } from "node:crypto";
import { normalizeAcp } from "./normalize.ts";
import {
  ModelFilter,
  ModelListOptions,
  type CatalogModel,
  type ModelInstanceStatus,
  type ModelListResult,
  type ModelResolution,
  type ModelRoleSpec,
} from "@ace/protocol";
import { PendingDeletions } from "./deletions.ts";
import { CachedEntry } from "./cache-schema.ts";
import { resolveModel } from "./resolve.ts";
import {
  ModelInstance,
  type CacheEntry,
  type CatalogStorage,
  type Deadline,
  type DiscoverModels,
  type InstanceInput,
  type ModelCatalogApi,
} from "./types.ts";

type State = {
  config: ModelInstance;
  admit?: (() => Promise<void>) | undefined;
  entry?: CacheEntry;
  error?: ModelInstanceStatus["error"];
  retryAt: number;
  invalidating?: Promise<void>;
  flight?: Promise<ModelInstanceStatus>;
  probeRevision?: string;
  abort?: AbortController;
  view?: {
    preferences: ProviderConfigurations;
    entry?: CacheEntry;
    models: ReturnType<typeof createModelView>;
  };
};
const emptyPreferences: ProviderConfigurations = [];
function cacheRevision(instance: ModelInstance): string {
  return instance.provider === "opencode"
    ? createHash("sha256")
        .update(JSON.stringify([instance.loginRevision, "connected-providers-v1"]))
        .digest("hex")
    : instance.provider === "acp"
      ? createHash("sha256")
          .update(
            JSON.stringify([
              instance.loginRevision,
              instance.acpAgentId,
              instance.installationId,
              instance.instanceId,
              instance.profileRevision,
            ]),
          )
          .digest("hex")
      : instance.loginRevision;
}
export type CatalogOptions = {
  storage: CatalogStorage;
  discover: DiscoverModels;
  now: () => number;
  deadline: Deadline;
  instances?: readonly InstanceInput[];
  ttlMs?: number;
  timeoutMs?: number;
  retryMs?: number;
  concurrency?: number;
  /** Keep the snapshot stable between updates; replace it or call configurationChanged on edits. */
  preferences?: () => ProviderConfigurations;
};
export class ModelCatalog implements ModelCatalogApi {
  readonly #options: CatalogOptions;
  readonly #states = new Map<string, State>();
  readonly #providers = new Map<string, Set<string>>();
  readonly #persisted = new Map<string, CacheEntry>();
  readonly #queue: (() => void)[] = [];
  readonly #deletions: PendingDeletions;
  readonly #discoveries = new Set<Promise<void>>();
  readonly #instanceDiscoveries = new Map<string, Set<Promise<void>>>();
  readonly #removals = new Map<string, Promise<void>>();
  readonly #invalidations = new Set<Promise<void>>();
  readonly #flights = new Set<Promise<ModelInstanceStatus>>();
  readonly #sessionWrites = new Set<Promise<void>>();
  readonly #sessionTails = new Map<string, Promise<void>>();
  #closing: Promise<void> | undefined;
  #active = 0;
  #closed = false;
  constructor(options: CatalogOptions) {
    this.#options = options;
    this.#deletions = new PendingDeletions(options.storage);
    for (const duration of [
      options.ttlMs ?? 900_000,
      options.timeoutMs ?? 15_000,
      options.retryMs ?? 30_000,
    ]) {
      if (!Number.isFinite(duration) || duration < 1) throw new Error("Invalid catalog duration");
    }
    if (
      !Number.isInteger(options.concurrency ?? 4) ||
      (options.concurrency ?? 4) < 1 ||
      (options.concurrency ?? 4) > 64
    )
      throw new Error("Invalid concurrency");
    const entries = options.storage.load();
    if (entries.length > 64) throw new Error("Too many cached instances");
    for (const entry of entries) this.#persisted.set(entry.instance, CachedEntry.parse(entry));
    for (const instance of options.instances ?? []) this.registerInstance(instance);
  }
  #configuration(config: ModelInstance) {
    return providerConfiguration(this.#options.preferences?.() ?? [], config.provider, config.id);
  }
  #revision(config: ModelInstance): string {
    const path = this.#configuration(config).binaryPath;
    return path
      ? createHash("sha256")
          .update(JSON.stringify([cacheRevision(config), path]))
          .digest("hex")
      : cacheRevision(config);
  }
  #models(state: State) {
    const preferences = this.#options.preferences?.() ?? emptyPreferences;
    if (state.view?.preferences === preferences && state.view.entry === state.entry)
      return state.view.models;
    const models = createModelView(
      state.entry?.models ?? [],
      state.config.provider,
      state.config.id,
      providerConfiguration(preferences, state.config.provider, state.config.id),
    );
    state.view = { preferences, ...(state.entry ? { entry: state.entry } : {}), models };
    return models;
  }
  /** Fence disabled flights immediately; enabling resumes ordinary lazy discovery. */
  configurationChanged(): void {
    for (const state of this.#states.values()) {
      delete state.view;
      if (
        this.#configuration(state.config).enabled === false ||
        (state.probeRevision && state.probeRevision !== this.#revision(state.config))
      )
        state.abort?.abort();
      if (state.entry && state.entry.revision !== this.#revision(state.config)) {
        state.abort?.abort();
        delete state.entry;
        state.retryAt = 0;
      }
    }
  }
  hasProvider(provider: ModelInstance["provider"]): boolean {
    return (this.#providers.get(provider)?.size ?? 0) > 0;
  }
  hasInstance(instance: string): boolean {
    return this.#states.has(instance);
  }
  registerInstance(input: InstanceInput, admit?: () => Promise<void>): void {
    if (this.#closed) throw new Error("Catalog closed");
    const config = ModelInstance.parse(input);
    if (this.#removals.has(config.id)) throw new Error("Instance removal is still draining");
    const old = this.#states.get(config.id);
    if (!old && this.#states.size >= 64) throw new Error("Instance limit reached");
    // Re-registration also invalidates flights when executable/env/cwd changed.
    const entry = old?.entry ?? this.#persisted.get(config.id);
    const compatible =
      entry?.revision === this.#revision(config) && entry.provider === config.provider;
    if (entry && !compatible) void this.#deletions.remove(config.id);
    old?.abort?.abort();
    if (old) this.#providers.get(old.config.provider)?.delete(config.id);
    if (!old && !this.#persisted.has(config.id) && this.#states.size + this.#persisted.size >= 64) {
      const evicted = this.#persisted.keys().next().value;
      if (evicted !== undefined) {
        void this.#deletions.remove(evicted);
        this.#persisted.delete(evicted);
      }
    }
    this.#states.set(config.id, {
      config,
      ...((admit ?? old?.admit) ? { admit: admit ?? old?.admit } : {}),
      ...(compatible ? { entry } : {}),
      retryAt: 0,
    });
    const ids = this.#providers.get(config.provider) ?? new Set<string>();
    ids.add(config.id);
    this.#providers.set(config.provider, ids);
    this.#persisted.delete(config.id);
  }
  /** Metadata from an already authorized session. No process, session or inference is started. */
  async updateFromSession(input: InstanceInput, metadata: unknown): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Catalog closed"));
    if (this.#sessionWrites.size >= 64)
      return Promise.reject(new Error("Session metadata capacity reached"));
    const instance = ModelInstance.parse(input);
    const state = this.#states.get(instance.id);
    if (!state || cacheRevision(state.config) !== cacheRevision(instance))
      return Promise.reject(new Error("Session model generation changed"));
    const models = normalizeAcp(metadata, instance);
    const entry = CachedEntry.parse({
      provider: instance.provider,
      instance: instance.id,
      revision: this.#revision(instance),
      refreshedAt: this.#options.now(),
      models,
    });
    const previous = this.#sessionTails.get(instance.id) ?? Promise.resolve();
    const write = previous
      .catch(() => {})
      .then(async () => {
        if (this.#states.get(instance.id) !== state)
          throw new Error("Session model generation changed");
        if (this.#deletions.has(instance.id)) await this.#deletions.remove(instance.id);
        if (this.#states.get(instance.id) !== state)
          throw new Error("Session model generation changed");
        await this.#options.storage.replace(entry);
        if (this.#states.get(instance.id) === state) {
          state.entry = entry;
          delete state.error;
        }
      });
    this.#sessionWrites.add(write);
    this.#sessionTails.set(instance.id, write);
    const cleanup = () => {
      this.#sessionWrites.delete(write);
      if (this.#sessionTails.get(instance.id) === write) this.#sessionTails.delete(instance.id);
    };
    void write.then(cleanup, cleanup);
    return write;
  }
  loginChanged(instance: string, revision: string): Promise<ModelInstanceStatus[]> {
    const state = this.#states.get(instance);
    if (!state) throw new Error("Unknown instance");
    this.registerInstance({ ...state.config, loginRevision: revision });
    return this.refresh({ instance });
  }
  removeInstance(instance: string): Promise<void> {
    instance = ModelInstance.shape.id.parse(instance);
    const existing = this.#removals.get(instance);
    if (existing) return existing;
    if (this.#removals.size >= 128) throw new Error("Instance removal capacity reached");
    const state = this.#states.get(instance);
    state?.abort?.abort();
    if (state) this.#providers.get(state.config.provider)?.delete(instance);
    this.#states.delete(instance);
    this.#persisted.delete(instance);
    const removal = Promise.resolve().then(async () => {
      // Storage failure must not short-circuit process cleanup. Flight settles before
      // sampling cleanup, including a discovery that started during admission.
      const results = await Promise.allSettled([
        this.#deletions.remove(instance),
        state?.flight,
        state?.invalidating,
        this.#sessionTails.get(instance),
      ]);
      await Promise.all(this.#instanceDiscoveries.get(instance) ?? []);
      // A flight/write already committing may have raced the first deletion.
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) throw new AggregateError(failures, "Model persistence deletion failed");
      await this.#deletions.remove(instance);
    });
    this.#removals.set(instance, removal);
    const settled = () => this.#removals.delete(instance);
    void removal.then(settled, settled);
    return removal;
  }
  #select(filter: ModelFilter): State[] {
    const matches = (state: State) =>
      (!filter.provider || state.config.provider === filter.provider) &&
      (!filter.acpAgentId || state.config.acpAgentId === filter.acpAgentId) &&
      (!filter.installationId || state.config.installationId === filter.installationId) &&
      (!filter.instanceId || state.config.instanceId === filter.instanceId);
    if (filter.instance) {
      const state = this.#states.get(filter.instance);
      return state && matches(state) ? [state] : [];
    }
    if (filter.provider)
      return [...(this.#providers.get(filter.provider) ?? [])].flatMap((id) => {
        const state = this.#states.get(id);
        return state && matches(state) ? [state] : [];
      });
    return [...this.#states.values()].filter(matches);
  }
  #stale(state: State): boolean {
    return (
      !state.entry ||
      this.#options.now() - state.entry.refreshedAt >= (this.#options.ttlMs ?? 900_000)
    );
  }
  #status(state: State): ModelInstanceStatus {
    return {
      provider: state.config.provider,
      instance: state.config.id,
      ...(state.config.acpAgentId ? { acpAgentId: state.config.acpAgentId } : {}),
      ...(state.config.installationId ? { installationId: state.config.installationId } : {}),
      ...(state.config.instanceId ? { instanceId: state.config.instanceId } : {}),
      ...(state.entry
        ? { refreshedAt: state.entry.refreshedAt, lastRefreshedAt: state.entry.refreshedAt }
        : {}),
      enabled: this.#configuration(state.config).enabled !== false,
      stale: this.#stale(state),
      refreshing: state.flight !== undefined,
      ...(state.error ? { error: state.error } : {}),
    };
  }
  #revalidate(states: State[]): void {
    if (this.#closed) return;
    for (const state of states)
      if (this.#stale(state) && this.#options.now() >= state.retryAt) void this.#refresh(state);
  }
  list(input: ModelListOptions = {}): ModelListResult {
    const options = ModelListOptions.parse(input);
    const states = this.#select(options);
    this.#revalidate(states);
    const models: ModelListResult["models"] = [];
    let skipped = options.offset;
    let remaining = options.limit + 1;
    for (const state of states) {
      const rows = this.#models(state);
      if (skipped >= rows.length) {
        skipped -= rows.length;
        continue;
      }
      const end = Math.min(rows.length, skipped + remaining);
      for (let position = skipped; position < end; position++) {
        const row = rows.at(position);
        if (row) {
          models.push(row);
          remaining--;
        }
      }
      skipped = 0;
      if (!remaining) break;
    }
    const more = models.length > options.limit;
    if (more) models.pop();
    return {
      models,
      instances: states.map((state) => this.#status(state)),
      ...(more ? { nextOffset: options.offset + options.limit } : {}),
    };
  }
  *#availableModels(states: State[]): Generator<CatalogModel> {
    for (const state of states) yield* this.#models(state);
  }
  resolve(input: ModelRoleSpec): ModelResolution {
    const filter = ModelFilter.parse(input);
    const states = this.#select(filter);
    this.#revalidate(states);
    return resolveModel(input, this.#availableModels(states), (id) => {
      const state = this.#states.get(id);
      return !state || this.#stale(state);
    });
  }
  /** Account-change boundary: revoke cached choices and obsolete discoveries immediately. */
  async invalidate(input: ModelFilter = {}): Promise<void> {
    if (this.#closed) throw new Error("Catalog closed");
    const selected = this.#select(ModelFilter.parse(input));
    if (this.#invalidations.size + selected.length > 128)
      throw new Error("Invalidation capacity reached");
    const pending: Promise<void>[] = [];
    for (const state of selected) {
      // Generic ACP has no metadata-only probe; its account owner supplies session metadata.
      if (state.config.provider === "acp") continue;
      delete state.entry;
      this.registerInstance(state.config);
      const next = this.#states.get(state.config.id);
      if (!next) continue;
      // A storage write already in flight must settle before revoking its persisted rows.
      const removal = Promise.allSettled([state.flight, state.invalidating]).then(() =>
        this.#deletions.remove(state.config.id),
      );
      next.invalidating = removal;
      this.#invalidations.add(removal);
      const done = () => this.#invalidations.delete(removal);
      void removal.then(done, done);
      pending.push(removal);
    }
    await Promise.all(pending);
  }
  async refresh(input: ModelFilter = {}): Promise<ModelInstanceStatus[]> {
    if (this.#closed) throw new Error("Catalog closed");
    return Promise.all(this.#select(ModelFilter.parse(input)).map((state) => this.#refresh(state)));
  }
  #refresh(state: State): Promise<ModelInstanceStatus> {
    if (state.config.provider === "acp" || this.#configuration(state.config).enabled === false)
      return Promise.resolve(this.#status(state));
    if (state.flight) return state.flight;
    if (this.#flights.size >= 64 || this.#discoveries.size >= 64) {
      state.error = "discovery_failed";
      state.retryAt = this.#options.now() + (this.#options.retryMs ?? 30_000);
      return Promise.resolve(this.#status(state));
    }
    const abort = new AbortController();
    const revision = this.#revision(state.config);
    state.probeRevision = revision;
    state.abort = abort;
    // Deferring lets flight be installed before synchronous discovery implementations settle.
    const flight = Promise.resolve()
      .then(async () => {
        await this.#acquire();
        let cancel: (() => void) | undefined;
        let timedOut = false;
        try {
          await state.invalidating;
          try {
            await state.admit?.();
          } catch (error) {
            if (this.#states.get(state.config.id) !== state || this.#closed) return;
            // A failed home/identity guard revokes cached choices too. A provider
            // discovery failure below may retain stale rows from a valid home.
            delete state.entry;
            await this.#deletions.remove(state.config.id);
            throw error;
          }
          if (abort.signal.aborted || this.#closed) return;
          if (this.#discoveries.size >= 64) throw new Error("Discovery cleanup limit reached");
          const failure = new Promise<never>((_, reject) => {
            const onAbort = () => reject(new Error("aborted"));
            abort.signal.addEventListener("abort", onAbort, { once: true });
            cancel = () => abort.signal.removeEventListener("abort", onAbort);
          });
          const stopDeadline = this.#options.deadline(() => {
            timedOut = true;
            abort.abort();
          }, this.#options.timeoutMs ?? 15_000);
          const cleanupAbort = cancel;
          cancel = () => {
            stopDeadline();
            cleanupAbort?.();
          };
          const configuration = this.#configuration(state.config);
          if (configuration.enabled === false) return;
          const discovery = this.#options.discover(
            { ...state.config, executable: configuration.binaryPath ?? state.config.executable },
            abort.signal,
          );
          const cleanup = discovery.then(
            () => {},
            () => {},
          );
          this.#discoveries.add(cleanup);
          const owned = this.#instanceDiscoveries.get(state.config.id) ?? new Set<Promise<void>>();
          owned.add(cleanup);
          this.#instanceDiscoveries.set(state.config.id, owned);
          void cleanup.then(() => {
            this.#discoveries.delete(cleanup);
            owned.delete(cleanup);
            if (!owned.size) this.#instanceDiscoveries.delete(state.config.id);
          });
          const models = await Promise.race([discovery, failure]);
          if (
            this.#states.get(state.config.id) !== state ||
            this.#closed ||
            abort.signal.aborted ||
            this.#revision(state.config) !== revision
          )
            return;
          const entry = CachedEntry.parse({
            provider: state.config.provider,
            instance: state.config.id,
            revision,
            refreshedAt: this.#options.now(),
            models,
          });
          try {
            // Only this instance's deletion is a prerequisite. Unrelated failures retain
            // their durable slots; SQLite admission still refuses actual overflow.
            if (this.#deletions.has(state.config.id)) await this.#deletions.remove(state.config.id);
            await this.#deletions.retry();
            if (
              this.#states.get(state.config.id) !== state ||
              this.#closed ||
              abort.signal.aborted ||
              this.#revision(state.config) !== revision
            )
              return;
            await this.#options.storage.replace(entry);
          } catch {
            state.error = "persistence_failed";
            return;
          }
          if (
            this.#states.get(state.config.id) !== state ||
            this.#closed ||
            abort.signal.aborted ||
            this.#revision(state.config) !== revision
          )
            return;
          state.entry = entry;
          delete state.error;
          state.retryAt = 0;
        } catch {
          state.error = timedOut ? "timeout" : "discovery_failed";
        } finally {
          cancel?.();
          this.#release();
          if (state.error) state.retryAt = this.#options.now() + (this.#options.retryMs ?? 30_000);
        }
      })
      .then(() => {
        this.#flights.delete(flight);
        delete state.flight;
        delete state.abort;
        delete state.probeRevision;
        return this.#status(state);
      });
    this.#flights.add(flight);
    state.flight = flight;
    return flight;
  }
  async #acquire(): Promise<void> {
    if (this.#active < (this.#options.concurrency ?? 4)) {
      this.#active++;
      return;
    }
    await new Promise<void>((resolve) => this.#queue.push(resolve));
  }
  #release(): void {
    const next = this.#queue.shift();
    if (next) next();
    else this.#active--;
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    const closing = (async () => {
      this.#closed = true;
      for (const state of this.#states.values()) state.abort?.abort();
      await Promise.all(this.#flights);
      await Promise.all(this.#invalidations);
      const writes = await Promise.allSettled(this.#sessionWrites);
      const failures = writes.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) throw new AggregateError(failures, "Session model persistence failed");
      await Promise.all(this.#discoveries);
      await Promise.allSettled(this.#removals.values());
      await this.#deletions.flush();
      await this.#options.storage.close();
    })();
    this.#closing = closing;
    // A failed durable deletion must remain retryable with the storage still open.
    void closing.catch(() => {
      if (this.#closing === closing) this.#closing = undefined;
    });
    return closing;
  }
}
