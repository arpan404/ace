import { ServerProvider as ServerProviderSchema, type ServerProvider } from "@ace/contracts";
import { Effect, FileSystem, Option, PubSub, Ref, Schema, Scope, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config";
import type { ServerProviderShape } from "./Services/ServerProvider";
import { ServerSettingsError } from "@ace/contracts";
import { withStartupTiming } from "../startupDiagnostics";

const PROVIDER_PROBE_CACHE_TTL_MS = 15 * 60 * 1000;

function settingsHash(settings: unknown): string {
  return JSON.stringify(settings);
}

function providerProbeCachePath(stateDir: string, provider: ServerProvider["provider"]): string {
  return `${stateDir}/provider-probes/${provider}.json`;
}

function isFreshCache(cachedAt: string): boolean {
  const cachedAtMs = Date.parse(cachedAt);
  return Number.isFinite(cachedAtMs) && Date.now() - cachedAtMs <= PROVIDER_PROBE_CACHE_TTL_MS;
}

function parseCachedSnapshot(raw: string): Option.Option<{
  readonly settingsHash: string;
  readonly cachedAt: string;
  readonly snapshot: ServerProvider;
}> {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return Option.none();
    }

    const settingsHashValue = "settingsHash" in parsed ? parsed.settingsHash : undefined;
    const cachedAtValue = "cachedAt" in parsed ? parsed.cachedAt : undefined;
    const snapshotValue = "snapshot" in parsed ? parsed.snapshot : undefined;
    if (typeof settingsHashValue !== "string" || typeof cachedAtValue !== "string") {
      return Option.none();
    }

    const snapshot = Schema.decodeUnknownOption(ServerProviderSchema)(snapshotValue);
    if (Option.isNone(snapshot)) {
      return Option.none();
    }

    return Option.some({
      settingsHash: settingsHashValue,
      cachedAt: cachedAtValue,
      snapshot: snapshot.value,
    });
  } catch {
    return Option.none();
  }
}

export const makeManagedServerProvider = Effect.fn("makeManagedServerProvider")(function* <
  Settings,
>(input: {
  readonly label?: string;
  readonly cacheKey?: ServerProvider["provider"];
  readonly getSettings: Effect.Effect<Settings>;
  readonly initialSnapshot: (settings: Settings) => ServerProvider;
  readonly streamSettings: Stream.Stream<Settings>;
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean;
  readonly checkProvider: Effect.Effect<ServerProvider, ServerSettingsError>;
}): Effect.fn.Return<ServerProviderShape, ServerSettingsError, Scope.Scope> {
  const providerLabel = input.label ?? "Provider";
  const readCachedSnapshot = (settings: Settings) =>
    Effect.gen(function* () {
      if (!input.cacheKey) {
        return Option.none<ServerProvider>();
      }

      const serverConfigOption = yield* Effect.serviceOption(ServerConfig);
      const fsOption = yield* Effect.serviceOption(FileSystem.FileSystem);
      if (Option.isNone(serverConfigOption) || Option.isNone(fsOption)) {
        return Option.none<ServerProvider>();
      }

      const fs = fsOption.value;
      const cachePath = providerProbeCachePath(serverConfigOption.value.stateDir, input.cacheKey);
      const raw = yield* fs.readFileString(cachePath).pipe(Effect.option);
      if (Option.isNone(raw)) {
        return Option.none<ServerProvider>();
      }

      const decoded = parseCachedSnapshot(raw.value);
      if (Option.isNone(decoded)) {
        return Option.none<ServerProvider>();
      }

      if (
        decoded.value.settingsHash !== settingsHash(settings) ||
        !isFreshCache(decoded.value.cachedAt)
      ) {
        return Option.none<ServerProvider>();
      }

      return Option.some(decoded.value.snapshot);
    }).pipe(Effect.orElseSucceed(() => Option.none()));

  const writeCachedSnapshot = (settings: Settings, snapshot: ServerProvider) =>
    Effect.gen(function* () {
      if (!input.cacheKey) {
        return;
      }

      const serverConfigOption = yield* Effect.serviceOption(ServerConfig);
      const fsOption = yield* Effect.serviceOption(FileSystem.FileSystem);
      if (Option.isNone(serverConfigOption) || Option.isNone(fsOption)) {
        return;
      }

      const fs = fsOption.value;
      const cacheDir = `${serverConfigOption.value.stateDir}/provider-probes`;
      const cachePath = providerProbeCachePath(serverConfigOption.value.stateDir, input.cacheKey);
      yield* fs.makeDirectory(cacheDir, { recursive: true });
      yield* fs.writeFileString(
        cachePath,
        `${JSON.stringify(
          {
            settingsHash: settingsHash(settings),
            cachedAt: new Date().toISOString(),
            snapshot,
          },
          null,
          2,
        )}\n`,
      );
    }).pipe(Effect.ignore);

  const refreshSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  );
  const initialSettings = yield* withStartupTiming(
    "providers",
    `Loading ${providerLabel} provider settings`,
    input.getSettings,
  );
  const cachedInitialSnapshot = yield* readCachedSnapshot(initialSettings);
  const initialSnapshot = Option.getOrElse(cachedInitialSnapshot, () =>
    input.initialSnapshot(initialSettings),
  );
  const snapshotRef = yield* Ref.make(initialSnapshot);
  const settingsRef = yield* Ref.make(initialSettings);
  const hasVerifiedSnapshotRef = yield* Ref.make(Option.isSome(cachedInitialSnapshot));

  const runHealthCheck = withStartupTiming(
    "providers",
    `Running ${providerLabel} provider health check`,
    input.checkProvider,
    {
      endDetail: (snapshot) => ({
        provider: snapshot.provider,
        status: snapshot.status,
        authStatus: snapshot.auth.status,
      }),
    },
  );

  const applySnapshotBase = Effect.fn("applySnapshot")(function* (
    nextSettings: Settings,
    options?: { readonly forceRefresh?: boolean },
  ) {
    const forceRefresh = options?.forceRefresh === true;
    const previousSettings = yield* Ref.get(settingsRef);
    const hasVerifiedSnapshot = yield* Ref.get(hasVerifiedSnapshotRef);
    if (
      !forceRefresh &&
      hasVerifiedSnapshot &&
      !input.haveSettingsChanged(previousSettings, nextSettings)
    ) {
      yield* Ref.set(settingsRef, nextSettings);
      return yield* Ref.get(snapshotRef);
    }

    const nextSnapshot = yield* runHealthCheck;
    yield* Ref.set(settingsRef, nextSettings);
    yield* Ref.set(snapshotRef, nextSnapshot);
    yield* Ref.set(hasVerifiedSnapshotRef, true);
    yield* PubSub.publish(changesPubSub, nextSnapshot);
    yield* writeCachedSnapshot(nextSettings, nextSnapshot);
    return nextSnapshot;
  });
  const applySnapshot = (nextSettings: Settings, options?: { readonly forceRefresh?: boolean }) =>
    refreshSemaphore.withPermits(1)(applySnapshotBase(nextSettings, options));

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* () {
    const nextSettings = yield* input.getSettings;
    return yield* applySnapshot(nextSettings, { forceRefresh: true });
  });

  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.asVoid(applySnapshot(nextSettings)),
  ).pipe(Effect.forkScoped);

  return {
    getSnapshot: input.getSettings.pipe(
      Effect.flatMap(applySnapshot),
      Effect.tapError(Effect.logError),
      Effect.orDie,
    ),
    refresh: refreshSnapshot().pipe(Effect.tapError(Effect.logError), Effect.orDie),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ServerProviderShape;
});
