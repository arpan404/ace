import { nativePermissionModes, acpPermissionModes } from "@ace/provider-kit/permission-modes";
import { DiscoveryBackoff } from "./discovery-backoff.ts";
import { connectionRevision } from "./discovery-revision.ts";
import { discoveryError } from "./discovery-errors.ts";
import { discoveryFailureReason } from "@ace/provider-kit/discovery-failure";
import { refreshedSources, sourceFailed } from "./catalog-sources.ts";
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
  type DiscoveryDiagnostics,
  type InstanceInput,
  type ModelCatalogApi,
} from "./types.ts";

type State = {
  config: ModelInstance;
  permissionModes?: ModelInstanceStatus["permissionModes"];
  admit?: (() => Promise<void>) | undefined;
  entry?: CacheEntry;
  error?: ModelInstanceStatus["error"];
  errorDetail?: ModelInstanceStatus["errorDetail"];
  dirty?: boolean;
  noModelSources?: Set<string>;
  unconfiguredAt?: number;
  probe?: { abort: AbortController; done: Promise<void> };
  retryAt: number;
  backoff: DiscoveryBackoff;
  connectionFingerprint?: string | undefined;
  probeRetryAt?: number;
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
  random?: () => number;
  concurrency?: number;
  /** Keep the snapshot stable between updates; replace it or call configurationChanged on edits. */
  preferences?: () => ProviderConfigurations;
  revisionProbe?: (
    instance: ModelInstance,
    signal: AbortSignal,
    diagnostic?: (metadata: DiscoveryDiagnostics) => void,
  ) => Promise<string>;
  onError?: (
    provider: ModelInstance["provider"],
    instance: string,
    error: NonNullable<ModelInstanceStatus["errorDetail"]>,
    source?: string,
    diagnostic?: {
      durationMs: number;
      cliVersion?: string;
      sourceLabel?: string;
      stage?: DiscoveryDiagnostics["stage"];
      level?: "warn" | "debug" | "info";
      retryInMs?: number;
      /** Local log only. Never included in catalog state, storage, or client responses. */
      reason?: string;
      /** A skipped metadata row, not a failed refresh. Local logging only. */
      modelIndex?: number;
    },
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
    startedAt: number = this.#options.now(),
    diagnostic: DiscoveryDiagnostics = {},
  ): void {
    // OpenCode connection identities cannot identify the source of an instance failure.
    // Other providers retain the source context learned by their discovery owner.
    const sources =
      state.config.provider === "opencode"
        ? undefined
        : (diagnostic.sources ?? state.entry?.sources?.map((entry) => entry.source));
    state.errorDetail = discoveryError(error, fallback, {
      ...state.config,
      ...(sources?.length === 1 && sources[0] ? { source: sources[0].id } : {}),
    });
    if (state.errorDetail.code === "not_configured") {
      const first = state.unconfiguredAt === undefined;
      state.unconfiguredAt = this.#options.now();
      state.dirty = false;
      delete state.error;
      delete state.entry;
      state.backoff.reset();
      state.retryAt = 0;
      if (first)
        this.#options.onError?.(
          state.config.provider,
          state.config.id,
          state.errorDetail,
          undefined,
          { level: "info", durationMs: Math.max(0, this.#options.now() - startedAt) },
        );
      return;
    }
    delete state.unconfiguredAt;
    // Unchanged metadata and an empty catalog cannot recover on a short retry.
    // Explicit refresh and identity/configuration changes still reset eligibility.
    const terminal = ["no_models", "parse_failure", "cli_too_old"].includes(state.errorDetail.code);
    const schedule = terminal
      ? {
          level: state.errorDetail.code === "no_models" ? ("info" as const) : ("warn" as const),
          retryInMs: this.#options.ttlMs ?? 21_600_000,
        }
      : undefined;
    if (schedule) {
      state.backoff.reset();
      state.retryAt = this.#options.now() + schedule.retryInMs;
    } else
      state.backoff.retain(new Set(sources?.length ? sources.map((source) => source.id) : [""]));
    if (sources?.length) {
      for (const source of sources)
        this.#reportFailure(
          state,
          state.errorDetail,
          startedAt,
          diagnostic,
          source,
          error,
          schedule,
        );
    } else
      this.#reportFailure(
        state,
        state.errorDetail,
        startedAt,
        diagnostic,
        undefined,
        error,
        schedule,
      );
    if (!schedule) state.retryAt = state.backoff.retryAt();
  }

  #reportFailure(
    state: State,
    error: NonNullable<ModelInstanceStatus["errorDetail"]>,
    startedAt: number,
    diagnostic: DiscoveryDiagnostics,
    source?: import("@ace/protocol").ModelSource,
    cause?: unknown,
    scheduleOverride?: { level: "warn" | "debug" | "info"; retryInMs: number },
  ): void {
    const schedule =
      scheduleOverride ??
      state.backoff.fail(
        source?.id ?? "",
        error.code,
        this.#options.now(),
        this.#options.retryMs ?? 30_000,
        this.#options.random?.() ?? 0.5,
      );
    const cliVersion = diagnostic.cliVersion ?? state.config.installationVersion;
    const detail = discoveryError(error, error.code, {
      ...state.config,
      ...(source ? { source: source.id } : {}),
    });
    const reason =
      detail.code === "discovery_failed" && (cause !== undefined || source)
        ? discoveryFailureReason(
            source
              ? (diagnostic.sourceFailures?.find((failure) => failure.source === source.id)
                  ?.reason ?? cause)
              : cause,
            { env: state.config.env },
          ).slice(0, 200)
        : undefined;
    this.#options.onError?.(state.config.provider, state.config.id, detail, source?.id, {
      ...schedule,
      durationMs: Math.max(0, this.#options.now() - startedAt),
      ...(cliVersion ? { cliVersion } : {}),
      ...(source ? { sourceLabel: source.label } : {}),
      ...(diagnostic.stage ? { stage: diagnostic.stage } : {}),
      ...(reason ? { reason } : {}),
    });
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
      state.probeRetryAt = 0;
      state.backoff.reset();
      state.retryAt = 0;
      if (
        this.#configuration(state.config).enabled === false ||
        (state.probeRevision && state.probeRevision !== this.#revision(state.config))
      )
        state.abort?.abort();
      if (state.entry && state.entry.revision !== this.#revision(state.config)) {
        state.abort?.abort();
        state.dirty = true;
        state.probeRetryAt = 0;
        state.backoff.reset();
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
      if (
        state.flight ||
        this.#probes.size >= 64 ||
        this.#options.now() < (state.probeRetryAt ?? 0)
      )
        continue;
      const abort = new AbortController();
      const revision = this.#revision(state.config);
      const startedAt = this.#options.now();
      let diagnostic: DiscoveryDiagnostics = {};
      let timedOut = false;
      const stop = this.#options.deadline(() => {
        timedOut = true;
        abort.abort();
      }, this.#options.timeoutMs ?? 15_000);
      const done = Promise.resolve().then(async () => {
        try {
          const configuration = this.#configuration(state.config);
          const fingerprint = await probe(
            { ...state.config, executable: configuration.binaryPath ?? state.config.executable },
            abort.signal,
            (metadata) => {
              diagnostic = { ...diagnostic, ...metadata };
            },
          );
          if (
            abort.signal.aborted ||
            this.#closed ||
            this.#states.get(state.config.id) !== state ||
            revision !== this.#revision(state.config)
          )
            return;
          const changed =
            state.connectionFingerprint !== undefined &&
            fingerprint !== state.connectionFingerprint;
          state.connectionFingerprint = fingerprint;
          state.probeRetryAt = 0;
          if (changed) {
            state.backoff.reset();
            state.retryAt = 0;
            state.dirty = true;
          }
          if (changed || this.#stale(state)) await this.#refresh(state);
        } catch (error) {
          if (
            (timedOut || !abort.signal.aborted) &&
            !this.#closed &&
            this.#states.get(state.config.id) === state &&
            revision === this.#revision(state.config)
          ) {
            state.error = timedOut ? "timeout" : "discovery_failed";
            this.#failed(state, timedOut ? undefined : error, state.error, startedAt, diagnostic);
            state.probeRetryAt = state.retryAt;
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
  installationChanged(
    provider: ModelInstance["provider"],
    version: string,
    runtime: "cli" | "cursor-sdk" = "cli",
  ): void {
    for (const state of this.#select({ provider })) {
      if ((state.config.backend === "cursor-sdk" ? "cursor-sdk" : "cli") !== runtime) continue;
      if (state.config.installationVersion === version) continue;
      state.config = { ...state.config, installationVersion: version };
      state.dirty = true;
      state.probeRetryAt = 0;
      state.backoff.reset();
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
      backoff: new DiscoveryBackoff(),
      connectionFingerprint: compatible ? entry?.connectionRevision : undefined,
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
  updatePermissionModes(
    instance: string,
    modes: readonly import("@ace/protocol").NativePermissionMode[],
  ): void {
    const state = this.#states.get(instance);
    if (!state || this.#closed) return;
    state.permissionModes = [...modes];
    this.#changed(state);
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
    const permissionModes = acpPermissionModes(metadata);
    const entry = CachedEntry.parse({
      provider: instance.provider,
      instance: instance.id,
      revision: this.#revision(instance),
      loginRevision: instance.loginRevision,
      identityRevision: identityRevision(instance),
      refreshedAt: this.#options.now(),
      permissionModes,
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
          delete state.unconfiguredAt;
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
    if (state.unconfiguredAt !== undefined && !state.dirty)
      return this.#options.now() - state.unconfiguredAt >= (this.#options.ttlMs ?? 21_600_000);
    return (
      state.dirty === true ||
      state.error !== undefined ||
      state.entry?.sources?.some(sourceFailed) === true ||
      !state.entry ||
      this.#options.now() - state.entry.refreshedAt >= (this.#options.ttlMs ?? 21_600_000)
    );
  }
  #status(state: State): ModelInstanceStatus {
    return {
      provider: state.config.provider,
      permissionModes:
        state.permissionModes ??
        (state.entry?.permissionModes
          ? [...state.entry.permissionModes]
          : nativePermissionModes(state.config.provider)),
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
              sourceFailed(source)
            ? "stale"
            : "fresh",
        ...(state.errorDetail || source.error
          ? {
              error: discoveryError(state.errorDetail ?? source.error, "discovery_failed", {
                ...state.config,
                source: source.source.id,
              }),
            }
          : {}),
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
  /** Ordinary catalog changes retain usable choices while discovery replaces them. */
  markStale(input: ModelFilter = {}): void {
    if (this.#closed) throw new Error("Catalog closed");
    for (const state of this.#select(ModelFilter.parse(input))) {
      if (state.config.provider === "acp") continue;
      state.dirty = true;
      state.probeRetryAt = 0;
      state.backoff.reset();
      state.retryAt = 0;
      this.#changed(state);
    }
  }
  /** Account-change boundary: revoke choices immediately and drain obsolete writes before deletion. */
  async invalidate(input: ModelFilter = {}): Promise<void> {
    if (this.#closed) throw new Error("Catalog closed");
    const selected = this.#select(ModelFilter.parse(input));
    if (this.#invalidations.size + selected.length > 128)
      throw new Error("Invalidation capacity reached");
    const pending: Promise<void>[] = [];
    for (const state of selected) {
      if (state.config.provider === "acp") continue;
      delete state.entry;
      this.registerInstance(state.config);
      const next = this.#states.get(state.config.id);
      if (!next) continue;
      const removal = Promise.allSettled([
        state.flight,
        state.invalidating,
        state.probe?.done,
        this.#sessionTails.get(state.config.id),
      ]).then(() => this.#deletions.remove(state.config.id));
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
    return Promise.all(
      this.#select(ModelFilter.parse(input)).map((state) => this.#refreshCurrent(state)),
    );
  }
  async #refreshCurrent(state: State): Promise<ModelInstanceStatus> {
    state.probeRetryAt = 0;
    state.backoff.reset();
    state.retryAt = 0;
    let revision = this.#revision(state.config);
    let status = await this.#refresh(state);
    // An explicit refresh owns its result through same-account version/settings replacements.
    while (!this.#closed && this.#states.get(state.config.id) === state) {
      const current = this.#revision(state.config);
      if (!state.flight && current === revision) break;
      revision = current;
      status = await this.#refresh(state);
    }
    return status;
  }
  #refresh(state: State): Promise<ModelInstanceStatus> {
    if (state.config.provider === "acp" || this.#configuration(state.config).enabled === false)
      return Promise.resolve(this.#status(state));
    if (state.flight) return state.flight;
    if (this.#options.now() < state.retryAt) return Promise.resolve(this.#status(state));
    if (this.#flights.size >= 64 || this.#discoveries.size >= 64) {
      state.error = "discovery_failed";
      this.#failed(state, undefined);
      this.#changed(state);
      return Promise.resolve(this.#status(state));
    }
    const abort = new AbortController();
    const startedAt = this.#options.now();
    let diagnostic: DiscoveryDiagnostics = {};
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
            (metadata) => {
              diagnostic = { ...diagnostic, ...metadata };
              for (const entry of metadata.rejectedModels?.slice(0, 512) ?? []) {
                this.#options.onError?.(
                  state.config.provider,
                  state.config.id,
                  discoveryError(undefined, "parse_failure"),
                  undefined,
                  {
                    level: "warn",
                    durationMs: Math.max(0, this.#options.now() - startedAt),
                    ...(diagnostic.cliVersion ? { cliVersion: diagnostic.cliVersion } : {}),
                    modelIndex: entry.index,
                    reason: entry.reason.slice(0, 200),
                  },
                );
              }
            },
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
            permissionModes: state.permissionModes ?? state.entry?.permissionModes,
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
            this.#failed(state, undefined, "persistence_failed", startedAt, diagnostic);
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
          delete state.unconfiguredAt;
          const failing = new Set(
            entry.sources?.filter(sourceFailed).map((source) => source.source.id),
          );
          state.backoff.retain(failing);
          state.connectionFingerprint = entry.connectionRevision;
          for (const source of entry.sources ?? [])
            if (source.error && sourceFailed(source))
              this.#reportFailure(state, source.error, startedAt, diagnostic, source.source);
          const noModels = new Set<string>();
          for (const source of entry.sources ?? []) {
            if (source.error?.code !== "no_models" && source.error?.code !== "not_configured")
              continue;
            noModels.add(source.source.id);
            if (!state.noModelSources?.has(source.source.id))
              this.#options.onError?.(
                state.config.provider,
                state.config.id,
                source.error,
                source.source.id,
                {
                  level: "info",
                  durationMs: Math.max(0, this.#options.now() - startedAt),
                  sourceLabel: source.source.label,
                  ...(diagnostic.cliVersion ? { cliVersion: diagnostic.cliVersion } : {}),
                  ...(diagnostic.stage ? { stage: diagnostic.stage } : {}),
                },
              );
          }
          state.noModelSources = noModels;
          state.retryAt = state.backoff.retryAt();
        } catch (error) {
          if (abort.signal.aborted && !timedOut) return;
          state.error = timedOut ? "timeout" : "discovery_failed";
          this.#failed(
            state,
            timedOut ? undefined : error,
            timedOut ? "timeout" : "discovery_failed",
            startedAt,
            diagnostic,
          );
          if (state.unconfiguredAt !== undefined) await this.#deletions.remove(state.config.id);
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
