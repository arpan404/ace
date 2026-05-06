/**
 * ProviderRegistryLive - Aggregates provider-specific snapshot services.
 *
 * @module ProviderRegistryLive
 */
import { freemem, totalmem } from "node:os";
import type { ProviderKind, ServerProvider } from "@ace/contracts";
import { Effect, Equal, Layer, PubSub, Ref, Stream } from "effect";

import { ClaudeProviderLive } from "./ClaudeProvider";
import { CodexProviderLive } from "./CodexProvider";
import { CursorProviderLive } from "./CursorProvider";
import { GeminiProviderLive } from "./GeminiProvider";
import { GitHubCopilotProviderLive } from "./GitHubCopilotProvider";
import { OpenCodeProviderLive } from "./OpenCodeProvider";
import { PiProviderLive } from "./PiProvider";
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
import { withStartupTiming } from "../../startupDiagnostics";

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
  previousProviders: ReadonlyArray<ServerProvider> = [],
): Effect.Effect<ReadonlyArray<ServerProvider>> => {
  const previousProviderByKind = new Map(
    previousProviders.map((provider) => [provider.provider, provider]),
  );

  return Effect.all(
    [
      loadProviderSnapshotSafely(
        "codex",
        codexProvider.getSnapshot,
        previousProviderByKind.get("codex"),
      ),
      loadProviderSnapshotSafely(
        "claudeAgent",
        claudeProvider.getSnapshot,
        previousProviderByKind.get("claudeAgent"),
      ),
      loadProviderSnapshotSafely(
        "githubCopilot",
        gitHubCopilotProvider.getSnapshot,
        previousProviderByKind.get("githubCopilot"),
      ),
      loadProviderSnapshotSafely(
        "cursor",
        cursorProvider.getSnapshot,
        previousProviderByKind.get("cursor"),
      ),
      loadProviderSnapshotSafely("pi", piProvider.getSnapshot, previousProviderByKind.get("pi")),
      loadProviderSnapshotSafely(
        "gemini",
        geminiProvider.getSnapshot,
        previousProviderByKind.get("gemini"),
      ),
      loadProviderSnapshotSafely(
        "opencode",
        openCodeProvider.getSnapshot,
        previousProviderByKind.get("opencode"),
      ),
    ],
    {
      concurrency: "unbounded",
    },
  );
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
    ] = yield* withStartupTiming(
      "providers",
      "Initializing provider services",
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
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
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
      const providers = yield* loadProviders(
        codexProvider,
        claudeProvider,
        gitHubCopilotProvider,
        cursorProvider,
        piProvider,
        geminiProvider,
        openCodeProvider,
        previousProviders,
      );
      yield* Ref.set(providersRef, providers);

      if (options?.publish !== false && haveProvidersChanged(previousProviders, providers)) {
        yield* PubSub.publish(changesPubSub, providers);
      }

      return providers;
    });

    yield* Stream.runForEach(codexProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(claudeProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(gitHubCopilotProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(cursorProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(piProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(geminiProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(openCodeProvider.streamChanges, () => syncProviders()).pipe(
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
      getProviders: syncProviders({ publish: false }).pipe(
        Effect.tapError(Effect.logError),
        Effect.orElseSucceed(() => []),
      ),
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
