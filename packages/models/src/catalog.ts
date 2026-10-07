import { connectionRevision } from "./discovery-revision.ts";
import { discoveryError } from "./discovery-errors.ts";
import { refreshedSources } from "./catalog-sources.ts";
import { cleanCatalog } from "./catalog-cleanup.ts";
import { createCleanModelView, providerConfiguration } from "./preferences.ts";
import { freezeCatalogModel } from "./freeze.ts";
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
  errorDetail?: ModelInstanceStatus["errorDetail"];
  dirty?: boolean;
  probe?: { abort: AbortController; done: Promise<void> };
  retryAt: number;
  settingsKey: string;
  invalidating?: Promise<void>;
  flight?: Promise<ModelInstanceStatus>;
  probeRevision?: string;
  abort?: AbortController;
  view?: {
    preferences: ProviderConfigurations;
    entry?: CacheEntry;
    models: ReturnType<typeof createCleanModelView>;
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
function identityRevision(instance: ModelInstance): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        instance.id,
        instance.provider,
        instance.loginRevision,
        instance.backend,
        instance.homeDir,
        instance.cwd,
        instance.acpAgentId,
        instance.installationId,
        instance.instanceId,
        instance.profileRevision,
      ]),
    )
    .digest("hex");
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
  revisionProbe?: (instance: ModelInstance, signal: AbortSignal) => Promise<string>;
  onError?: (
    provider: ModelInstance["provider"],
    instance: string,
    error: NonNullable<ModelInstanceStatus["errorDetail"]>,
    source?: string,
  ) => void;
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
  readonly #probes = new Set<Promise<void>>();
  readonly #listeners = new Set<(filter: ModelFilter) => void>();
  #closing: Promise<void> | undefined;
  #active = 0;
  #closed = false;
  constructor(options: CatalogOptions) {
    this.#options = options;
    this.#deletions = new PendingDeletions(options.storage);
    for (const duration of [
      options.ttlMs ?? 21_600_000,
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
    for (const entry of entries) {
      const parsed = CachedEntry.parse(entry);
      this.#persisted.set(parsed.instance, {
        ...parsed,
        ...refreshedSources(
          cleanCatalog(parsed.models).map(freezeCatalogModel),
          parsed.sources,
          undefined,
          parsed.refreshedAt,
        ),
      });
    }
    for (const instance of options.instances ?? []) this.registerInstance(instance);
  }
  listen(listener: (filter: ModelFilter) => void): () => void {
    if (this.#listeners.size >= 4096) throw new Error("Catalog listener limit reached");
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #changed(state: State): void {
    for (const listener of this.#listeners) {
      try {
        listener({ provider: state.config.provider, instance: state.config.id });
      } catch {
        /* One disconnected client cannot stop discovery. */
      }
    }
  }
  #failed(
    state: State,
    error: unknown,
    fallback: NonNullable<ModelInstanceStatus["errorDetail"]>["code"] = "discovery_failed",
  ): void {
    state.errorDetail = discoveryError(error, fallback);
    this.#options.onError?.(state.config.provider, state.config.id, state.errorDetail);
  }
  #configuration(config: ModelInstance) {
    return providerConfiguration(this.#options.preferences?.() ?? [], config.provider, config.id);
  }
  #revision(config: ModelInstance): string {
    const path = this.#configuration(config).binaryPath;
    return path
      ? createHash("sha256")
          .update(JSON.stringify([cacheRevision(config), path, config.installationVersion]))
          .digest("hex")
      : config.installationVersion
        ? createHash("sha256")
            .update(JSON.stringify([cacheRevision(config), config.installationVersion]))
            .digest("hex")
        : cacheRevision(config);
  }
  #models(state: State) {
    const preferences = this.#options.preferences?.() ?? emptyPreferences;
    if (state.view?.preferences === preferences && state.view.entry === state.entry)
      return state.view.models;
    const models = createCleanModelView(
      state.entry?.models ?? [],
      state.config.provider,
      state.config.id,
      providerConfiguration(preferences, state.config.provider, state.config.id),
      state.config.label,
    );
    state.view = { preferences, ...(state.entry ? { entry: state.entry } : {}), models };
    return models;
  }
  /** Fence disabled flights immediately; enabling resumes ordinary lazy discovery. */
  configurationChanged(): void {
    for (const state of this.#states.values()) {
      const settingsKey = JSON.stringify(this.#configuration(state.config));
      if (settingsKey === state.settingsKey) continue;
      state.settingsKey = settingsKey;
      delete state.view;
      state.dirty = true;
      state.retryAt = 0;
      if (
        this.#configuration(state.config).enabled === false ||
        (state.probeRevision && state.probeRevision !== this.#revision(state.config))
      )
        state.abort?.abort();
      if (state.entry && state.entry.revision !== this.#revision(state.config)) {
        state.abort?.abort();
        state.dirty = true;
        state.retryAt = 0;
      }
      this.#changed(state);
      if (state.flight)
        void state.flight.then(() => {
          if (!this.#closed && this.#states.get(state.config.id) === state)
            void this.#refresh(state);
        });
      else void this.#refresh(state);
    }
  }
  /** Poll only CLI connection metadata. Unchanged metadata never starts catalog discovery. */
  reconcileConnections(): Promise<void> {
    if (this.#closed || !this.#options.revisionProbe) return Promise.resolve();
    const probe = this.#options.revisionProbe;
    const tasks: Promise<void>[] = [];
    for (const state of this.#states.values()) {
      if (
        !["opencode", "pi"].includes(state.config.provider) ||
        this.#configuration(state.config).enabled === false
      )
        continue;
      if (state.probe) {
        tasks.push(state.probe.done);
        continue;
      }
      if (state.flight || this.#probes.size >= 64) continue;
      const abort = new AbortController();
      const revision = this.#revision(state.config);
      const stop = this.#options.deadline(() => abort.abort(), this.#options.timeoutMs ?? 15_000);
      const done = Promise.resolve().then(async () => {
        try {
          const configuration = this.#configuration(state.config);
          const fingerprint = await probe(
            { ...state.config, executable: configuration.binaryPath ?? state.config.executable },
            abort.signal,
          );
          if (
            abort.signal.aborted ||
            this.#closed ||
            this.#states.get(state.config.id) !== state ||
            revision !== this.#revision(state.config)
          )
            return;
          if (fingerprint !== state.entry?.connectionRevision || state.error) {
            state.dirty = true;
            await this.#refresh(state);
          }
        } catch (error) {
          if (!this.#closed && this.#states.get(state.config.id) === state) {
            state.error = "discovery_failed";
            this.#failed(state, error);
            state.retryAt = this.#options.now() + (this.#options.retryMs ?? 30_000);
            this.#changed(state);
          }
        } finally {
          stop();
          delete state.probe;
          this.#probes.delete(done);
        }
      });
      state.probe = { abort, done };
      this.#probes.add(done);
      tasks.push(done);
    }
    return Promise.all(tasks).then(() => {});
  }
  installationChanged(provider: ModelInstance["provider"], version: string): void {
    for (const state of this.#select({ provider })) {
      if (state.config.installationVersion === version) continue;
      state.config = { ...state.config, installationVersion: version };
      state.dirty = true;
      state.retryAt = 0;
      state.abort?.abort();
      const refresh = () => {
        if (!this.#closed && this.#states.get(state.config.id) === state) void this.#refresh(state);
      };
      if (state.flight) void state.flight.then(refresh);
      else refresh();
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
      entry?.provider === config.provider &&
      (old
        ? identityRevision(old.config) === identityRevision(config)
        : entry.identityRevision
          ? entry.identityRevision === identityRevision(config)
          : entry.revision === this.#revision(config));
    if (entry && !compatible) void this.#deletions.remove(config.id);
    old?.abort?.abort();
    old?.probe?.abort.abort();
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
      ...(compatible ? { entry, dirty: entry?.revision !== this.#revision(config) } : {}),
      retryAt: 0,
      settingsKey: JSON.stringify(this.#configuration(config)),
    });
    const ids = this.#providers.get(config.provider) ?? new Set<string>();
    ids.add(config.id);
    this.#providers.set(config.provider, ids);
    this.#persisted.delete(config.id);
    const registered = this.#states.get(config.id);
    if (registered && entry && compatible && !old) {
      registered.dirty = true;
      void this.#refresh(registered);
    }
    if (registered) this.#changed(registered);
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
      loginRevision: instance.loginRevision,
      identityRevision: identityRevision(instance),
      refreshedAt: this.#options.now(),
      ...refreshedSources(cleanCatalog(models), undefined, state.entry, this.#options.now()),
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
          state.dirty = false;
          delete state.error;
          delete state.errorDetail;
          this.#changed(state);
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
    state?.probe?.abort.abort();
    if (state) this.#providers.get(state.config.provider)?.delete(instance);
    this.#states.delete(instance);
    this.#persisted.delete(instance);
    if (state) this.#changed(state);
    const removal = Promise.resolve().then(async () => {
      // Storage failure must not short-circuit process cleanup. Flight settles before
      // sampling cleanup, including a discovery that started during admission.
      const results = await Promise.allSettled([
        this.#deletions.remove(instance),
        state?.flight,
        state?.invalidating,
        this.#sessionTails.get(instance),
      ]);
      await state?.probe?.done;
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
      state.dirty === true ||
      state.error !== undefined ||
      state.entry?.sources?.some((source) => source.error) === true ||
      !state.entry ||
      this.#options.now() - state.entry.refreshedAt >= (this.#options.ttlMs ?? 21_600_000)
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
      status: state.flight ? "refreshing" : this.#stale(state) ? "stale" : "fresh",
      ...(state.errorDetail ? { errorDetail: state.errorDetail } : {}),
      // oxlint-disable-next-line oxc/no-map-spread -- Clone immutable cached values for this view.
      sources: (state.entry?.sources ?? []).map((source) => ({
        ...source,
        source:
          state.config.label && source.source.kind === "account"
            ? { ...source.source, label: state.config.label }
            : source.source,
        status: state.flight
          ? "refreshing"
          : state.error ||
              state.dirty ||
              !state.entry ||
              this.#options.now() - (source.lastRefreshedAt ?? state.entry.refreshedAt) >=
                (this.#options.ttlMs ?? 21_600_000) ||
              source.error
            ? "stale"
            : "fresh",
        ...(state.errorDetail ? { error: state.errorDetail } : {}),
      })),
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
  revalidate(): void {
    this.#revalidate(this.#select({}));
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
    return this.#resolve(input, states);
  }
  resolveCached(input: ModelRoleSpec): ModelResolution {
    return this.#resolve(input, this.#select(ModelFilter.parse(input)));
  }
  #resolve(input: ModelRoleSpec, states: State[]): ModelResolution {
    return resolveModel(input, this.#availableModels(states), (id) => {
      const state = this.#states.get(id);
      return !state || this.#stale(state);
    });
  }
  /** Mark cached data stale without removing usable choices. Login changes revoke identity separately. */
  async invalidate(input: ModelFilter = {}): Promise<void> {
    for (const state of this.#select(ModelFilter.parse(input))) {
      if (state.config.provider === "acp") continue;
      state.dirty = true;
      state.retryAt = 0;
      this.#changed(state);
    }
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
      this.#failed(state, undefined);
      state.retryAt = this.#options.now() + (this.#options.retryMs ?? 30_000);
      this.#changed(state);
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
          if (!models.length && models.sources === undefined)
            throw new Error("The CLI returned no model choices");
          const combined = refreshedSources(
            cleanCatalog(models),
            models.sources,
            state.entry,
            this.#options.now(),
          );
          const entry = CachedEntry.parse({
            provider: state.config.provider,
            instance: state.config.id,
            revision,
            loginRevision: state.config.loginRevision,
            identityRevision: identityRevision(state.config),
            refreshedAt: this.#options.now(),
            connectionRevision: connectionRevision(
              state.config.provider,
              models,
              models.sources?.map((source) => source.source) ?? [],
            ),
            ...combined,
            models: cleanCatalog(combined.models),
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
            this.#failed(state, undefined, "persistence_failed");
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
          state.dirty = false;
          delete state.error;
          delete state.errorDetail;
          for (const source of entry.sources ?? [])
            if (source.error)
              this.#options.onError?.(
                state.config.provider,
                state.config.id,
                source.error,
                source.source.id,
              );
          state.retryAt = entry.sources?.some((source) => source.error)
            ? this.#options.now() + (this.#options.retryMs ?? 30_000)
            : 0;
        } catch (error) {
          state.error = timedOut ? "timeout" : "discovery_failed";
          this.#failed(
            state,
            timedOut ? undefined : error,
            timedOut ? "timeout" : "discovery_failed",
          );
          if (
            state.entry &&
            this.#states.get(state.config.id) === state &&
            !this.#closed &&
            revision === this.#revision(state.config)
          ) {
            const retained = {
              ...state.entry,
              // oxlint-disable-next-line oxc/no-map-spread -- Clone immutable cached values for this view.
              sources: (state.entry.sources ?? []).map((source) => ({
                ...source,
                status: "stale" as const,
                error: state.errorDetail,
              })),
            };
            try {
              await this.#options.storage.replace(retained);
              state.entry = retained;
            } catch {
              /* Memory still retains the last good catalog. */
            }
          }
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
        if (this.#states.get(state.config.id) === state && !this.#closed) this.#changed(state);
        return this.#status(state);
      });
    this.#flights.add(flight);
    state.flight = flight;
    this.#changed(state);
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
      this.#listeners.clear();
      for (const state of this.#states.values()) {
        state.abort?.abort();
        state.probe?.abort.abort();
      }
      await Promise.all(this.#probes);
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
