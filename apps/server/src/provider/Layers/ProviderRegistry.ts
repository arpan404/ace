/**
 * ProviderRegistryLive - Aggregates provider-specific snapshot services.
 *
 * @module ProviderRegistryLive
 */
import { freemem, totalmem } from "node:os";
import type { ProviderKind, ServerProvider, ServerSettings } from "@ace/contracts";
import { Effect, Equal, FileSystem, Layer, Path, PubSub, Ref, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { checkClaudeProviderStatus, ClaudeProviderLive } from "./ClaudeProvider";
import { checkCodexProviderStatus, CodexProviderLive } from "./CodexProvider";
import { checkCursorProviderStatus, CursorProviderLive } from "./CursorProvider";
import { checkGeminiProviderStatus, GeminiProviderLive } from "./GeminiProvider";
import {
  checkGitHubCopilotProviderStatus,
  GitHubCopilotProviderLive,
} from "./GitHubCopilotProvider";
import { checkOpenCodeProviderStatus, OpenCodeProviderLive } from "./OpenCodeProvider";
import { checkPiProviderStatus, PiProviderLive } from "./PiProvider";
import type { ClaudeProviderShape } from "../Services/ClaudeProvider";
import { ClaudeProvider } from "../Services/ClaudeProvider";
import type { CodexProviderShape } from "../Services/CodexProvider";
import { CodexProvider } from "../Services/CodexProvider";
import type { CursorProviderShape } from "../Services/CursorProvider";
import { CursorProvider } from "../Services/CursorProvider";
import type { GeminiProviderShape } from "../Services/GeminiProvider";
import { GeminiProvider } from "../Services/GeminiProvider";
import type { GitHubCopilotProviderShape } from "../Services/GitHubCopilotProvider";
import { GitHubCopilotProvider } from "../Services/GitHubCopilotProvider";
import type { OpenCodeProviderShape } from "../Services/OpenCodeProvider";
import { OpenCodeProvider } from "../Services/OpenCodeProvider";
import type { PiProviderShape } from "../Services/PiProvider";
import { PiProvider } from "../Services/PiProvider";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry";
import { readPositiveIntegerEnv } from "../../resourceLimits.ts";
import { ServerSettingsService } from "../../serverSettings";
import { withStartupTiming } from "../../startupDiagnostics";
import { resolveProviderSettings } from "@ace/shared/providerInstances";

const PROVIDER_LABEL_BY_KIND: Record<ProviderKind, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
  githubCopilot: "GitHub Copilot",
  cursor: "Cursor",
  pi: "Pi",
  gemini: "Gemini",
  opencode: "OpenCode",
};

const PROVIDER_MANUAL_REFRESH_PARALLEL_CONCURRENCY = 3;
const PROVIDER_MANUAL_REFRESH_MIN_FREE_MEMORY_BYTES = 6 * 1024 * 1024 * 1024;
const PROVIDER_MANUAL_REFRESH_MIN_FREE_MEMORY_RATIO = 0.2;
const PROVIDER_MANUAL_REFRESH_MAX_PROCESS_RSS_BYTES = 1_500 * 1024 * 1024;
const PROVIDER_REGISTRY_PUBSUB_CAPACITY = readPositiveIntegerEnv({
  envVarName: "ACE_PROVIDER_REGISTRY_PUBSUB_CAPACITY",
  fallback: 64,
  minimum: 1,
});

function resolveManualRefreshAllConcurrency(): number {
  const freeMemoryBytes = freemem();
  const totalMemoryBytes = totalmem();
  const processRssBytes = process.memoryUsage().rss;
  if (
    processRssBytes > PROVIDER_MANUAL_REFRESH_MAX_PROCESS_RSS_BYTES ||
    freeMemoryBytes < PROVIDER_MANUAL_REFRESH_MIN_FREE_MEMORY_BYTES ||
    totalMemoryBytes <= 0 ||
    freeMemoryBytes / totalMemoryBytes < PROVIDER_MANUAL_REFRESH_MIN_FREE_MEMORY_RATIO
  ) {
    return 1;
  }
  return PROVIDER_MANUAL_REFRESH_PARALLEL_CONCURRENCY;
}

export function fallbackProviderSnapshot(
  provider: ProviderKind,
  previousProvider: ServerProvider | undefined,
): ServerProvider {
  if (previousProvider) {
    return previousProvider;
  }

  return {
    provider,
    enabled: true,
    installed: false,
    version: null,
    status: "error",
    auth: { status: "unknown" },
    checkedAt: new Date().toISOString(),
    message: `Failed to load ${PROVIDER_LABEL_BY_KIND[provider]} provider status.`,
    models: [],
  };
}

function providerSnapshotKey(provider: ProviderKind, providerInstanceId?: string): string {
  return `${provider}:${providerInstanceId ?? "default"}`;
}

function tagProviderSnapshot(
  snapshot: ServerProvider,
  input: {
    readonly providerInstanceId?: string;
    readonly providerInstanceLabel?: string;
  },
): ServerProvider {
  return {
    ...snapshot,
    ...(input.providerInstanceId
      ? {
          providerInstanceId: input.providerInstanceId,
          providerInstanceLabel: input.providerInstanceLabel,
          isDefaultProviderInstance: false,
        }
      : { isDefaultProviderInstance: true }),
  };
}

function makeStaticSettingsService(settings: ServerSettings) {
  return ServerSettingsService.layerTest(settings);
}

export function loadProviderSnapshotSafely<R, E>(
  provider: ProviderKind,
  snapshot: Effect.Effect<ServerProvider, E, R>,
  previousProvider: ServerProvider | undefined,
): Effect.Effect<ServerProvider, never, R> {
  return snapshot.pipe(
    Effect.catchCause((cause) =>
      Effect.logError(
        `Failed to load ${PROVIDER_LABEL_BY_KIND[provider]} provider snapshot: ${String(cause)}`,
      ).pipe(Effect.as(fallbackProviderSnapshot(provider, previousProvider))),
    ),
  );
}

const loadProviders = (
  codexProvider: CodexProviderShape,
  claudeProvider: ClaudeProviderShape,
  gitHubCopilotProvider: GitHubCopilotProviderShape,
  cursorProvider: CursorProviderShape,
  piProvider: PiProviderShape,
  geminiProvider: GeminiProviderShape,
  openCodeProvider: OpenCodeProviderShape,
  settings: ServerSettings,
  childProcessSpawner: unknown,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  previousProviders: ReadonlyArray<ServerProvider> = [],
): Effect.Effect<ReadonlyArray<ServerProvider>> => {
  const previousProviderByKey = new Map(
    previousProviders.map((provider) => [
      providerSnapshotKey(provider.provider, provider.providerInstanceId),
      provider,
    ]),
  );

  const loadScopedSnapshot = (
    provider: ProviderKind,
    providerInstanceId: string,
    providerInstanceLabel: string,
  ): Effect.Effect<ServerProvider, never> => {
    const scopedSettings: ServerSettings = {
      ...settings,
      providers: {
        ...settings.providers,
        [provider]: resolveProviderSettings(settings, provider, providerInstanceId),
      } as ServerSettings["providers"],
    };
    const settingsLayer = makeStaticSettingsService(scopedSettings);
    const previousProvider = previousProviderByKey.get(
      providerSnapshotKey(provider, providerInstanceId),
    );

    const snapshotEffect =
      provider === "codex"
        ? checkCodexProviderStatus().pipe(
            Effect.provide(settingsLayer),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              childProcessSpawner as never,
            ),
          )
        : provider === "claudeAgent"
          ? checkClaudeProviderStatus().pipe(
              Effect.provide(settingsLayer),
              Effect.provideService(
                ChildProcessSpawner.ChildProcessSpawner,
                childProcessSpawner as never,
              ),
            )
          : provider === "githubCopilot"
            ? checkGitHubCopilotProviderStatus().pipe(Effect.provide(settingsLayer))
            : provider === "cursor"
              ? checkCursorProviderStatus().pipe(
                  Effect.provide(settingsLayer),
                  Effect.provideService(
                    ChildProcessSpawner.ChildProcessSpawner,
                    childProcessSpawner as never,
                  ),
                )
              : provider === "pi"
                ? checkPiProviderStatus().pipe(
                    Effect.provide(settingsLayer),
                    Effect.provideService(
                      ChildProcessSpawner.ChildProcessSpawner,
                      childProcessSpawner as never,
                    ),
                  )
                : provider === "gemini"
                  ? checkGeminiProviderStatus().pipe(
                      Effect.provide(settingsLayer),
                      Effect.provideService(
                        ChildProcessSpawner.ChildProcessSpawner,
                        childProcessSpawner as never,
                      ),
                    )
                  : checkOpenCodeProviderStatus().pipe(Effect.provide(settingsLayer));

    return loadProviderSnapshotSafely(provider, snapshotEffect, previousProvider).pipe(
      Effect.map((snapshot) =>
        tagProviderSnapshot(snapshot, {
          providerInstanceId,
          providerInstanceLabel,
        }),
      ),
    );
  };

  const loadProviderFamily = (
    provider: ProviderKind,
    defaultSnapshot: Effect.Effect<ServerProvider>,
  ): Effect.Effect<ReadonlyArray<ServerProvider>, never> => {
    const defaultProvider = settings.providers[provider];
    const instanceSnapshots = defaultProvider.instances.map((instance) =>
      loadScopedSnapshot(provider, instance.id, instance.label),
    );
    return Effect.all(
      [
        loadProviderSnapshotSafely(
          provider,
          defaultSnapshot,
          previousProviderByKey.get(providerSnapshotKey(provider)),
        ).pipe(Effect.map((snapshot) => tagProviderSnapshot(snapshot, {}))),
        ...instanceSnapshots,
      ],
      {
        concurrency: "unbounded",
      },
    );
  };

  return Effect.all(
    [
      loadProviderFamily("codex", codexProvider.getSnapshot),
      loadProviderFamily("claudeAgent", claudeProvider.getSnapshot),
      loadProviderFamily("githubCopilot", gitHubCopilotProvider.getSnapshot),
      loadProviderFamily("cursor", cursorProvider.getSnapshot),
      loadProviderFamily("pi", piProvider.getSnapshot),
      loadProviderFamily("gemini", geminiProvider.getSnapshot),
      loadProviderFamily("opencode", openCodeProvider.getSnapshot),
    ],
    {
      concurrency: "unbounded",
    },
  ).pipe(Effect.map((families) => families.flat()));
};

export const haveProvidersChanged = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean => !Equal.equals(previousProviders, nextProviders);

export const ProviderRegistryLive = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const [
      codexProvider,
      claudeProvider,
      gitHubCopilotProvider,
      cursorProvider,
      piProvider,
      geminiProvider,
      openCodeProvider,
      serverSettings,
      childProcessSpawner,
      fileSystem,
      path,
    ] = yield* withStartupTiming(
      "providers",
      "Initializing provider services and dependencies",
      Effect.all(
        [
          withStartupTiming(
            "providers",
            "Initializing Codex provider service",
            Effect.service(CodexProvider),
          ),
          withStartupTiming(
            "providers",
            "Initializing Claude provider service",
            Effect.service(ClaudeProvider),
          ),
          withStartupTiming(
            "providers",
            "Initializing GitHub Copilot provider service",
            Effect.service(GitHubCopilotProvider),
          ),
          withStartupTiming(
            "providers",
            "Initializing Cursor provider service",
            Effect.service(CursorProvider),
          ),
          withStartupTiming(
            "providers",
            "Initializing Pi provider service",
            Effect.service(PiProvider),
          ),
          withStartupTiming(
            "providers",
            "Initializing Gemini provider service",
            Effect.service(GeminiProvider),
          ),
          withStartupTiming(
            "providers",
            "Initializing OpenCode provider service",
            Effect.service(OpenCodeProvider),
          ),
          withStartupTiming(
            "providers",
            "Resolving server settings service",
            Effect.service(ServerSettingsService),
          ),
          withStartupTiming(
            "providers",
            "Resolving child process spawner",
            Effect.service(ChildProcessSpawner.ChildProcessSpawner),
          ),
          withStartupTiming(
            "providers",
            "Resolving file system",
            Effect.service(FileSystem.FileSystem),
          ),
          withStartupTiming("providers", "Resolving path service", Effect.service(Path.Path)),
        ] as const,
        {
          concurrency: "unbounded",
        },
      ),
      {
        endDetail: (providers) => ({
          providerServiceCount: providers.length,
        }),
      },
    );
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.sliding<ReadonlyArray<ServerProvider>>(PROVIDER_REGISTRY_PUBSUB_CAPACITY),
      PubSub.shutdown,
    );
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      yield* withStartupTiming(
        "providers",
        "Loading provider snapshots",
        loadProviders(
          codexProvider,
          claudeProvider,
          gitHubCopilotProvider,
          cursorProvider,
          piProvider,
          geminiProvider,
          openCodeProvider,
          yield* serverSettings.getSettings,
          childProcessSpawner,
          fileSystem,
          path,
        ),
        {
          endDetail: (providers) => ({
            providerCount: providers.length,
            readyCount: providers.filter((provider) => provider.status === "ready").length,
            warningCount: providers.filter((provider) => provider.status === "warning").length,
            errorCount: providers.filter((provider) => provider.status === "error").length,
            disabledCount: providers.filter((provider) => provider.status === "disabled").length,
          }),
        },
      ),
    );

    const syncProviders = Effect.fn("syncProviders")(function* (options?: {
      readonly publish?: boolean;
    }) {
      const previousProviders = yield* Ref.get(providersRef);
      const settings = yield* serverSettings.getSettings;
      const providers = yield* loadProviders(
        codexProvider,
        claudeProvider,
        gitHubCopilotProvider,
        cursorProvider,
        piProvider,
        geminiProvider,
        openCodeProvider,
        settings,
        childProcessSpawner,
        fileSystem,
        path,
        previousProviders,
      );
      yield* Ref.set(providersRef, providers);

      if (options?.publish !== false && haveProvidersChanged(previousProviders, providers)) {
        yield* PubSub.publish(changesPubSub, providers);
      }

      return providers;
    });

    yield* Stream.runForEach(serverSettings.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );

    const refresh = Effect.fn("refresh")(function* (provider?: ProviderKind) {
      switch (provider) {
        case "codex":
          yield* codexProvider.refresh;
          break;
        case "claudeAgent":
          yield* claudeProvider.refresh;
          break;
        case "githubCopilot":
          yield* gitHubCopilotProvider.refresh;
          break;
        case "cursor":
          yield* cursorProvider.refresh;
          break;
        case "pi":
          yield* piProvider.refresh;
          break;
        case "gemini":
          yield* geminiProvider.refresh;
          break;
        case "opencode":
          yield* openCodeProvider.refresh;
          break;
        default:
          {
            const concurrency = resolveManualRefreshAllConcurrency();
            yield* Effect.all(
              [
                codexProvider.refresh,
                claudeProvider.refresh,
                gitHubCopilotProvider.refresh,
                cursorProvider.refresh,
                piProvider.refresh,
                geminiProvider.refresh,
                openCodeProvider.refresh,
              ],
              {
                concurrency,
              },
            );
          }
          break;
      }
      return yield* syncProviders();
    });

    return {
      getProviders: Ref.get(providersRef),
      refresh: (provider?: ProviderKind) =>
        refresh(provider).pipe(
          Effect.tapError(Effect.logError),
          Effect.orElseSucceed(() => []),
        ),
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderRegistryShape;
  }),
).pipe(
  Layer.provideMerge(CodexProviderLive),
  Layer.provideMerge(ClaudeProviderLive),
  Layer.provideMerge(GitHubCopilotProviderLive),
  Layer.provideMerge(CursorProviderLive),
  Layer.provideMerge(PiProviderLive),
  Layer.provideMerge(GeminiProviderLive),
  Layer.provideMerge(OpenCodeProviderLive),
);
