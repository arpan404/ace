/**
 * ProviderRegistryLive - Aggregates provider-specific snapshot services.
 *
 * @module ProviderRegistryLive
 */
import type { ProviderKind, ServerProvider } from "@t3tools/contracts";
import { Effect, Equal, Layer, PubSub, Ref, Stream } from "effect";

import { ClaudeProviderLive } from "./ClaudeProvider";
import { CodexProviderLive } from "./CodexProvider";
import { CursorProviderLive } from "./CursorProvider";
import { GeminiProviderLive } from "./GeminiProvider";
import { GitHubCopilotProviderLive } from "./GitHubCopilotProvider";
import { OpenCodeProviderLive } from "./OpenCodeProvider";
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
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry";

const PROVIDER_LABEL_BY_KIND: Record<ProviderKind, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
  githubCopilot: "GitHub Copilot",
  cursor: "Cursor",
  gemini: "Gemini",
  opencode: "OpenCode",
};

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
    const codexProvider = yield* CodexProvider;
    const claudeProvider = yield* ClaudeProvider;
    const gitHubCopilotProvider = yield* GitHubCopilotProvider;
    const cursorProvider = yield* CursorProvider;
    const geminiProvider = yield* GeminiProvider;
    const openCodeProvider = yield* OpenCodeProvider;
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      yield* loadProviders(
        codexProvider,
        claudeProvider,
        gitHubCopilotProvider,
        cursorProvider,
        geminiProvider,
        openCodeProvider,
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
        case "gemini":
          yield* geminiProvider.refresh;
          break;
        case "opencode":
          yield* openCodeProvider.refresh;
          break;
        default:
          yield* Effect.all(
            [
              codexProvider.refresh,
              claudeProvider.refresh,
              gitHubCopilotProvider.refresh,
              cursorProvider.refresh,
              geminiProvider.refresh,
              openCodeProvider.refresh,
            ],
            {
              concurrency: "unbounded",
            },
          );
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
  Layer.provideMerge(GeminiProviderLive),
  Layer.provideMerge(OpenCodeProviderLive),
);
