/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  DEFAULT_PROVIDER_CLI_IDLE_TTL_SECONDS,
  DEFAULT_PROVIDER_CLI_MAX_OPEN,
  ModelSelection,
  NonNegativeInt,
  type ProviderKind,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
} from "@ace/contracts";
import {
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Queue,
  Schema,
  SchemaIssue,
  Stream,
} from "effect";

import { ProviderValidationError, type ProviderServiceError } from "../Errors.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import type { ProviderAdapterCapabilities } from "../Services/ProviderAdapter.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { withStartupTiming } from "../../startupDiagnostics.ts";
import { projectionMessagesToReplayTurns } from "../providerReplayTurns.ts";
import { resolveProviderIntegrationCapabilities } from "../providerCapabilities.ts";

export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogPath?: string;
  readonly canonicalEventLogger?: EventNdjsonLogger;
}

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

const PROVIDER_CLI_POLICY_SWEEP_INTERVAL_MS = 1_000;

type ProviderCliPoolPolicy = {
  readonly maxOpen: number;
  readonly idleTtlMs: number;
};

type SessionActivityState = {
  provider: ProviderKind;
  lastAssistantActivityAtMs: number;
  turnInProgress: boolean;
  pendingRequestCount: number;
  pendingUserInputCount: number;
};

type QueuedProviderTurn = {
  readonly input: ProviderSendTurnInput;
  readonly result: Deferred.Deferred<ProviderTurnStartResult, ProviderServiceError>;
};

function shouldReplayPersistedTranscript(provider: {
  readonly provider: ProviderKind;
  readonly capabilities?: ProviderAdapterCapabilities | null;
}): boolean {
  return (
    resolveProviderIntegrationCapabilities(provider.provider, provider.capabilities)
      .sessionResumeMode === "local-replay"
  );
}

function shouldClearResumeCursorOnRollback(provider: {
  readonly provider: ProviderKind;
  readonly capabilities?: ProviderAdapterCapabilities | null;
}): boolean {
  return (
    resolveProviderIntegrationCapabilities(provider.provider, provider.capabilities)
      .sessionResumeMode === "local-replay"
  );
}

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) =>
  Schema.decodeUnknownEffect(input.schema)(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
  };
}

function readPersistedModelSelection(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return Schema.is(ModelSelection)(raw) ? raw : undefined;
}

function readPersistedCwd(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseIsoTimestampMs(value: string): number | undefined {
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : undefined;
}

function isSessionBusy(session: ProviderSession, state: SessionActivityState | undefined): boolean {
  return (
    session.status === "running" ||
    session.status === "connecting" ||
    state?.turnInProgress === true ||
    (state?.pendingRequestCount ?? 0) > 0 ||
    (state?.pendingUserInputCount ?? 0) > 0
  );
}

function isRuntimeSessionTurnActive(session: ProviderSession): boolean {
  return (
    session.status === "running" ||
    session.status === "connecting" ||
    session.activeTurnId !== undefined
  );
}

function isTurnIdleEvent(event: ProviderRuntimeEvent): boolean {
  return (
    event.type === "turn.completed" ||
    event.type === "turn.aborted" ||
    event.type === "session.exited"
  );
}

const sleepRealMs = (ms: number) =>
  Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, ms)));

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const analytics = yield* withStartupTiming(
    "providers",
    "Resolving analytics service for provider service",
    Effect.service(AnalyticsService),
  );
  const serverSettings = yield* withStartupTiming(
    "providers",
    "Resolving server settings for provider service",
    Effect.service(ServerSettingsService),
  );
  const canonicalEventLogger =
    options?.canonicalEventLogger ??
    (options?.canonicalEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.canonicalEventLogPath, {
          stream: "canonical",
        })
      : undefined);

  const registry = yield* withStartupTiming(
    "providers",
    "Resolving provider adapter registry",
    Effect.service(ProviderAdapterRegistry),
  );
  const directory = yield* withStartupTiming(
    "providers",
    "Resolving provider session directory",
    Effect.service(ProviderSessionDirectory),
  );
  const projectionThreadMessageRepository = yield* withStartupTiming(
    "providers",
    "Resolving projection thread message repository",
    Effect.service(ProjectionThreadMessageRepository),
  );
  const runtimeEventQueue = yield* withStartupTiming(
    "providers",
    "Allocating provider runtime event queue",
    Queue.unbounded<ProviderRuntimeEvent>(),
  );
  const runtimeEventPubSub = yield* withStartupTiming(
    "providers",
    "Allocating provider runtime event pubsub",
    PubSub.unbounded<ProviderRuntimeEvent>(),
  );

  const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.succeed(event).pipe(
      Effect.tap((canonicalEvent) =>
        canonicalEventLogger ? canonicalEventLogger.write(canonicalEvent, null) : Effect.void,
      ),
      Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
      Effect.asVoid,
    );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
    },
  ) =>
    directory.upsert({
      threadId,
      provider: session.provider,
      runtimeMode: session.runtimeMode,
      status: toRuntimeStatus(session),
      resumeCursor: session.resumeCursor ?? null,
      runtimePayload: toRuntimePayloadFromSession(session, extra),
    });

  const providers = yield* withStartupTiming(
    "providers",
    "Listing provider adapters",
    registry.listProviders(),
    {
      endDetail: (providerKinds) => ({
        providerCount: providerKinds.length,
        providers: providerKinds,
      }),
    },
  );
  const adapters = yield* withStartupTiming(
    "providers",
    "Resolving provider adapters",
    Effect.forEach(providers, (provider) => registry.getByProvider(provider)),
    {
      endDetail: (resolvedAdapters) => ({
        adapterCount: resolvedAdapters.length,
      }),
    },
  );
  const sessionActivityByThreadId = new Map<ThreadId, SessionActivityState>();
  const turnQueueByThreadId = new Map<ThreadId, Queue.Queue<QueuedProviderTurn>>();
  const activeTurnIdleByThreadId = new Map<ThreadId, Deferred.Deferred<void>>();

  const listActiveSessions = Effect.forEach(adapters, (adapter) => adapter.listSessions()).pipe(
    Effect.map((sessionsByProvider) => sessionsByProvider.flatMap((sessions) => sessions)),
  );

  const resolveCliPoolPolicyForOperation = Effect.fn("resolveCliPoolPolicyForOperation")(function* (
    operation: string,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError((error) =>
        toValidationError(operation, `Failed to load provider settings: ${error.message}`, error),
      ),
    );
    return {
      maxOpen: settings.providerCliMaxOpen,
      idleTtlMs: settings.providerCliIdleTtlSeconds * 1_000,
    } satisfies ProviderCliPoolPolicy;
  });

  const resolveCliPoolPolicyForBackground = serverSettings.getSettings.pipe(
    Effect.map((settings) => ({
      maxOpen: settings.providerCliMaxOpen,
      idleTtlMs: settings.providerCliIdleTtlSeconds * 1_000,
    })),
    Effect.catch((error) =>
      Effect.logWarning("failed to read provider CLI pool settings; using defaults", {
        error: error.message,
        maxOpen: DEFAULT_PROVIDER_CLI_MAX_OPEN,
        idleTtlSeconds: DEFAULT_PROVIDER_CLI_IDLE_TTL_SECONDS,
      }).pipe(
        Effect.as({
          maxOpen: DEFAULT_PROVIDER_CLI_MAX_OPEN,
          idleTtlMs: DEFAULT_PROVIDER_CLI_IDLE_TTL_SECONDS * 1_000,
        } satisfies ProviderCliPoolPolicy),
      ),
    ),
  );

  const ensureSessionActivity = (
    threadId: ThreadId,
    provider: ProviderKind,
    seedAtMs: number,
  ): SessionActivityState => {
    const existing = sessionActivityByThreadId.get(threadId);
    if (existing) {
      if (existing.provider !== provider) {
        existing.provider = provider;
      }
      return existing;
    }
    const created: SessionActivityState = {
      provider,
      lastAssistantActivityAtMs: seedAtMs,
      turnInProgress: false,
      pendingRequestCount: 0,
      pendingUserInputCount: 0,
    };
    sessionActivityByThreadId.set(threadId, created);
    return created;
  };

  const markSessionObserved = (session: ProviderSession, observedAtMs: number): void => {
    const state = ensureSessionActivity(session.threadId, session.provider, observedAtMs);
    if (
      session.status === "running" ||
      session.status === "connecting" ||
      session.activeTurnId !== undefined
    ) {
      state.turnInProgress = true;
    }
  };

  const markTurnStarted = (threadId: ThreadId, provider: ProviderKind): void => {
    const state = ensureSessionActivity(threadId, provider, Date.now());
    state.turnInProgress = true;
  };

  const sessionIdleReferenceMs = (
    session: ProviderSession,
    state: SessionActivityState | undefined,
    fallbackNowMs: number,
  ): number =>
    state?.lastAssistantActivityAtMs ??
    parseIsoTimestampMs(session.updatedAt) ??
    parseIsoTimestampMs(session.createdAt) ??
    fallbackNowMs;

  const recordRuntimeEventActivity = (event: ProviderRuntimeEvent): void => {
    const eventAtMs = parseIsoTimestampMs(event.createdAt) ?? Date.now();
    const state = ensureSessionActivity(event.threadId, event.provider, eventAtMs);

    switch (event.type) {
      case "turn.started":
        state.turnInProgress = true;
        return;
      case "turn.completed":
      case "turn.aborted":
        state.turnInProgress = false;
        state.lastAssistantActivityAtMs = Math.max(state.lastAssistantActivityAtMs, eventAtMs);
        return;
      case "item.completed":
        if (event.payload.itemType === "assistant_message") {
          state.lastAssistantActivityAtMs = Math.max(state.lastAssistantActivityAtMs, eventAtMs);
        }
        return;
      case "request.opened":
        state.pendingRequestCount += 1;
        return;
      case "request.resolved":
        state.pendingRequestCount = Math.max(0, state.pendingRequestCount - 1);
        return;
      case "user-input.requested":
        state.pendingUserInputCount += 1;
        return;
      case "user-input.resolved":
        state.pendingUserInputCount = Math.max(0, state.pendingUserInputCount - 1);
        return;
      case "session.exited":
        state.turnInProgress = false;
        state.pendingRequestCount = 0;
        state.pendingUserInputCount = 0;
        return;
      default:
        return;
    }
  };

  const stopSessionPreservingBinding = Effect.fn("stopSessionPreservingBinding")(function* (input: {
    readonly session: ProviderSession;
    readonly reason: string;
  }) {
    const adapter = yield* registry.getByProvider(input.session.provider);
    const hasSession = yield* adapter
      .hasSession(input.session.threadId)
      .pipe(Effect.orElseSucceed(() => false));
    if (hasSession) {
      yield* adapter.stopSession(input.session.threadId);
    }
    const stoppedAt = new Date().toISOString();
    yield* directory.upsert({
      threadId: input.session.threadId,
      provider: input.session.provider,
      runtimeMode: input.session.runtimeMode,
      status: "stopped",
      runtimePayload: {
        activeTurnId: null,
        lastRuntimeEvent: input.reason,
        lastRuntimeEventAt: stoppedAt,
      },
    });
    const state = sessionActivityByThreadId.get(input.session.threadId);
    if (state) {
      state.turnInProgress = false;
      state.pendingRequestCount = 0;
      state.pendingUserInputCount = 0;
    }
    yield* analytics.record("provider.session.policy_stopped", {
      provider: input.session.provider,
      reason: input.reason,
    });
  });

  const evictIdleSessionsToLimit = Effect.fn("evictIdleSessionsToLimit")(function* (input: {
    readonly sessions: ReadonlyArray<ProviderSession>;
    readonly maxOpen: number;
    readonly reason: string;
    readonly excludeThreadId?: ThreadId;
  }) {
    if (input.sessions.length <= input.maxOpen) {
      return;
    }
    const nowMs = Date.now();
    const idleCandidates = input.sessions
      .filter((session) => {
        if (input.excludeThreadId && session.threadId === input.excludeThreadId) {
          return false;
        }
        const state = sessionActivityByThreadId.get(session.threadId);
        return !isSessionBusy(session, state);
      })
      .map((session) => ({
        session,
        lastAssistantActivityAtMs: sessionIdleReferenceMs(
          session,
          sessionActivityByThreadId.get(session.threadId),
          nowMs,
        ),
      }))
      .toSorted((left, right) => left.lastAssistantActivityAtMs - right.lastAssistantActivityAtMs);

    let remaining = input.sessions.length;
    for (const candidate of idleCandidates) {
      if (remaining <= input.maxOpen) {
        break;
      }
      yield* stopSessionPreservingBinding({
        session: candidate.session,
        reason: input.reason,
      });
      remaining -= 1;
    }
  });

  const enforceCliPoolPolicy = Effect.fn("enforceCliPoolPolicy")(function* () {
    const policy = yield* resolveCliPoolPolicyForBackground;
    let sessions = yield* listActiveSessions;
    const activeThreadIds = new Set(sessions.map((session) => session.threadId));
    for (const threadId of sessionActivityByThreadId.keys()) {
      if (!activeThreadIds.has(threadId)) {
        sessionActivityByThreadId.delete(threadId);
      }
    }
    const nowMs = Date.now();
    for (const session of sessions) {
      markSessionObserved(session, nowMs);
      const state = sessionActivityByThreadId.get(session.threadId);
      if (isSessionBusy(session, state)) {
        continue;
      }
      const idleForMs = nowMs - sessionIdleReferenceMs(session, state, nowMs);
      if (idleForMs < policy.idleTtlMs) {
        continue;
      }
      yield* stopSessionPreservingBinding({
        session,
        reason: "provider.idle_ttl_expired",
      });
    }
    sessions = yield* listActiveSessions;
    yield* evictIdleSessionsToLimit({
      sessions,
      maxOpen: policy.maxOpen,
      reason: "provider.max_open_enforced",
    });
  });

  const enforceCliPoolPolicySafely = enforceCliPoolPolicy().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("provider CLI lifecycle policy sweep failed", {
        cause,
      }),
    ),
  );

  const prepareForNewSession = Effect.fn("prepareForNewSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
  }) {
    const policy = yield* resolveCliPoolPolicyForOperation(input.operation);
    const sessions = yield* listActiveSessions;
    for (const session of sessions) {
      markSessionObserved(session, Date.now());
    }
    if (sessions.some((session) => session.threadId === input.threadId)) {
      return;
    }
    yield* evictIdleSessionsToLimit({
      sessions,
      maxOpen: Math.max(0, policy.maxOpen - 1),
      reason: "provider.max_open_prestart",
      excludeThreadId: input.threadId,
    });
  });

  const completeActiveTurn = (threadId: ThreadId): Effect.Effect<void> =>
    Effect.gen(function* () {
      const idle = activeTurnIdleByThreadId.get(threadId);
      if (!idle) {
        return;
      }
      activeTurnIdleByThreadId.delete(threadId);
      yield* Deferred.succeed(idle, undefined).pipe(Effect.orDie);
    });

  const processRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.sync(() => {
      recordRuntimeEventActivity(event);
    }).pipe(
      Effect.flatMap(() =>
        isTurnIdleEvent(event) ? completeActiveTurn(event.threadId) : Effect.void,
      ),
      Effect.flatMap(() => publishRuntimeEvent(event)),
    );

  const worker = Effect.forever(
    Queue.take(runtimeEventQueue).pipe(Effect.flatMap(processRuntimeEvent)),
  );
  yield* withStartupTiming(
    "providers",
    "Starting provider runtime event worker",
    Effect.forkScoped(worker),
  );

  yield* withStartupTiming(
    "providers",
    "Subscribing provider adapter event streams",
    Effect.forEach(adapters, (adapter) =>
      Stream.runForEach(adapter.streamEvents, (event) =>
        Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid),
      ).pipe(Effect.forkScoped),
    ).pipe(Effect.asVoid),
  );

  yield* withStartupTiming(
    "providers",
    "Starting provider CLI policy sweep",
    Effect.forkScoped(
      enforceCliPoolPolicySafely.pipe(
        Effect.flatMap(() =>
          Effect.forever(
            sleepRealMs(PROVIDER_CLI_POLICY_SWEEP_INTERVAL_MS).pipe(
              Effect.flatMap(() => enforceCliPoolPolicySafely),
            ),
          ),
        ),
      ),
    ),
  );

  const recoverSessionForThread = Effect.fn("recoverSessionForThread")(function* (input: {
    readonly binding: ProviderRuntimeBinding;
    readonly operation: string;
  }) {
    const adapter = yield* registry.getByProvider(input.binding.provider);
    const resumeCursor =
      input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined
        ? input.binding.resumeCursor
        : undefined;
    const shouldReplayTranscript = shouldReplayPersistedTranscript(adapter);
    const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
    if (hasActiveSession) {
      const activeSessions = yield* adapter.listSessions();
      const existing = activeSessions.find(
        (session) => session.threadId === input.binding.threadId,
      );
      if (existing) {
        markSessionObserved(existing, Date.now());
        yield* upsertSessionBinding(existing, input.binding.threadId);
        yield* analytics.record("provider.session.recovered", {
          provider: existing.provider,
          strategy: "adopt-existing",
          hasResumeCursor: existing.resumeCursor !== undefined,
        });
        return { adapter, session: existing } as const;
      }
    }

    if (resumeCursor === undefined && !shouldReplayTranscript) {
      return yield* toValidationError(
        input.operation,
        `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
      );
    }

    const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
    const persistedModelSelection = readPersistedModelSelection(input.binding.runtimePayload);
    const replayTurns = shouldReplayTranscript
      ? projectionMessagesToReplayTurns(
          yield* projectionThreadMessageRepository.listByThreadId({
            threadId: input.binding.threadId,
          }),
        )
      : [];

    yield* prepareForNewSession({
      threadId: input.binding.threadId,
      operation: input.operation,
    });
    const resumed = yield* adapter.startSession({
      threadId: input.binding.threadId,
      provider: input.binding.provider,
      ...(persistedCwd ? { cwd: persistedCwd } : {}),
      ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
      ...(resumeCursor !== undefined ? { resumeCursor } : {}),
      ...(replayTurns.length > 0 ? { replayTurns } : {}),
      runtimeMode: input.binding.runtimeMode ?? "full-access",
    });
    if (resumed.provider !== adapter.provider) {
      return yield* toValidationError(
        input.operation,
        `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
      );
    }

    markSessionObserved(resumed, Date.now());
    yield* upsertSessionBinding(resumed, input.binding.threadId);
    yield* analytics.record("provider.session.recovered", {
      provider: resumed.provider,
      strategy:
        resumeCursor !== undefined && replayTurns.length > 0
          ? "resume-thread-with-local-fallback"
          : resumeCursor !== undefined
            ? "resume-thread"
            : shouldReplayTranscript
              ? "rebuild-local-transcript"
              : "resume-thread",
      hasResumeCursor: resumed.resumeCursor !== undefined,
    });
    return { adapter, session: resumed } as const;
  });

  const resolveRoutableSession = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
  }) {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    const adapter = yield* registry.getByProvider(binding.provider);

    const hasRequestedSession = yield* adapter.hasSession(input.threadId);
    if (hasRequestedSession) {
      return { adapter, threadId: input.threadId, isActive: true } as const;
    }

    if (!input.allowRecovery) {
      return { adapter, threadId: input.threadId, isActive: false } as const;
    }

    const recovered = yield* recoverSessionForThread({ binding, operation: input.operation });
    return { adapter: recovered.adapter, threadId: input.threadId, isActive: true } as const;
  });

  const startSession: ProviderServiceShape["startSession"] = Effect.fn("startSession")(
    function* (threadId, rawInput) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });

      const input = {
        ...parsed,
        threadId,
        provider: parsed.provider ?? parsed.modelSelection?.provider ?? "codex",
      };
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError((error) =>
          toValidationError(
            "ProviderService.startSession",
            `Failed to load provider settings: ${error.message}`,
            error,
          ),
        ),
      );
      if (!settings.providers[input.provider].enabled) {
        return yield* toValidationError(
          "ProviderService.startSession",
          `Provider '${input.provider}' is disabled in ace settings.`,
        );
      }
      const adapter = yield* registry.getByProvider(input.provider);
      const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const shouldReplayTranscript = shouldReplayPersistedTranscript(adapter);
      const explicitReplayTurns = input.replayTurns;
      const shouldIncludePersistedTranscript =
        explicitReplayTurns === undefined &&
        shouldReplayTranscript &&
        persistedBinding?.provider === input.provider;
      const persistedResumeCursor =
        persistedBinding?.provider === input.provider &&
        persistedBinding.resumeCursor !== null &&
        persistedBinding.resumeCursor !== undefined
          ? persistedBinding.resumeCursor
          : undefined;
      const effectiveResumeCursor = input.resumeCursor ?? persistedResumeCursor;
      const replayTurns =
        explicitReplayTurns ??
        (shouldIncludePersistedTranscript
          ? projectionMessagesToReplayTurns(
              yield* projectionThreadMessageRepository.listByThreadId({
                threadId,
              }),
            )
          : []);
      yield* prepareForNewSession({
        threadId,
        operation: "ProviderService.startSession",
      });
      const session = yield* adapter.startSession({
        ...input,
        ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
        ...(explicitReplayTurns !== undefined || replayTurns.length > 0 ? { replayTurns } : {}),
      });

      if (session.provider !== adapter.provider) {
        return yield* toValidationError(
          "ProviderService.startSession",
          `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
        );
      }

      markSessionObserved(session, Date.now());
      yield* upsertSessionBinding(session, threadId, {
        modelSelection: input.modelSelection,
      });
      yield* analytics.record("provider.session.started", {
        provider: session.provider,
        runtimeMode: input.runtimeMode,
        hasResumeCursor: session.resumeCursor !== undefined,
        hasCwd: typeof input.cwd === "string" && input.cwd.trim().length > 0,
        hasModel:
          typeof input.modelSelection?.model === "string" &&
          input.modelSelection.model.trim().length > 0,
      });

      return session;
    },
  );

  const sendTurnDirect = Effect.fn("sendTurnDirect")(function* (input: ProviderSendTurnInput) {
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.sendTurn",
      allowRecovery: true,
    });
    const turn = yield* routed.adapter.sendTurn(input);
    markTurnStarted(input.threadId, routed.adapter.provider);
    yield* directory.upsert({
      threadId: input.threadId,
      provider: routed.adapter.provider,
      status: "running",
      ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
      runtimePayload: {
        ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
        activeTurnId: turn.turnId,
        lastRuntimeEvent: "provider.sendTurn",
        lastRuntimeEventAt: new Date().toISOString(),
      },
    });
    yield* analytics.record("provider.turn.sent", {
      provider: routed.adapter.provider,
      model: input.modelSelection?.model,
      interactionMode: input.interactionMode,
      attachmentCount: input.attachments?.length ?? 0,
      hasInput: typeof input.input === "string" && input.input.trim().length > 0,
    });
    return { provider: routed.adapter.provider, turn } as const;
  });

  const waitForTurnIdle = Effect.fn("waitForTurnIdle")(function* (input: {
    readonly threadId: ThreadId;
    readonly provider: ProviderKind;
    readonly idle: Deferred.Deferred<void>;
  }) {
    while (true) {
      if (yield* Deferred.isDone(input.idle)) {
        return;
      }

      yield* sleepRealMs(250);
      if (yield* Deferred.isDone(input.idle)) {
        return;
      }

      const adapter = yield* registry.getByProvider(input.provider);
      const sessions = yield* adapter.listSessions().pipe(Effect.orElseSucceed(() => []));
      const session = sessions.find((candidate) => candidate.threadId === input.threadId);
      if (!session || !isRuntimeSessionTurnActive(session)) {
        yield* completeActiveTurn(input.threadId);
        return;
      }
    }
  });

  const processQueuedTurn = Effect.fn("processQueuedTurn")(function* (
    queuedTurn: QueuedProviderTurn,
  ) {
    const idle = yield* Deferred.make<void>();
    activeTurnIdleByThreadId.set(queuedTurn.input.threadId, idle);

    const exit = yield* sendTurnDirect(queuedTurn.input).pipe(Effect.exit);
    if (Exit.isFailure(exit)) {
      if (activeTurnIdleByThreadId.get(queuedTurn.input.threadId) === idle) {
        activeTurnIdleByThreadId.delete(queuedTurn.input.threadId);
      }
      yield* Deferred.failCause(queuedTurn.result, exit.cause).pipe(Effect.orDie);
      return;
    }

    yield* Deferred.succeed(queuedTurn.result, exit.value.turn).pipe(Effect.orDie);
    yield* waitForTurnIdle({
      threadId: queuedTurn.input.threadId,
      provider: exit.value.provider,
      idle,
    });
  });

  const getTurnQueue = Effect.fn("getTurnQueue")(function* (threadId: ThreadId) {
    const existing = turnQueueByThreadId.get(threadId);
    if (existing) {
      return existing;
    }

    const queue = yield* Queue.unbounded<QueuedProviderTurn>();
    turnQueueByThreadId.set(threadId, queue);
    yield* Queue.take(queue).pipe(
      Effect.flatMap(processQueuedTurn),
      Effect.forever,
      Effect.forkDetach,
    );
    return queue;
  });

  const sendTurn: ProviderServiceShape["sendTurn"] = Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const input = {
      ...parsed,
      attachments: parsed.attachments ?? [],
    };
    if (!input.input && input.attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }

    const result = yield* Deferred.make<ProviderTurnStartResult, ProviderServiceError>();
    const queue = yield* getTurnQueue(input.threadId);
    yield* Queue.offer(queue, { input, result }).pipe(Effect.asVoid);
    return yield* Deferred.await(result);
  });

  const interruptTurn: ProviderServiceShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.interruptTurn",
        allowRecovery: true,
      });
      yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
      const state = sessionActivityByThreadId.get(input.threadId);
      if (state) {
        state.turnInProgress = false;
      }
      yield* completeActiveTurn(input.threadId);
      yield* analytics.record("provider.turn.interrupted", {
        provider: routed.adapter.provider,
      });
    },
  );

  const respondToRequest: ProviderServiceShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToRequest",
        allowRecovery: true,
      });
      yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
      yield* analytics.record("provider.request.responded", {
        provider: routed.adapter.provider,
        decision: input.decision,
      });
    },
  );

  const respondToUserInput: ProviderServiceShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.respondToUserInput",
      allowRecovery: true,
    });
    yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
  });

  const stopSession: ProviderServiceShape["stopSession"] = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.stopSession",
        allowRecovery: false,
      });
      if (routed.isActive) {
        yield* routed.adapter.stopSession(routed.threadId);
      }
      yield* directory.remove(input.threadId);
      sessionActivityByThreadId.delete(input.threadId);
      yield* completeActiveTurn(input.threadId);
      yield* analytics.record("provider.session.stopped", {
        provider: routed.adapter.provider,
      });
    },
  );

  const listSessions: ProviderServiceShape["listSessions"] = Effect.fn("listSessions")(
    function* () {
      const sessionsByProvider = yield* Effect.forEach(adapters, (adapter) =>
        adapter.listSessions(),
      );
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
      for (const session of activeSessions) {
        markSessionObserved(session, Date.now());
      }
      const persistedBindings = yield* directory.listThreadIds().pipe(
        Effect.flatMap((threadIds) =>
          Effect.forEach(
            threadIds,
            (threadId) =>
              directory
                .getBinding(threadId)
                .pipe(Effect.orElseSucceed(() => Option.none<ProviderRuntimeBinding>())),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.orElseSucceed(() => [] as Array<Option.Option<ProviderRuntimeBinding>>),
      );
      const bindingsByThreadId = new Map<ThreadId, ProviderRuntimeBinding>();
      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);
        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      return activeSessions.map((session) => {
        const binding = bindingsByThreadId.get(session.threadId);
        if (!binding) {
          return session;
        }

        const overrides: {
          resumeCursor?: ProviderSession["resumeCursor"];
          runtimeMode?: ProviderSession["runtimeMode"];
        } = {};
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        return Object.assign({}, session, overrides);
      });
    },
  );

  const getCapabilities: ProviderServiceShape["getCapabilities"] = (provider) =>
    registry.getByProvider(provider).pipe(Effect.map((adapter) => adapter.capabilities));

  const rollbackConversation: ProviderServiceShape["rollbackConversation"] = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return;
    }
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.rollbackConversation",
      allowRecovery: true,
    });
    yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
    const refreshedSession = yield* routed.adapter
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === routed.threadId)),
      );
    if (refreshedSession) {
      markSessionObserved(refreshedSession, Date.now());
      const shouldClearResumeCursor = shouldClearResumeCursorOnRollback(routed.adapter);
      yield* upsertSessionBinding(refreshedSession, routed.threadId, {
        lastRuntimeEvent: "provider.rollbackConversation",
        lastRuntimeEventAt: new Date().toISOString(),
      });
      if (shouldClearResumeCursor) {
        yield* directory.upsert({
          threadId: routed.threadId,
          provider: refreshedSession.provider,
          resumeCursor: null,
        });
      }
    }
    yield* analytics.record("provider.conversation.rolled_back", {
      provider: routed.adapter.provider,
      turns: input.numTurns,
    });
  });

  const runStopAll = Effect.fn("runStopAll")(function* () {
    const threadIds = yield* directory.listThreadIds();
    const activeSessions = yield* Effect.forEach(adapters, (adapter) =>
      adapter.listSessions(),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));
    yield* Effect.forEach(activeSessions, (session) =>
      upsertSessionBinding(session, session.threadId, {
        lastRuntimeEvent: "provider.stopAll",
        lastRuntimeEventAt: new Date().toISOString(),
      }),
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(adapters, (adapter) => adapter.stopAll()).pipe(Effect.asVoid);
    yield* Effect.forEach(threadIds, (threadId) =>
      directory.getProvider(threadId).pipe(
        Effect.flatMap((provider) =>
          directory.upsert({
            threadId,
            provider,
            status: "stopped",
            runtimePayload: {
              activeTurnId: null,
              lastRuntimeEvent: "provider.stopAll",
              lastRuntimeEventAt: new Date().toISOString(),
            },
          }),
        ),
      ),
    ).pipe(Effect.asVoid);
    sessionActivityByThreadId.clear();
    yield* analytics.record("provider.sessions.stopped_all", {
      sessionCount: threadIds.length,
    });
    yield* analytics.flush;
  });

  yield* Effect.addFinalizer(() =>
    Effect.catch(runStopAll(), (cause) =>
      Effect.logWarning("failed to stop provider service", { cause }),
    ),
  );

  return {
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    getCapabilities,
    rollbackConversation,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    get streamEvents(): ProviderServiceShape["streamEvents"] {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderServiceShape;
});

export const ProviderServiceLive = Layer.effect(ProviderService, makeProviderService());

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService, makeProviderService(options));
}
