import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OrchestrationReadModel, ProviderRuntimeEvent, ProviderSession } from "@ace/contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderItemId,
  type ServerSettings,
  ThreadId,
  TurnId,
} from "@ace/contracts";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { defaultProviderIntegrationCapabilities } from "@ace/shared/providerIntegrationCapabilities";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

function makeTestServerSettingsLayer(overrides: Partial<ServerSettings> = {}) {
  return ServerSettingsService.layerTest(overrides);
}

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderRuntimeEvent["provider"];
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

type LegacyTurnCompletedEvent = LegacyProviderRuntimeEvent & {
  readonly type: "turn.completed";
  readonly payload?: undefined;
  readonly status: "completed" | "failed" | "interrupted" | "cancelled";
  readonly errorMessage?: string | undefined;
};

function isLegacyTurnCompletedEvent(
  event: LegacyProviderRuntimeEvent,
): event is LegacyTurnCompletedEvent {
  return (
    event.type === "turn.completed" &&
    event.payload === undefined &&
    typeof event.status === "string"
  );
}

function createProviderServiceHarness() {
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const runtimeSessions: ProviderSession[] = [];

  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    steerTurn: () => unsupported(),
    updateGoal: () => unsupported(),
    clearGoal: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([...runtimeSessions]),
    getCapabilities: (provider) => Effect.succeed(defaultProviderIntegrationCapabilities(provider)),
    rollbackConversation: () => unsupported(),
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  };

  const setSession = (session: ProviderSession): void => {
    const existingIndex = runtimeSessions.findIndex((entry) => entry.threadId === session.threadId);
    if (existingIndex >= 0) {
      runtimeSessions[existingIndex] = session;
      return;
    }
    runtimeSessions.push(session);
  };

  const normalizeLegacyEvent = (event: LegacyProviderRuntimeEvent): ProviderRuntimeEvent => {
    if (isLegacyTurnCompletedEvent(event)) {
      const normalized: Extract<ProviderRuntimeEvent, { type: "turn.completed" }> = {
        ...(event as Omit<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>, "payload">),
        payload: {
          state: event.status,
          ...(typeof event.errorMessage === "string" ? { errorMessage: event.errorMessage } : {}),
        },
      };
      return normalized;
    }

    return event as ProviderRuntimeEvent;
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, normalizeLegacyEvent(event)));
  };

  return {
    service,
    emit,
    setSession,
  };
}

async function waitForThread(
  engine: OrchestrationEngineShape,
  predicate: (thread: ProviderRuntimeTestThread) => boolean,
  timeoutMs = 2000,
  threadId: ThreadId = asThreadId("thread-1"),
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<ProviderRuntimeTestThread> => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (thread && predicate(thread)) {
      return thread;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for thread state");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

async function waitForProjectedThread(
  readThread: (threadId?: ThreadId) => Promise<ProviderRuntimeTestThread | undefined>,
  predicate: (thread: ProviderRuntimeTestThread) => boolean,
  timeoutMs = 2000,
  threadId: ThreadId = asThreadId("thread-1"),
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<ProviderRuntimeTestThread> => {
    const thread = await readThread(threadId);
    if (thread && predicate(thread)) {
      return thread;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for projected thread state");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

type ProviderRuntimeTestReadModel = OrchestrationReadModel;
type ProviderRuntimeTestThread = ProviderRuntimeTestReadModel["threads"][number];
type ProviderRuntimeTestMessage = ProviderRuntimeTestThread["messages"][number];
type ProviderRuntimeTestProposedPlan = ProviderRuntimeTestThread["proposedPlans"][number];
type ProviderRuntimeTestActivity = ProviderRuntimeTestThread["activities"][number];
type ProviderRuntimeTestCheckpoint = ProviderRuntimeTestThread["checkpoints"][number];

describe("ProviderRuntimeIngestion", () => {
  let runtime: ManagedRuntime.ManagedRuntime<any, unknown> | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await disposeHarness();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function disposeHarness() {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  }

  async function createHarness(options?: {
    serverSettings?: Partial<ServerSettings>;
    workspaceRoot?: string;
    serverBaseDir?: string;
    seedBaseState?: boolean;
    persistenceLayer?: Layer.Layer<SqlClient.SqlClient>;
  }) {
    const workspaceRoot = options?.workspaceRoot ?? makeTempDir("ace-provider-project-");
    const serverBaseDir = options?.serverBaseDir ?? makeTempDir("ace-provider-state-");
    fs.mkdirSync(path.join(workspaceRoot, ".git"), { recursive: true });
    const provider = createProviderServiceHarness();
    const persistenceLayer = options?.persistenceLayer ?? SqlitePersistenceMemory;
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(persistenceLayer),
    );
    const layer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(persistenceLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(makeTestServerSettingsLayer(options?.serverSettings)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), serverBaseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    const projectionSnapshotQuery = await runtime.runPromise(
      Effect.service(ProjectionSnapshotQuery),
    );
    const serverConfig = await runtime.runPromise(Effect.service(ServerConfig));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(ingestion.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(ingestion.drain);
    const readActivityPersistence = () =>
      runtime!.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const projectionRows = yield* sql<{
            readonly activityId: string;
            readonly kind: string;
            readonly payloadJson: string;
          }>`
            SELECT
              activity_id AS "activityId",
              kind,
              payload_json AS "payloadJson"
            FROM projection_thread_activities
            WHERE thread_id = ${asThreadId("thread-1")}
            ORDER BY created_at ASC, activity_id ASC
          `;
          const eventCountRows = yield* sql<{
            readonly count: number;
          }>`
            SELECT COUNT(*) AS "count"
            FROM orchestration_events
            WHERE event_type = ${"thread.activity-appended"}
              AND stream_id = ${asThreadId("thread-1")}
          `;
          return {
            projectionRows,
            activityEventCount: eventCountRows[0]?.count ?? 0,
          };
        }),
      );
    const readProjectedThread = (threadId: ThreadId = asThreadId("thread-1")) =>
      runtime!.runPromise(
        projectionSnapshotQuery
          .getSnapshot({ hydrateThreadId: threadId })
          .pipe(Effect.map((snapshot) => snapshot.threads.find((entry) => entry.id === threadId))),
      );

    const createdAt = new Date().toISOString();
    if (options?.seedBaseState !== false) {
      await Effect.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-provider-project-create"),
          projectId: asProjectId("project-1"),
          title: "Provider Project",
          workspaceRoot,
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt,
        }),
      );
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-create"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("cmd-session-seed"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          session: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            updatedAt: createdAt,
            lastError: null,
          },
          createdAt,
        }),
      );
      provider.setSession({
        provider: "codex",
        status: "ready",
        runtimeMode: "approval-required",
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt,
        updatedAt: createdAt,
      });
    }

    return {
      engine,
      emit: provider.emit,
      setProviderSession: provider.setSession,
      serverConfig,
      drain,
      readActivityPersistence,
      readProjectedThread,
    };
  }

  it("maps turn started/completed events into thread session updates", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-1"),
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "running" && thread.session?.activeTurnId === "turn-1",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "failed",
        errorMessage: "turn failed",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "turn failed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("turn failed");
  });

  it("applies provider runtime capability overrides from session configuration", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "session.configured",
      eventId: asEventId("evt-gemini-native-fork-capabilities"),
      provider: "gemini",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      payload: {
        config: {
          provider_capabilities: {
            forkMode: "native",
            sideMode: "nativeFork",
            sideCommands: [".side", "/btw", ".side"],
            threadTargeting: "native",
            resumeMode: "native",
            steeringMode: "queuedMessage",
            goalControlMode: "native",
            multiAgentMode: "agentCommand",
            agentInvocationPrefixes: ["@", "/agent", "@"],
            agentDefinitionPaths: [".gemini/agents/*.md", "~/.gemini/agents/*.md"],
            agentFilesLocations: ["configured chat.agentFilesLocations"],
            chatModeFilesLocations: [".github/chatmodes/*.md"],
            hookMode: "native",
            extensionMode: "localDiscovery",
            mcpMode: "native",
            remoteAgentMode: "localBridge",
            webAccessMode: "agentCommand",
            hostedSessionMode: "localBridge",
          },
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.providerName === "gemini" &&
        entry.session?.capabilities?.sessionForkMode === "native" &&
        entry.session?.capabilities?.sideConversationMode === "native-fork" &&
        entry.session?.capabilities?.sideConversationCommands?.length === 0 &&
        entry.session?.capabilities?.providerThreadTargetingMode === "native" &&
        entry.session?.capabilities?.sessionResumeMode === "native" &&
        entry.session?.capabilities?.turnSteeringMode === "queued-message" &&
        entry.session?.capabilities?.goalControlMode === "native" &&
        entry.session?.capabilities?.multiAgentMode === "agent-command" &&
        entry.session?.capabilities?.multiAgentInvocationPrefixes?.join(",") === "@,/agent" &&
        entry.session?.capabilities?.multiAgentDefinitionPaths?.join(",") ===
          ".gemini/agents/*.md,~/.gemini/agents/*.md,configured chat.agentFilesLocations,.github/chatmodes/*.md" &&
        entry.session?.capabilities?.hookMode === "native" &&
        entry.session?.capabilities?.extensionMode === "local-discovery" &&
        entry.session?.capabilities?.mcpMode === "native" &&
        entry.session?.capabilities?.remoteAgentMode === "local-bridge" &&
        entry.session?.capabilities?.webAccessMode === "agent-command" &&
        entry.session?.capabilities?.hostedSessionMode === "local-bridge",
    );

    expect(thread.session?.capabilities?.sessionForkMode).toBe("native");
    expect(thread.session?.capabilities?.sideConversationMode).toBe("native-fork");
    expect(thread.session?.capabilities?.sideConversationCommands).toEqual([]);
    expect(thread.session?.capabilities?.providerThreadTargetingMode).toBe("native");
    expect(thread.session?.capabilities?.sessionResumeMode).toBe("native");
    expect(thread.session?.capabilities?.turnSteeringMode).toBe("queued-message");
    expect(thread.session?.capabilities?.goalControlMode).toBe("native");
    expect(thread.session?.capabilities?.multiAgentMode).toBe("agent-command");
    expect(thread.session?.capabilities?.multiAgentInvocationPrefixes).toEqual(["@", "/agent"]);
    expect(thread.session?.capabilities?.multiAgentDefinitionPaths).toEqual([
      ".gemini/agents/*.md",
      "~/.gemini/agents/*.md",
      "configured chat.agentFilesLocations",
      ".github/chatmodes/*.md",
    ]);
    expect(thread.session?.capabilities?.hookMode).toBe("native");
    expect(thread.session?.capabilities?.extensionMode).toBe("local-discovery");
    expect(thread.session?.capabilities?.mcpMode).toBe("native");
    expect(thread.session?.capabilities?.remoteAgentMode).toBe("local-bridge");
    expect(thread.session?.capabilities?.webAccessMode).toBe("agent-command");
    expect(thread.session?.capabilities?.hostedSessionMode).toBe("local-bridge");
  });

  it("applies provider runtime capability overrides from boolean and nested capability advertisements", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "session.configured",
      eventId: asEventId("evt-acp-session-fork-capabilities"),
      provider: "cursor",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      payload: {
        config: {
          capabilities: {
            "session.fork": true,
            session: {
              sideChat: {
                supported: true,
                commands: ["/btw", ".side", "/btw"],
              },
              loadSession: true,
              goalControl: true,
            },
            providerThreadTargeting: { enabled: true },
            turn: {
              "turn.steer": true,
            },
            agents: {
              supported: true,
            },
            hooks: {
              supported: true,
            },
            skills: {
              supported: true,
            },
            mcpServers: {
              docs: {
                enabled: true,
              },
            },
            cloudAgents: {
              supported: true,
            },
            cloudTasks: {
              supported: true,
            },
            webFetch: {
              supported: true,
            },
          },
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.providerName === "cursor" &&
        entry.session?.capabilities?.sessionForkMode === "native" &&
        entry.session?.capabilities?.sideConversationMode === "native-fork" &&
        entry.session?.capabilities?.sideConversationCommands?.length === 0 &&
        entry.session?.capabilities?.providerThreadTargetingMode === "native" &&
        entry.session?.capabilities?.sessionResumeMode === "native" &&
        entry.session?.capabilities?.turnSteeringMode === "native" &&
        entry.session?.capabilities?.goalControlMode === "native" &&
        entry.session?.capabilities?.multiAgentMode === "native" &&
        entry.session?.capabilities?.hookMode === "native" &&
        entry.session?.capabilities?.extensionMode === "native" &&
        entry.session?.capabilities?.mcpMode === "native" &&
        entry.session?.capabilities?.remoteAgentMode === "native" &&
        entry.session?.capabilities?.webAccessMode === "native" &&
        entry.session?.capabilities?.hostedSessionMode === "native",
    );

    expect(thread.session?.capabilities?.sessionForkMode).toBe("native");
    expect(thread.session?.capabilities?.sideConversationMode).toBe("native-fork");
    expect(thread.session?.capabilities?.sideConversationCommands).toEqual([]);
    expect(thread.session?.capabilities?.providerThreadTargetingMode).toBe("native");
    expect(thread.session?.capabilities?.sessionResumeMode).toBe("native");
    expect(thread.session?.capabilities?.turnSteeringMode).toBe("native");
    expect(thread.session?.capabilities?.goalControlMode).toBe("native");
    expect(thread.session?.capabilities?.multiAgentMode).toBe("native");
    expect(thread.session?.capabilities?.hookMode).toBe("native");
    expect(thread.session?.capabilities?.extensionMode).toBe("native");
    expect(thread.session?.capabilities?.mcpMode).toBe("native");
    expect(thread.session?.capabilities?.remoteAgentMode).toBe("native");
    expect(thread.session?.capabilities?.webAccessMode).toBe("native");
    expect(thread.session?.capabilities?.hostedSessionMode).toBe("native");
  });

  it("applies provider runtime capability overrides from advertised method lists", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "session.configured",
      eventId: asEventId("evt-provider-method-list-capabilities"),
      provider: "cursor",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      payload: {
        config: {
          capabilities: {
            availableMethods: [
              "session/fork",
              "side/chat",
              "provider_thread_targeting",
              "session.resume",
              "turn/steer",
              "thread/goal/update",
              "agent/team",
              "permission/request",
              "custom/agents",
              "mcp/servers",
              "a2a/agents",
              "web/search",
              "cloud/tasks",
            ],
          },
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.providerName === "cursor" &&
        entry.session?.capabilities?.sessionForkMode === "native" &&
        entry.session?.capabilities?.sideConversationMode === "native-fork" &&
        entry.session?.capabilities?.providerThreadTargetingMode === "native" &&
        entry.session?.capabilities?.sessionResumeMode === "native" &&
        entry.session?.capabilities?.turnSteeringMode === "native" &&
        entry.session?.capabilities?.goalControlMode === "native" &&
        entry.session?.capabilities?.multiAgentMode === "native" &&
        entry.session?.capabilities?.hookMode === "native" &&
        entry.session?.capabilities?.extensionMode === "native" &&
        entry.session?.capabilities?.mcpMode === "native" &&
        entry.session?.capabilities?.remoteAgentMode === "native" &&
        entry.session?.capabilities?.webAccessMode === "native" &&
        entry.session?.capabilities?.hostedSessionMode === "native",
    );

    expect(thread.session?.capabilities?.sessionForkMode).toBe("native");
    expect(thread.session?.capabilities?.sideConversationMode).toBe("native-fork");
    expect(thread.session?.capabilities?.providerThreadTargetingMode).toBe("native");
    expect(thread.session?.capabilities?.sessionResumeMode).toBe("native");
    expect(thread.session?.capabilities?.turnSteeringMode).toBe("native");
    expect(thread.session?.capabilities?.goalControlMode).toBe("native");
    expect(thread.session?.capabilities?.multiAgentMode).toBe("native");
    expect(thread.session?.capabilities?.hookMode).toBe("native");
    expect(thread.session?.capabilities?.extensionMode).toBe("native");
    expect(thread.session?.capabilities?.mcpMode).toBe("native");
    expect(thread.session?.capabilities?.remoteAgentMode).toBe("native");
    expect(thread.session?.capabilities?.webAccessMode).toBe("native");
    expect(thread.session?.capabilities?.hostedSessionMode).toBe("native");
  });

  it("applies side-session and child-session capability aliases", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "session.configured",
      eventId: asEventId("evt-provider-child-session-capabilities"),
      provider: "opencode",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      payload: {
        config: {
          capabilities: {
            sideSession: {
              supported: true,
            },
            childSessionTargeting: {
              enabled: true,
            },
            methods: ["provider/session/target", "conversation/side/thread"],
          },
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.providerName === "opencode" &&
        entry.session?.capabilities?.sideConversationMode === "native-side-thread" &&
        entry.session?.capabilities?.providerThreadTargetingMode === "native",
    );

    expect(thread.session?.capabilities?.sideConversationMode).toBe("native-side-thread");
    expect(thread.session?.capabilities?.providerThreadTargetingMode).toBe("native");
  });

  it("applies provider session.state.changed transitions directly", async () => {
    const harness = await createHarness();
    const waitingAt = new Date().toISOString();

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-waiting"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: waitingAt,
      payload: {
        state: "waiting",
        reason: "awaiting approval",
      },
    });

    let thread = await waitForThread(
      harness.engine,
      (entry) => entry.session?.status === "running" && entry.session?.activeTurnId === null,
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.lastError).toBeNull();

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-error"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "error",
        reason: "provider crashed",
      },
    });

    thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-stopped"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "stopped",
      },
    });

    thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "stopped" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("stopped");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-ready"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "ready",
      },
    });

    thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === null,
    );
    expect(thread.session?.status).toBe("ready");
    expect(thread.session?.lastError).toBeNull();
  });

  it("restores Pi session config options and replay-ready transcript after orchestration restart", async () => {
    const workspaceRoot = makeTempDir("ace-provider-project-pi-restart-");
    const serverBaseDir = makeTempDir("ace-provider-state-pi-restart-");
    const dbPath = path.join(serverBaseDir, "provider-runtime.sqlite");
    const persistenceLayer = makeSqlitePersistenceLive(dbPath).pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.orDie,
    );

    const firstHarness = await createHarness({
      workspaceRoot,
      serverBaseDir,
      persistenceLayer,
    });
    const now = new Date().toISOString();

    firstHarness.setProviderSession({
      provider: "pi",
      status: "ready",
      runtimeMode: "full-access",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      updatedAt: now,
    });

    firstHarness.emit({
      type: "session.started",
      eventId: asEventId("evt-pi-session-started"),
      provider: "pi",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        processPid: 4312,
      },
    });

    await waitForThread(
      firstHarness.engine,
      (thread) => thread.session?.providerName === "pi" && thread.session?.status === "ready",
    );

    firstHarness.emit({
      type: "session.configured",
      eventId: asEventId("evt-pi-session-configured"),
      provider: "pi",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        config: {
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "openai/gpt-5.5",
              options: [
                {
                  value: "openai/gpt-5.4",
                  name: "GPT-5.4",
                },
                {
                  value: "openai/gpt-5.5",
                  name: "GPT-5.5",
                },
              ],
            },
            {
              key: "thought_level",
              label: "Thinking Level",
              category: "thought_level",
              type: "select",
              selectedValue: "xhigh",
              choices: [
                {
                  value: "medium",
                  name: "Medium",
                },
                {
                  value: "xhigh",
                  name: "Extra High",
                },
              ],
            },
            {
              id: "agent_teams",
              name: "Agent Teams",
              category: "multi_agent",
              type: "toggle",
              currentValue: true,
            },
            {
              id: "temperature",
              name: "Temperature",
              category: "generation",
              type: "range",
              value: 0.7,
              min: 0,
              max: 1,
              step: 0.1,
            },
            {
              id: "system_note",
              name: "System Note",
              category: "prompting",
              type: "text",
              value: "",
            },
          ],
          availableCommands: [
            {
              name: "review",
              kind: "provider",
              description: "Review the workspace",
              metadata: {
                model: "pi-pro",
                allowedTools: ["Read", "Grep"],
                arguments: ["target"],
              },
            },
            {
              name: "root-meta",
              kind: "provider",
              description: "Root metadata command",
              modelId: "pi-root-model",
              tools: ["Read", "Bash"],
              args: ["subject"],
              noModel: true,
            },
          ],
        },
      },
    });

    await firstHarness.drain();
    const configuredReadModel = await Effect.runPromise(firstHarness.engine.getReadModel());
    const configuredThread = configuredReadModel.threads.find((thread) => thread.id === "thread-1");
    expect(configuredThread?.session?.providerName).toBe("pi");
    expect(configuredThread?.session?.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "review",
          kind: "provider",
          metadata: {
            model: "pi-pro",
            allowedTools: ["Read", "Grep"],
            arguments: ["target"],
          },
        }),
        expect.objectContaining({
          name: "root-meta",
          kind: "provider",
          metadata: {
            model: "pi-root-model",
            allowedTools: ["Read", "Bash"],
            arguments: ["subject"],
            disableModelInvocation: true,
          },
        }),
      ]),
    );
    expect(configuredThread?.session?.configOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "model",
          currentValue: "openai/gpt-5.5",
        }),
        expect.objectContaining({
          id: "thought_level",
          currentValue: "xhigh",
        }),
        expect.objectContaining({
          id: "agent_teams",
          type: "boolean",
          currentValue: "on",
          options: [
            { value: "off", name: "Off" },
            { value: "on", name: "On" },
          ],
        }),
        expect.objectContaining({
          id: "temperature",
          type: "number",
          currentValue: "0.7",
          minValue: 0,
          maxValue: 1,
          stepValue: 0.1,
          options: [],
        }),
        expect.objectContaining({
          id: "system_note",
          type: "text",
          currentValue: "",
          options: [],
        }),
      ]),
    );

    await Effect.runPromise(
      firstHarness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-pi-restart-turn-start"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("message-pi-restart-user"),
          role: "user",
          text: "Investigate the flaky restart path.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );
    await firstHarness.drain();

    firstHarness.emit({
      type: "turn.started",
      eventId: asEventId("evt-pi-turn-started"),
      provider: "pi",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-pi-restart"),
    });
    await waitForThread(
      firstHarness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-pi-restart",
    );

    firstHarness.emit({
      type: "content.delta",
      eventId: asEventId("evt-pi-assistant-delta-1"),
      provider: "pi",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-pi-restart"),
      itemId: asItemId("pi-assistant-item"),
      payload: {
        streamKind: "assistant_text",
        delta: "I found the replay bug",
      },
    });
    firstHarness.emit({
      type: "content.delta",
      eventId: asEventId("evt-pi-assistant-delta-2"),
      provider: "pi",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-pi-restart"),
      itemId: asItemId("pi-assistant-item"),
      payload: {
        streamKind: "assistant_text",
        delta: " in the restart path.",
      },
    });
    firstHarness.emit({
      type: "item.completed",
      eventId: asEventId("evt-pi-assistant-item-completed"),
      provider: "pi",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-pi-restart"),
      itemId: asItemId("pi-assistant-item"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });
    firstHarness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-pi-turn-completed"),
      provider: "pi",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-pi-restart"),
      payload: {
        state: "completed",
      },
    });

    await waitForThread(
      firstHarness.engine,
      (thread) =>
        thread.session?.status === "ready" &&
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:pi-assistant-item" &&
            message.text === "I found the replay bug in the restart path.",
        ),
    );
    await firstHarness.drain();
    await waitForProjectedThread(
      firstHarness.readProjectedThread,
      (thread) =>
        thread.session?.configOptions?.some(
          (option) => option.id === "thought_level" && option.currentValue === "xhigh",
        ) === true &&
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:pi-assistant-item" &&
            message.text === "I found the replay bug in the restart path.",
        ),
    );

    await disposeHarness();

    const restartedHarness = await createHarness({
      workspaceRoot,
      serverBaseDir,
      persistenceLayer,
      seedBaseState: false,
    });

    const recoveredThread = await restartedHarness.readProjectedThread(asThreadId("thread-1"));

    expect(recoveredThread?.session?.providerName).toBe("pi");
    expect(recoveredThread?.session?.status).toBe("ready");
    expect(recoveredThread?.session?.commands).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "review", kind: "provider" })]),
    );
    expect(recoveredThread?.session?.configOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "model",
          currentValue: "openai/gpt-5.5",
        }),
        expect.objectContaining({
          id: "thought_level",
          currentValue: "xhigh",
        }),
        expect.objectContaining({
          id: "agent_teams",
          type: "boolean",
          currentValue: "on",
        }),
        expect.objectContaining({
          id: "temperature",
          type: "number",
          currentValue: "0.7",
        }),
        expect.objectContaining({
          id: "system_note",
          type: "text",
          currentValue: "",
        }),
      ]),
    );
    expect(recoveredThread?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "message-pi-restart-user",
          text: "Investigate the flaky restart path.",
        }),
        expect.objectContaining({
          id: "assistant:pi-assistant-item",
          text: "I found the replay bug in the restart path.",
        }),
      ]),
    );
  });

  it("ignores session.exited when the reported runtime pid is still alive", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-live-pid"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-live-pid"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-live-pid",
    );

    harness.emit({
      type: "session.exited",
      eventId: asEventId("evt-session-exited-live-pid"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        reason: "stale exit event",
        processPid: process.pid,
      },
    });

    await harness.drain();
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.status).toBe("running");
    expect(thread?.session?.activeTurnId).toBe("turn-live-pid");
  });

  it("ignores session.exited from a stale runtime pid when a newer pid was seen", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started-pid-tracking"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      payload: {
        processPid: process.pid,
      },
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-pid-tracking"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-pid-tracking"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-pid-tracking",
    );

    harness.emit({
      type: "session.exited",
      eventId: asEventId("evt-session-exited-stale-pid"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        reason: "stale runtime exited",
        processPid: process.pid + 1,
      },
    });

    await harness.drain();
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.status).toBe("running");
    expect(thread?.session?.activeTurnId).toBe("turn-pid-tracking");
  });

  it("applies graceful session.exited even when the pid is still alive", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-graceful-exit"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-graceful-exit"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-graceful-exit",
    );

    harness.emit({
      type: "session.exited",
      eventId: asEventId("evt-session-exited-graceful-exit"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        reason: "session stopped",
        exitKind: "graceful",
        processPid: process.pid,
      },
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "stopped" && thread.session?.activeTurnId === null,
    );
  });

  it("does not clear active turn when session/thread started arrives mid-turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-midturn-lifecycle"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-midturn-lifecycle",
    );

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started-midturn-lifecycle"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started-midturn-lifecycle"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-midturn-lifecycle");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-midturn-lifecycle"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("accepts claude turn lifecycle when seeded thread id is a synthetic placeholder", async () => {
    const harness = await createHarness();
    const seededAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-seed-claude-placeholder"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: seededAt,
          lastError: null,
        },
        createdAt: seededAt,
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-claude-placeholder"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-placeholder"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-claude-placeholder",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-claude-placeholder"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-placeholder"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores auxiliary turn completions from a different provider thread", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-primary"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-primary",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-aux"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-aux"),
      status: "completed",
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-primary");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-primary"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores non-active turn completion when runtime omits thread id", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-guarded"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-guarded-main",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-other"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-other"),
      status: "completed",
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-guarded-main");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-main"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores turn completion without turnId while a turn is active", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-no-turnid-complete"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-no-turnid-complete"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-no-turnid-complete",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-no-turnid-complete"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      payload: {
        state: "completed",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "running" &&
        entry.session?.activeTurnId === "turn-no-turnid-complete",
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.activeTurnId).toBe("turn-no-turnid-complete");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-no-turnid-complete-matched"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-no-turnid-complete"),
      payload: {
        state: "completed",
      },
    });

    await waitForThread(
      harness.engine,
      (entry) => entry.session?.status === "ready" && entry.session?.activeTurnId === null,
    );
  });

  it("releases the session when a running turn is aborted", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-aborted"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-aborted"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-aborted",
    );

    harness.emit({
      type: "turn.aborted",
      eventId: asEventId("evt-turn-aborted"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-aborted"),
      payload: {
        reason: "Turn interrupted",
      },
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("maps canonical content delta/item completed into finalized assistant messages", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-2"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: " world",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-1" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-1",
    );
    expect(message?.text).toBe("hello world");
    expect(message?.streaming).toBe(false);
  });

  it("promotes provider goal lifecycle items into hidden goal state activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-goal-tool-output"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-goal"),
      itemId: asItemId("item-goal-tool-output"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        title: "Tool call",
        data: {
          item: {
            type: "function_call_output",
            name: "functions.update_goal",
            outputText: "Goal updated\nKeep provider goal state out of the transcript",
            result: {
              objective: "Keep provider goal state out of the transcript",
              status: "active",
            },
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.id === "evt-goal-tool-output"),
    );
    const activity = thread.activities.find((entry) => entry.id === "evt-goal-tool-output");
    expect(activity?.kind).toBe("goal.updated");
    expect(activity?.summary).toBe("Goal updated");
    expect(activity?.payload).toMatchObject({
      objective: "Keep provider goal state out of the transcript",
      status: "active",
      detail: "Keep provider goal state out of the transcript",
    });
    expect(
      thread.activities.some(
        (entry) =>
          (entry.kind === "tool.completed" || entry.kind === "task.progress") &&
          JSON.stringify(entry.payload).includes("Goal updated"),
      ),
    ).toBe(false);
  });

  it("keeps streamed goal lifecycle assistant deltas out of the transcript", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-goal-assistant-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-goal-delta"),
      itemId: asItemId("item-goal-delta"),
      payload: {
        streamKind: "assistant_text",
        delta: "Goal updated\nImplement provider feature parity without transcript leaks",
      },
    });
    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(
      thread?.messages.some((message: ProviderRuntimeTestMessage) =>
        message.text.includes("Goal updated"),
      ),
    ).toBe(false);
  });

  it("keeps completed goal lifecycle assistant items out of the transcript", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-goal-assistant-complete"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-goal-complete"),
      itemId: asItemId("item-goal-complete"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "Goal updated\nKeep completed goal state out of chat messages",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.id === "evt-goal-assistant-complete"),
    );

    expect(
      thread.messages.some((message: ProviderRuntimeTestMessage) =>
        message.text.includes("Goal updated"),
      ),
    ).toBe(false);
    expect(
      thread.activities.find((activity) => activity.id === "evt-goal-assistant-complete"),
    ).toMatchObject({
      kind: "goal.updated",
      summary: "Goal updated",
      payload: {
        objective: "Keep completed goal state out of chat messages",
        status: "active",
      },
    });
  });

  it("keeps Codex child conversation assistant text out of the main transcript", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-child-message-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-child"),
      itemId: asItemId("child-message"),
      payload: {
        streamKind: "assistant_text",
        delta: "child agent result",
        data: {
          ace: {
            parentTurnId: "turn-parent",
            childProviderThreadId: "child_provider_1",
          },
        },
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-child-message-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-child"),
      itemId: asItemId("child-message"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "child agent result",
        data: {
          ace: {
            parentTurnId: "turn-parent",
            childProviderThreadId: "child_provider_1",
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "task.progress" &&
          activity.summary === "Subagent message" &&
          activity.payload &&
          typeof activity.payload === "object" &&
          "detail" in activity.payload &&
          activity.payload.detail === "child agent result",
      ),
    );

    expect(
      thread.messages.some((message: ProviderRuntimeTestMessage) =>
        message.text.includes("child agent result"),
      ),
    ).toBe(false);
  });

  it("keeps provider-agnostic root subagent assistant text out of the main transcript", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-root-subagent-message-delta"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-root-subagent"),
      itemId: asItemId("root-subagent-message"),
      payload: {
        streamKind: "assistant_text",
        delta: "root subagent result",
        subagent: {
          id: "agent-root-1",
          type: "code-reviewer",
          name: "Reviewer",
        },
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-root-subagent-message-completed"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-root-subagent"),
      itemId: asItemId("root-subagent-message"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "root subagent result",
        subagent: {
          id: "agent-root-1",
          type: "code-reviewer",
          name: "Reviewer",
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "task.progress" &&
          activity.payload &&
          typeof activity.payload === "object" &&
          "detail" in activity.payload &&
          activity.payload.detail === "root subagent result",
      ),
    );

    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.kind === "task.progress" &&
        activity.payload &&
        typeof activity.payload === "object" &&
        "detail" in activity.payload &&
        activity.payload.detail === "root subagent result",
    );
    expect(progress?.payload).toMatchObject({
      subagent: {
        id: "agent-root-1",
        type: "code-reviewer",
        name: "Reviewer",
      },
    });
    expect(
      thread.messages.some((message: ProviderRuntimeTestMessage) =>
        message.text.includes("root subagent result"),
      ),
    ).toBe(false);
  });

  it("routes side-chat runtime events through nested provider-agnostic side metadata", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const sideThreadId = "side:thread-1:nested-route";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-side-route-activity"),
        threadId: asThreadId("thread-1"),
        activity: {
          id: asEventId("activity-side-route-message"),
          tone: "info",
          kind: "subagent.message.sent",
          summary: "User message",
          payload: {
            detail: "Inspect this branch.",
            itemType: "subagent_message",
            data: {
              childProviderThreadId: sideThreadId,
              subagent: {
                id: sideThreadId,
                type: "side chat",
                name: "Branch side chat",
              },
            },
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-side-route-message-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId(sideThreadId),
      turnId: asTurnId("turn-side-route"),
      itemId: asItemId("side-route-message"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "Nested side-chat result.",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "task.progress" &&
          activity.payload &&
          typeof activity.payload === "object" &&
          "detail" in activity.payload &&
          activity.payload.detail === "Nested side-chat result.",
      ),
    );

    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.kind === "task.progress" &&
        activity.payload &&
        typeof activity.payload === "object" &&
        "detail" in activity.payload &&
        activity.payload.detail === "Nested side-chat result.",
    );
    expect(progress?.payload).toMatchObject({
      detail: "Nested side-chat result.",
      data: {
        childProviderThreadId: sideThreadId,
        subagent: {
          id: sideThreadId,
          type: "side chat",
          name: "Branch side chat",
        },
      },
    });
    expect(
      thread.messages.some((message: ProviderRuntimeTestMessage) =>
        message.text.includes("Nested side-chat result."),
      ),
    ).toBe(false);
  });

  it("routes side-chat runtime events through item-nested provider thread ids", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const sideThreadId = "side:thread-1:item-nested-route";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-side-item-route-activity"),
        threadId: asThreadId("thread-1"),
        activity: {
          id: asEventId("activity-side-item-route-message"),
          tone: "info",
          kind: "subagent.message.sent",
          summary: "User message",
          payload: {
            detail: "Inspect this branch through item metadata.",
            itemType: "subagent_message",
            data: {
              item: {
                receiverThreadIds: [sideThreadId],
              },
              subagent: {
                id: "reviewer",
                type: "side chat",
                name: "Reviewer side chat",
              },
            },
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-side-item-route-message-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId(sideThreadId),
      turnId: asTurnId("turn-side-item-route"),
      itemId: asItemId("side-item-route-message"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "Item-nested side-chat result.",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "task.progress" &&
          activity.payload &&
          typeof activity.payload === "object" &&
          "detail" in activity.payload &&
          activity.payload.detail === "Item-nested side-chat result.",
      ),
    );

    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.kind === "task.progress" &&
        activity.payload &&
        typeof activity.payload === "object" &&
        "detail" in activity.payload &&
        activity.payload.detail === "Item-nested side-chat result.",
    );
    expect(progress?.payload).toMatchObject({
      detail: "Item-nested side-chat result.",
      data: {
        childProviderThreadId: sideThreadId,
        subagent: {
          id: sideThreadId,
          type: "side chat",
          name: "Reviewer side chat",
        },
      },
    });
    expect(
      thread.messages.some((message: ProviderRuntimeTestMessage) =>
        message.text.includes("Item-nested side-chat result."),
      ),
    ).toBe(false);
  });

  it("routes side-chat runtime events through item-nested snake_case receiver thread ids", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const sideThreadId = "side:thread-1:item-snake-route";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-side-item-snake-route-activity"),
        threadId: asThreadId("thread-1"),
        activity: {
          id: asEventId("activity-side-item-snake-route-message"),
          tone: "info",
          kind: "subagent.message.sent",
          summary: "User message",
          payload: {
            detail: "Inspect this branch through snake-case item metadata.",
            itemType: "subagent_message",
            data: {
              item: {
                receiver_thread_ids: [sideThreadId],
                agent_role: "side_chat",
                agent_name: "Snake case side chat",
              },
            },
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-side-item-snake-route-message-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId(sideThreadId),
      turnId: asTurnId("turn-side-item-snake-route"),
      itemId: asItemId("side-item-snake-route-message"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "Snake-case item side-chat result.",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "task.progress" &&
          activity.payload &&
          typeof activity.payload === "object" &&
          "detail" in activity.payload &&
          activity.payload.detail === "Snake-case item side-chat result.",
      ),
    );

    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.kind === "task.progress" &&
        activity.payload &&
        typeof activity.payload === "object" &&
        "detail" in activity.payload &&
        activity.payload.detail === "Snake-case item side-chat result.",
    );
    expect(progress?.payload).toMatchObject({
      detail: "Snake-case item side-chat result.",
      data: {
        childProviderThreadId: sideThreadId,
        subagent: {
          id: sideThreadId,
          type: "side_chat",
          name: "Snake case side chat",
        },
      },
    });
    expect(
      thread.messages.some((message: ProviderRuntimeTestMessage) =>
        message.text.includes("Snake-case item side-chat result."),
      ),
    ).toBe(false);
  });

  it("routes side-chat runtime events through normalized ace subagent metadata", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const sideThreadId = "side:thread-1:ace-normalized-route";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-side-ace-route-activity"),
        threadId: asThreadId("thread-1"),
        activity: {
          id: asEventId("activity-side-ace-route-message"),
          tone: "info",
          kind: "subagent.message.sent",
          summary: "User message",
          payload: {
            detail: "Inspect this branch through normalized Ace metadata.",
            itemType: "subagent_message",
            data: {
              ace: {
                childProviderThreadId: sideThreadId,
                subagent: {
                  id: sideThreadId,
                  type: "side-chat",
                  name: "Normalized side chat",
                },
              },
            },
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-side-ace-route-message-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId(sideThreadId),
      turnId: asTurnId("turn-side-ace-route"),
      itemId: asItemId("side-ace-route-message"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "Normalized Ace side-chat result.",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "task.progress" &&
          activity.payload &&
          typeof activity.payload === "object" &&
          "detail" in activity.payload &&
          activity.payload.detail === "Normalized Ace side-chat result.",
      ),
    );

    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.kind === "task.progress" &&
        activity.payload &&
        typeof activity.payload === "object" &&
        "detail" in activity.payload &&
        activity.payload.detail === "Normalized Ace side-chat result.",
    );
    expect(progress?.payload).toMatchObject({
      detail: "Normalized Ace side-chat result.",
      data: {
        childProviderThreadId: sideThreadId,
        subagent: {
          id: sideThreadId,
          type: "side-chat",
          name: "Normalized side chat",
        },
      },
    });
    expect(
      thread.messages.some((message: ProviderRuntimeTestMessage) =>
        message.text.includes("Normalized Ace side-chat result."),
      ),
    ).toBe(false);
  });

  it("keeps provider side-chat array assistant messages out of the main transcript", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-side-array-message-completed"),
      provider: "githubCopilot",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-side-array"),
      itemId: asItemId("side-array-message"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Side chat",
        detail: "Provider side-chat array result.",
        data: {
          sideChats: [
            {
              threadId: "provider-side-array-thread-1",
              displayName: "Architecture side chat",
              role: "side-chat",
              model: "provider-model",
            },
          ],
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "task.progress" &&
          activity.payload &&
          typeof activity.payload === "object" &&
          "detail" in activity.payload &&
          activity.payload.detail === "Provider side-chat array result.",
      ),
    );

    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.kind === "task.progress" &&
        activity.payload &&
        typeof activity.payload === "object" &&
        "detail" in activity.payload &&
        activity.payload.detail === "Provider side-chat array result.",
    );
    expect(progress?.payload).toMatchObject({
      itemType: "assistant_message",
      subagent: {
        threadId: "provider-side-array-thread-1",
        displayName: "Architecture side chat",
        role: "side-chat",
        model: "provider-model",
      },
    });
    expect(
      thread.messages.some((message: ProviderRuntimeTestMessage) =>
        message.text.includes("Provider side-chat array result."),
      ),
    ).toBe(false);
  });

  it("keeps provider fleet agent array assistant messages out of the main transcript", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-fleet-agent-array-message-completed"),
      provider: "githubCopilot",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-fleet-agent-array"),
      itemId: asItemId("fleet-agent-array-message"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Fleet",
        detail: "Provider fleet agent array result.",
        data: {
          agents: [
            {
              id: "copilot-fleet-agent-a",
              displayName: "Explore",
              role: "subagent",
              model: "gpt-5-copilot",
              response: "Explore result.",
            },
            {
              id: "copilot-fleet-agent-b",
              displayName: "Task",
              role: "subagent",
              model: "gpt-5-copilot",
              response: "Task result.",
            },
          ],
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "task.progress" &&
          activity.payload &&
          typeof activity.payload === "object" &&
          "detail" in activity.payload &&
          activity.payload.detail === "Provider fleet agent array result.",
      ),
    );

    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.kind === "task.progress" &&
        activity.payload &&
        typeof activity.payload === "object" &&
        "detail" in activity.payload &&
        activity.payload.detail === "Provider fleet agent array result.",
    );
    expect(progress?.payload).toMatchObject({
      itemType: "assistant_message",
      subagent: {
        id: "copilot-fleet-agent-a",
        displayName: "Explore",
        role: "subagent",
        model: "gpt-5-copilot",
      },
    });
    expect(
      thread.messages.some((message: ProviderRuntimeTestMessage) =>
        message.text.includes("Provider fleet agent array result."),
      ),
    ).toBe(false);
  });

  it("routes later provider side-chat array child thread events back to the parent thread", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-side-array-route-created"),
      provider: "githubCopilot",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-side-array-route"),
      itemId: asItemId("side-array-route-created"),
      payload: {
        itemType: "collab_agent_tool_call",
        status: "completed",
        title: "Side chats",
        detail: "Provider reported multiple side chats.",
        data: {
          sideChats: [
            {
              threadId: "provider-side-array-route-thread-1",
              displayName: "Architecture side chat",
              role: "side-chat",
              model: "provider-model",
            },
            {
              threadId: "provider-side-array-route-thread-2",
              displayName: "Runtime side chat",
              role: "side-chat",
              model: "provider-model",
            },
          ],
        },
      },
    });

    await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-side-array-route-created",
      ),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-side-array-route-second-message"),
      provider: "githubCopilot",
      createdAt: now,
      threadId: asThreadId("provider-side-array-route-thread-2"),
      turnId: asTurnId("turn-side-array-route-second"),
      itemId: asItemId("side-array-route-second-message"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "Second side chat stayed attached to the parent thread.",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "task.progress" &&
          activity.payload &&
          typeof activity.payload === "object" &&
          "detail" in activity.payload &&
          activity.payload.detail === "Second side chat stayed attached to the parent thread.",
      ),
    );

    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.kind === "task.progress" &&
        activity.payload &&
        typeof activity.payload === "object" &&
        "detail" in activity.payload &&
        activity.payload.detail === "Second side chat stayed attached to the parent thread.",
    );
    expect(progress?.payload).toMatchObject({
      detail: "Second side chat stayed attached to the parent thread.",
      data: {
        childProviderThreadId: "provider-side-array-route-thread-2",
        subagent: {
          id: "provider-side-array-route-thread-2",
          type: "side-chat",
          name: "Runtime side chat",
        },
      },
    });
    expect(
      thread.messages.some((message: ProviderRuntimeTestMessage) =>
        message.text.includes("Second side chat stayed attached to the parent thread."),
      ),
    ).toBe(false);
  });

  it("routes later provider fleet child thread events back to the parent thread", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-fleet-array-route-created"),
      provider: "githubCopilot",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-fleet-array-route"),
      itemId: asItemId("fleet-array-route-created"),
      payload: {
        itemType: "collab_agent_tool_call",
        status: "completed",
        title: "Fleet",
        detail: "Provider reported multiple fleet agents.",
        data: {
          agents: [
            {
              id: "copilot-fleet-route-agent-1",
              displayName: "Explore",
              role: "subagent",
              model: "gpt-5-copilot",
            },
            {
              id: "copilot-fleet-route-agent-2",
              displayName: "Task",
              role: "subagent",
              model: "gpt-5-copilot",
            },
          ],
        },
      },
    });

    await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-fleet-array-route-created",
      ),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-fleet-array-route-second-message"),
      provider: "githubCopilot",
      createdAt: now,
      threadId: asThreadId("copilot-fleet-route-agent-2"),
      turnId: asTurnId("turn-fleet-array-route-second"),
      itemId: asItemId("fleet-array-route-second-message"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "Second fleet agent stayed attached to the parent thread.",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "task.progress" &&
          activity.payload &&
          typeof activity.payload === "object" &&
          "detail" in activity.payload &&
          activity.payload.detail === "Second fleet agent stayed attached to the parent thread.",
      ),
    );

    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.kind === "task.progress" &&
        activity.payload &&
        typeof activity.payload === "object" &&
        "detail" in activity.payload &&
        activity.payload.detail === "Second fleet agent stayed attached to the parent thread.",
    );
    expect(progress?.payload).toMatchObject({
      detail: "Second fleet agent stayed attached to the parent thread.",
      data: {
        childProviderThreadId: "copilot-fleet-route-agent-2",
        subagent: {
          id: "copilot-fleet-route-agent-2",
          type: "subagent",
          name: "Task",
        },
      },
    });
    expect(
      thread.messages.some((message: ProviderRuntimeTestMessage) =>
        message.text.includes("Second fleet agent stayed attached to the parent thread."),
      ),
    ).toBe(false);
  });

  it("preserves provider task subagent metadata on task progress activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-claude-task-progress"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-task"),
      payload: {
        taskId: "task-subagent-1",
        description: "Reviewing migration edge cases",
        summary: "Checked nullable projection columns.",
        subagent: {
          id: "task-subagent-1",
          type: "claude subagent",
          name: "Reviewing migration edge cases",
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "task.progress" &&
          activity.payload &&
          typeof activity.payload === "object" &&
          "subagent" in activity.payload,
      ),
    );

    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.kind === "task.progress" &&
        activity.payload &&
        typeof activity.payload === "object" &&
        "subagent" in activity.payload,
    );
    expect(progress?.payload).toMatchObject({
      taskId: "task-subagent-1",
      detail: "Checked nullable projection columns.",
      summary: "Checked nullable projection columns.",
      subagent: {
        id: "task-subagent-1",
        type: "claude subagent",
        name: "Reviewing migration edge cases",
      },
    });
  });

  it("keeps root scalar agent metadata assistant text out of the main transcript", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-root-agent-scalar-completed"),
      provider: "githubCopilot",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-root-agent-scalar"),
      itemId: asItemId("root-agent-scalar-message"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "root scalar agent result",
        agentId: "agent-scalar-1",
        agentName: "Scalar Reviewer",
        agentRole: "code-reviewer",
        model: "gpt-5.4",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "task.progress" &&
          activity.payload &&
          typeof activity.payload === "object" &&
          "detail" in activity.payload &&
          activity.payload.detail === "root scalar agent result",
      ),
    );

    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.kind === "task.progress" &&
        activity.payload &&
        typeof activity.payload === "object" &&
        "detail" in activity.payload &&
        activity.payload.detail === "root scalar agent result",
    );
    expect(progress?.payload).toMatchObject({
      agentId: "agent-scalar-1",
      agentName: "Scalar Reviewer",
      agentRole: "code-reviewer",
      model: "gpt-5.4",
    });
    expect(
      thread.messages.some((message: ProviderRuntimeTestMessage) =>
        message.text.includes("root scalar agent result"),
      ),
    ).toBe(false);
  });

  it("keeps root display-name subagent aliases out of the main transcript", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-root-display-subagent-completed"),
      provider: "githubCopilot",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-root-display-subagent"),
      itemId: asItemId("root-display-subagent-message"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "root display subagent result",
        subagentId: "subagent-display-1",
        agentDisplayName: "Display Reviewer",
        agentRole: "code-reviewer",
        model: "gpt-5.4",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "task.progress" &&
          activity.payload &&
          typeof activity.payload === "object" &&
          "detail" in activity.payload &&
          activity.payload.detail === "root display subagent result",
      ),
    );

    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.kind === "task.progress" &&
        activity.payload &&
        typeof activity.payload === "object" &&
        "detail" in activity.payload &&
        activity.payload.detail === "root display subagent result",
    );
    expect(progress?.payload).toMatchObject({
      subagentId: "subagent-display-1",
      agentDisplayName: "Display Reviewer",
      agentRole: "code-reviewer",
      model: "gpt-5.4",
    });
    expect(
      thread.messages.some((message: ProviderRuntimeTestMessage) =>
        message.text.includes("root display subagent result"),
      ),
    ).toBe(false);
  });

  it("keeps nested provider agent metadata out of the main transcript", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-root-nested-agent-completed"),
      provider: "githubCopilot",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-root-nested-agent"),
      itemId: asItemId("root-nested-agent-message"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "root nested agent result",
        data: {
          agent: {
            id: "nested-agent-1",
            name: "Nested Reviewer",
            role: "code-reviewer",
            model: "gpt-5.4",
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "task.progress" &&
          activity.payload &&
          typeof activity.payload === "object" &&
          "detail" in activity.payload &&
          activity.payload.detail === "root nested agent result",
      ),
    );

    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.kind === "task.progress" &&
        activity.payload &&
        typeof activity.payload === "object" &&
        "detail" in activity.payload &&
        activity.payload.detail === "root nested agent result",
    );
    expect(progress?.payload).toMatchObject({
      data: {
        agent: {
          id: "nested-agent-1",
          name: "Nested Reviewer",
          role: "code-reviewer",
          model: "gpt-5.4",
        },
      },
      subagent: {
        id: "nested-agent-1",
        name: "Nested Reviewer",
        role: "code-reviewer",
        model: "gpt-5.4",
      },
    });
    expect(
      thread.messages.some((message: ProviderRuntimeTestMessage) =>
        message.text.includes("root nested agent result"),
      ),
    ).toBe(false);
  });

  it("keeps item-nested provider agent metadata out of the main transcript", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-root-item-agent-completed"),
      provider: "githubCopilot",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-root-item-agent"),
      itemId: asItemId("root-item-agent-message"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "root item agent result",
        data: {
          item: {
            agent: {
              id: "item-agent-1",
              name: "Item Reviewer",
              role: "researcher",
              model: "gpt-5.4",
            },
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "task.progress" &&
          activity.payload &&
          typeof activity.payload === "object" &&
          "detail" in activity.payload &&
          activity.payload.detail === "root item agent result",
      ),
    );

    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.kind === "task.progress" &&
        activity.payload &&
        typeof activity.payload === "object" &&
        "detail" in activity.payload &&
        activity.payload.detail === "root item agent result",
    );
    expect(progress?.payload).toMatchObject({
      data: {
        item: {
          agent: {
            id: "item-agent-1",
            name: "Item Reviewer",
            role: "researcher",
            model: "gpt-5.4",
          },
        },
      },
      subagent: {
        id: "item-agent-1",
        name: "Item Reviewer",
        role: "researcher",
        model: "gpt-5.4",
      },
    });
    expect(
      thread.messages.some((message: ProviderRuntimeTestMessage) =>
        message.text.includes("root item agent result"),
      ),
    ).toBe(false);
  });

  it("keeps delegated provider agent metadata out of the main transcript", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-root-delegated-agent-completed"),
      provider: "githubCopilot",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-root-delegated-agent"),
      itemId: asItemId("root-delegated-agent-message"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "delegated agent result",
        data: {
          assignedAgent: {
            id: "assigned-agent-1",
            displayName: "Platform Specialist",
            role: "platform",
            model: "gpt-5.4",
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "task.progress" &&
          activity.payload &&
          typeof activity.payload === "object" &&
          "detail" in activity.payload &&
          activity.payload.detail === "delegated agent result",
      ),
    );

    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.kind === "task.progress" &&
        activity.payload &&
        typeof activity.payload === "object" &&
        "detail" in activity.payload &&
        activity.payload.detail === "delegated agent result",
    );
    expect(progress?.payload).toMatchObject({
      data: {
        assignedAgent: {
          id: "assigned-agent-1",
          displayName: "Platform Specialist",
          role: "platform",
          model: "gpt-5.4",
        },
      },
      subagent: {
        id: "assigned-agent-1",
        displayName: "Platform Specialist",
        role: "platform",
        model: "gpt-5.4",
      },
    });
    expect(
      thread.messages.some((message: ProviderRuntimeTestMessage) =>
        message.text.includes("delegated agent result"),
      ),
    ).toBe(false);
  });

  it("splits assistant messages when tool activity interrupts the same assistant item", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-segment-delta-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-segmented"),
      itemId: asItemId("item-segmented"),
      payload: {
        streamKind: "assistant_text",
        delta: "First answer chunk.",
      },
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-segment-tool-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-segmented"),
      itemId: asItemId("tool-segmented"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "bash",
        detail: "bun run lint",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-segment-delta-2"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-segmented"),
      itemId: asItemId("item-segmented"),
      payload: {
        streamKind: "assistant_text",
        delta: "Follow-up after tool.",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-segment-complete"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-segmented"),
      itemId: asItemId("item-segmented"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) => {
      const assistantMessages = entry.messages.filter(
        (message: ProviderRuntimeTestMessage) =>
          message.turnId === "turn-segmented" && message.role === "assistant" && !message.streaming,
      );
      return assistantMessages.length >= 2;
    });

    const assistantMessages = thread.messages.filter(
      (message: ProviderRuntimeTestMessage) =>
        message.turnId === "turn-segmented" && message.role === "assistant",
    );
    expect(assistantMessages.map((message) => message.text)).toEqual([
      "First answer chunk.",
      "Follow-up after tool.",
    ]);

    const toolActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-segment-tool-started",
    );
    expect(toolActivity?.kind).toBe("tool.started");
  });

  it("keeps assistant output merged when tool activity visibility is disabled", async () => {
    const harness = await createHarness({ serverSettings: { enableToolStreaming: false } });
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-tool-disabled-delta-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-tool-disabled"),
      itemId: asItemId("item-tool-disabled"),
      payload: {
        streamKind: "assistant_text",
        delta: "Before tool. ",
      },
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-tool-disabled-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-tool-disabled"),
      itemId: asItemId("tool-tool-disabled"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "bash",
        detail: "bun run lint",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-tool-disabled-delta-2"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-tool-disabled"),
      itemId: asItemId("item-tool-disabled"),
      payload: {
        streamKind: "assistant_text",
        delta: "After tool.",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-tool-disabled-complete"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-tool-disabled"),
      itemId: asItemId("item-tool-disabled"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.turnId === "turn-tool-disabled" &&
          message.role === "assistant" &&
          !message.streaming,
      ),
    );

    const assistantMessages = thread.messages.filter(
      (message: ProviderRuntimeTestMessage) =>
        message.turnId === "turn-tool-disabled" && message.role === "assistant",
    );
    expect(assistantMessages.map((message) => message.text)).toEqual(["Before tool. After tool."]);
    const toolActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-tool-disabled-started",
    );
    expect(toolActivity?.kind).toBe("tool.started");
  });

  it("normalizes command lifecycle details and preserves streamed terminal output", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-normalized-start"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-normalized"),
      itemId: asItemId("cmd-normalized"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Command execution",
        detail: "ls -la",
        data: {
          item: {
            command: "ls -la",
            cwd: "/tmp/project",
          },
        },
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-command-normalized-output-1"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-normalized"),
      itemId: asItemId("cmd-normalized"),
      payload: {
        streamKind: "command_output",
        delta: "total 8\n",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-command-normalized-output-2"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-normalized"),
      itemId: asItemId("cmd-normalized"),
      payload: {
        streamKind: "command_output",
        delta: "drwxr-xr-x .\n",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "evt-command-normalized-output-2",
      ),
    );
    const started = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-command-normalized-start",
    );
    expect(started?.summary).toBe("Ran command ls -la");
    expect(started?.payload).toMatchObject({
      itemType: "command_execution",
      itemId: "cmd-normalized",
      title: "Ran command ls -la",
      command: "ls -la",
      cwd: "/tmp/project",
    });

    const output = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-command-normalized-output-2",
    );
    expect(output?.kind).toBe("tool.updated");
    expect(output?.payload).toMatchObject({
      itemType: "command_execution",
      itemId: "cmd-normalized",
      terminalOutput: "drwxr-xr-x .\n",
      streamKind: "command_output",
    });
  });

  it("splits assistant messages when reasoning activity interrupts the same assistant item", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-reasoning-segment-delta-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning-segmented"),
      itemId: asItemId("item-reasoning-segmented"),
      payload: {
        streamKind: "assistant_text",
        delta: "Before reasoning.",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-reasoning-segment-thinking"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning-segmented"),
      itemId: asItemId("reasoning-reasoning-segmented"),
      payload: {
        streamKind: "reasoning_text",
        delta: "Thinking through the next tool call.",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-reasoning-segment-delta-2"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning-segmented"),
      itemId: asItemId("item-reasoning-segmented"),
      payload: {
        streamKind: "assistant_text",
        delta: "After reasoning.",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-reasoning-segment-complete"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning-segmented"),
      itemId: asItemId("item-reasoning-segmented"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) => {
      const assistantMessages = entry.messages.filter(
        (message: ProviderRuntimeTestMessage) =>
          message.turnId === "turn-reasoning-segmented" &&
          message.role === "assistant" &&
          !message.streaming,
      );
      return assistantMessages.length >= 2;
    });

    const assistantMessages = thread.messages.filter(
      (message: ProviderRuntimeTestMessage) =>
        message.turnId === "turn-reasoning-segmented" && message.role === "assistant",
    );
    expect(assistantMessages.map((message) => message.text)).toEqual([
      "Before reasoning.",
      "After reasoning.",
    ]);

    const reasoningActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-reasoning-segment-thinking",
    );
    expect(reasoningActivity?.kind).toBe("task.progress");
  });

  it("keeps assistant output merged when thinking activity visibility is disabled", async () => {
    const harness = await createHarness({ serverSettings: { enableThinkingStreaming: false } });
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-thinking-disabled-delta-1"),
      provider: "githubCopilot",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-thinking-disabled"),
      itemId: asItemId("item-thinking-disabled"),
      payload: {
        streamKind: "assistant_text",
        delta: "Before thinking. ",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-thinking-disabled-reasoning"),
      provider: "githubCopilot",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-thinking-disabled"),
      itemId: asItemId("reasoning-thinking-disabled"),
      payload: {
        streamKind: "reasoning_text",
        delta: "Inspecting package scripts before running checks.",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-thinking-disabled-delta-2"),
      provider: "githubCopilot",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-thinking-disabled"),
      itemId: asItemId("item-thinking-disabled"),
      payload: {
        streamKind: "assistant_text",
        delta: "After thinking.",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-thinking-disabled-complete"),
      provider: "githubCopilot",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-thinking-disabled"),
      itemId: asItemId("item-thinking-disabled"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.turnId === "turn-thinking-disabled" &&
          message.role === "assistant" &&
          !message.streaming,
      ),
    );

    const assistantMessages = thread.messages.filter(
      (message: ProviderRuntimeTestMessage) =>
        message.turnId === "turn-thinking-disabled" && message.role === "assistant",
    );
    expect(assistantMessages.map((message) => message.text)).toEqual([
      "Before thinking. After thinking.",
    ]);
    const reasoningActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-thinking-disabled-reasoning",
    );
    expect(reasoningActivity?.kind).toBe("task.progress");
  });

  it("splits assistant messages when task progress interrupts the same turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-task-progress-segment-delta-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-progress-segmented"),
      itemId: asItemId("item-task-progress-segmented"),
      payload: {
        streamKind: "assistant_text",
        delta: "Before task progress.",
      },
    });
    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-task-progress-segment-thinking"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-progress-segmented"),
      payload: {
        taskId: "task-progress-segment",
        description: "Thinking through the next tool call.",
        summary: "Thinking through the next tool call.",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-task-progress-segment-delta-2"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-progress-segmented"),
      itemId: asItemId("item-task-progress-segmented"),
      payload: {
        streamKind: "assistant_text",
        delta: "After task progress.",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-task-progress-segment-complete"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-progress-segmented"),
      itemId: asItemId("item-task-progress-segmented"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) => {
      const assistantMessages = entry.messages.filter(
        (message: ProviderRuntimeTestMessage) =>
          message.turnId === "turn-task-progress-segmented" &&
          message.role === "assistant" &&
          !message.streaming,
      );
      return assistantMessages.length >= 2;
    });

    const assistantMessages = thread.messages.filter(
      (message: ProviderRuntimeTestMessage) =>
        message.turnId === "turn-task-progress-segmented" && message.role === "assistant",
    );
    expect(assistantMessages.map((message) => message.text)).toEqual([
      "Before task progress.",
      "After task progress.",
    ]);

    const taskProgressActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.id === "evt-task-progress-segment-thinking",
    );
    expect(taskProgressActivity?.kind).toBe("task.progress");
  });

  it("preserves provider sessionSequence on segmented assistant messages", async () => {
    const harness = await createHarness();
    const baseSequence = 1_706_255_202_000_000;

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-provider-sequence-delta-1"),
      provider: "githubCopilot",
      createdAt: "2026-02-23T10:00:01.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-provider-sequence"),
      itemId: asItemId("item-provider-sequence"),
      sessionSequence: baseSequence + 1,
      payload: {
        streamKind: "assistant_text",
        delta: "Before tool.",
      },
    });
    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-provider-sequence-thinking"),
      provider: "githubCopilot",
      createdAt: "2026-02-23T10:00:02.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-provider-sequence"),
      sessionSequence: baseSequence + 2,
      payload: {
        taskId: "task-provider-sequence",
        description: "Inspecting files before the next step.",
        summary: "Inspecting files before the next step.",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-provider-sequence-delta-2"),
      provider: "githubCopilot",
      createdAt: "2026-02-23T10:00:03.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-provider-sequence"),
      itemId: asItemId("item-provider-sequence"),
      sessionSequence: baseSequence + 3,
      payload: {
        streamKind: "assistant_text",
        delta: "After tool.",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-provider-sequence-complete"),
      provider: "githubCopilot",
      createdAt: "2026-02-23T10:00:04.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-provider-sequence"),
      itemId: asItemId("item-provider-sequence"),
      sessionSequence: baseSequence + 4,
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) => {
      const assistantMessages = entry.messages.filter(
        (message: ProviderRuntimeTestMessage) =>
          message.turnId === "turn-provider-sequence" &&
          message.role === "assistant" &&
          !message.streaming,
      );
      return assistantMessages.length >= 2;
    });

    const assistantMessages = thread.messages.filter(
      (message: ProviderRuntimeTestMessage) =>
        message.turnId === "turn-provider-sequence" && message.role === "assistant",
    );
    expect(assistantMessages.map((message) => message.text)).toEqual([
      "Before tool.",
      "After tool.",
    ]);
    expect(assistantMessages.map((message) => message.sequence)).toEqual([
      baseSequence + 1,
      baseSequence + 3,
    ]);

    const reasoningActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-provider-sequence-thinking",
    );
    expect(reasoningActivity?.sequence).toBe(baseSequence + 2);
  });

  it("uses assistant item completion detail when no assistant deltas were streamed", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-assistant-item-completed-no-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-no-delta"),
      itemId: asItemId("item-no-delta"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "assistant-only final text",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-no-delta" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-no-delta",
    );
    expect(message?.text).toBe("assistant-only final text");
    expect(message?.streaming).toBe(false);
  });

  it("shows generated image starts as assistant placeholders and completes with attachments", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const imageBytes = Buffer.from("generated image bytes");
    const imageDataUrl = `data:image/png;base64,${imageBytes.toString("base64")}`;
    const assistantMessageId = "assistant:image:1536x1024:image-1";

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-image-generation-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-image"),
      itemId: asItemId("image-1"),
      payload: {
        itemType: "assistant_message",
        status: "inProgress",
        title: "Assistant message",
        data: {
          item: {
            type: "imageGeneration",
            id: "image-1",
            size: "1536x1024",
          },
        },
      },
    });

    const placeholderThread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === assistantMessageId && message.streaming,
      ),
    );
    const placeholderMessage = placeholderThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === assistantMessageId,
    );
    expect(placeholderMessage?.text).toBe("");
    expect(placeholderMessage?.attachments).toBeUndefined();
    expect(placeholderThread.activities).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summary: "Image generation",
        }),
      ]),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-image-generation-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-image"),
      itemId: asItemId("image-1"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Assistant message",
        data: {
          item: {
            type: "imageGeneration",
            id: "image-1",
            size: "1536x1024",
            result: imageDataUrl,
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === assistantMessageId &&
          !message.streaming &&
          (message.attachments?.length ?? 0) === 1,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === assistantMessageId,
    );
    const attachment = message?.attachments?.[0];
    expect(message?.text).toBe("");
    expect(attachment).toMatchObject({
      type: "image",
      name: "generated-image.png",
      mimeType: "image/png",
      sizeBytes: imageBytes.byteLength,
    });
    expect(attachment?.id).toMatch(/^thread-1-/);
    const attachmentPath = attachment
      ? resolveAttachmentPath({
          attachmentsDir: harness.serverConfig.attachmentsDir,
          attachment,
        })
      : null;
    expect(attachmentPath).toBeTruthy();
    expect(attachmentPath ? fs.readFileSync(attachmentPath).equals(imageBytes) : false).toBe(true);
  });

  it("starts image placeholders from structured backend tool calls and resolves native completions into them", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const imageBytes = Buffer.from("structured image tool bytes");
    const imageDataUrl = `data:image/png;base64,${imageBytes.toString("base64")}`;
    const assistantMessageId = "assistant:image:1024x1536:tool-image-1";

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-structured-image-tool-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-structured-image"),
      itemId: asItemId("tool-image-1"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "inProgress",
        title: "Tool call",
        data: {
          item: {
            type: "dynamicToolCall",
            id: "tool-image-1",
            tool: "image_generation",
            arguments: {
              size: "1024x1536",
            },
            status: "inProgress",
          },
        },
      },
    });

    const placeholderThread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === assistantMessageId && message.streaming,
      ),
    );
    expect(placeholderThread.activities.some((activity) => activity.summary === "Tool call")).toBe(
      false,
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-structured-image-tool-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-structured-image"),
      itemId: asItemId("tool-image-1"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        title: "Tool call",
        data: {
          item: {
            type: "dynamicToolCall",
            id: "tool-image-1",
            tool: "image_generation",
            arguments: {
              size: "1024x1536",
            },
            status: "completed",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-structured-image-native-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-structured-image"),
      itemId: asItemId("ig-native-1"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Assistant message",
        data: {
          item: {
            type: "imageGeneration",
            id: "ig-native-1",
            size: "1024x1536",
            result: imageDataUrl,
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === assistantMessageId &&
          !message.streaming &&
          (message.attachments?.length ?? 0) === 1,
      ),
    );
    expect(
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:image:1024x1536:ig-native-1",
      ),
    ).toBe(false);
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === assistantMessageId,
    );
    expect(message?.text).toBe("");
    expect(message?.attachments?.[0]).toMatchObject({
      type: "image",
      name: "generated-image.png",
      mimeType: "image/png",
      sizeBytes: imageBytes.byteLength,
    });
  });

  it("starts image placeholders from the built-in image_gen backend tool id", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const assistantMessageId = "assistant:image:1536x1024:tool-image-gen-1";

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-image-gen-tool-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-image-gen-tool"),
      itemId: asItemId("tool-image-gen-1"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "inProgress",
        title: "Tool call",
        data: {
          item: {
            type: "dynamicToolCall",
            id: "tool-image-gen-1",
            tool: "image_gen",
            input: {
              size: "1536x1024",
            },
            status: "inProgress",
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === assistantMessageId && message.streaming,
      ),
    );
    expect(thread.activities.some((activity) => activity.summary === "Tool call")).toBe(false);
  });

  it("starts image placeholders from backend dynamic image prehook requests", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const assistantMessageId = "assistant:image:1536x1024:dyn-image-1";

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-dynamic-image-request-opened"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-dynamic-image-request"),
      payload: {
        requestType: "dynamic_tool_call",
        args: {
          callId: "dyn-image-1",
          tool: "image_generation_prehook",
          arguments: {
            size: "1536x1024",
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === assistantMessageId && message.streaming,
      ),
    );
    expect(thread.activities.some((activity) => activity.summary === "Approval requested")).toBe(
      false,
    );
  });

  it("shows raw generated image completions as assistant attachments without tool activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const imageBytes = Buffer.from("raw generated image bytes ".repeat(4));
    const imageBase64 = imageBytes.toString("base64");
    const assistantMessageId = "assistant:image:1024x1024:ig-raw-1";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-raw-image-generation-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-image"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Assistant message",
        data: {
          threadId: "thread-1",
          turnId: "turn-image",
          item: {
            type: "image_generation_call",
            id: "ig-raw-1",
            status: "completed",
            result: imageBase64,
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === assistantMessageId &&
          !message.streaming &&
          (message.attachments?.length ?? 0) === 1,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === assistantMessageId,
    );
    const attachment = message?.attachments?.[0];
    expect(message?.text).toBe("");
    expect(attachment).toMatchObject({
      type: "image",
      name: "generated-image.png",
      mimeType: "image/png",
      sizeBytes: imageBytes.byteLength,
    });
    expect(thread.activities).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summary: "Image generation",
        }),
      ]),
    );
    const attachmentPath = attachment
      ? resolveAttachmentPath({
          attachmentsDir: harness.serverConfig.attachmentsDir,
          attachment,
        })
      : null;
    expect(attachmentPath).toBeTruthy();
    expect(attachmentPath ? fs.readFileSync(attachmentPath).equals(imageBytes) : false).toBe(true);
  });

  it("projects reasoning item completions into timeline activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-reasoning-complete"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning"),
      itemId: asItemId("reasoning-1"),
      payload: {
        itemType: "reasoning",
        status: "completed",
        title: "Reasoning",
        data: {
          content: "Need to inspect the workspace and then patch the adapter.",
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-reasoning-complete",
      ),
    );
    const reasoningActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-reasoning-complete",
    );

    expect(reasoningActivity?.kind).toBe("reasoning.completed");
    expect(reasoningActivity?.summary).toBe("Reasoning");
    expect(reasoningActivity?.payload).toMatchObject({
      itemType: "reasoning",
      detail: "Need to inspect the workspace and then patch the adapter.",
    });
  });

  it("projects reasoning deltas into streamed progress activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-reasoning-delta"),
      provider: "githubCopilot",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning-stream"),
      itemId: asItemId("reasoning-stream-1"),
      payload: {
        streamKind: "reasoning_text",
        delta: "Inspecting package scripts before running checks.",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-reasoning-delta",
      ),
    );
    const progressActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-reasoning-delta",
    );

    expect(progressActivity?.kind).toBe("task.progress");
    expect(progressActivity?.summary).toBe("Reasoning");
    expect(progressActivity?.payload).toMatchObject({
      taskId: "reasoning:reasoning-stream-1",
      detail: "Inspecting package scripts before running checks.",
    });
  });

  it("coalesces repeated reasoning deltas before persisting buffered activity updates", async () => {
    const harness = await createHarness();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-reasoning-buffer-1"),
      provider: "githubCopilot",
      createdAt: "2026-02-23T10:00:01.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning-buffered"),
      itemId: asItemId("reasoning-buffer-1"),
      payload: {
        streamKind: "reasoning_text",
        delta: "Inspecting",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-reasoning-buffer-2"),
      provider: "githubCopilot",
      createdAt: "2026-02-23T10:00:02.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning-buffered"),
      itemId: asItemId("reasoning-buffer-1"),
      payload: {
        streamKind: "reasoning_text",
        delta: "package.json",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-reasoning-buffer-3"),
      provider: "githubCopilot",
      createdAt: "2026-02-23T10:00:03.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning-buffered"),
      itemId: asItemId("reasoning-buffer-1"),
      payload: {
        streamKind: "reasoning_text",
        delta: "before patching.",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-reasoning-buffer-complete"),
      provider: "githubCopilot",
      createdAt: "2026-02-23T10:00:04.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning-buffered"),
      itemId: asItemId("reasoning-buffer-1"),
      payload: {
        itemType: "reasoning",
        status: "completed",
        title: "Reasoning",
        data: {
          content: "Ready to patch the adapter.",
        },
      },
    });

    await harness.drain();
    const persistence = await harness.readActivityPersistence();
    const [progressRow, completionRow] = persistence.projectionRows.map((row) => ({
      ...row,
      payload: JSON.parse(row.payloadJson) as Record<string, unknown>,
    }));

    expect(persistence.activityEventCount).toBe(3);
    expect(persistence.projectionRows).toEqual([
      {
        activityId: "evt-reasoning-buffer-1",
        kind: "task.progress",
        payloadJson: expect.any(String),
      },
      {
        activityId: "evt-reasoning-buffer-complete",
        kind: "reasoning.completed",
        payloadJson: expect.any(String),
      },
    ]);
    expect(progressRow?.payload).toMatchObject({
      taskId: "reasoning:reasoning-buffer-1",
      detail: "Inspecting package.json before patching.",
    });
    expect(completionRow?.payload).toMatchObject({
      taskId: "reasoning:reasoning-buffer-1",
      detail: "Ready to patch the adapter.",
    });
  });

  it("does not truncate long Copilot reasoning deltas", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const longReasoning =
      "Clarifying development tasks and preserving the user intent while checking the development server path, command plan, and session state before choosing the next tool call in the current turn.";

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-reasoning-delta-long"),
      provider: "githubCopilot",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning-stream-long"),
      itemId: asItemId("reasoning-stream-long-1"),
      payload: {
        streamKind: "reasoning_text",
        delta: longReasoning,
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-reasoning-delta-long",
      ),
    );
    const progressActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-reasoning-delta-long",
    );

    expect(progressActivity?.kind).toBe("task.progress");
    expect(progressActivity?.payload).toMatchObject({
      taskId: "reasoning:reasoning-stream-long-1",
      detail: longReasoning,
    });
  });

  it("projects completed plan items into first-class proposed plans", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-item-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-final"),
      payload: {
        planMarkdown: "## Ship plan\n\n- wire projection\n- render follow-up",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-final",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-plan-final",
    );
    expect(proposedPlan?.planMarkdown).toBe(
      "## Ship plan\n\n- wire projection\n- render follow-up",
    );
  });

  it("marks the source proposed plan implemented only after the target turn starts", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-implement");
    const sourceTurnId = asTurnId("turn-plan-source");
    const targetTurnId = asTurnId("turn-plan-implement");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-source"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-source"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-target"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Target",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-target"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    harness.setProviderSession({
      provider: "codex",
      status: "ready",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: targetTurnId,
    });

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed"),
      provider: "codex",
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan-target"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    const sourceThreadBeforeStart = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id && proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadBeforeStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-plan-target-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: targetThreadId,
      turnId: targetTurnId,
    });

    const sourceThreadAfterStart = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id &&
            proposedPlan.implementedAt !== null &&
            proposedPlan.implementationThreadId === targetThreadId,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadAfterStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementationThreadId: "thread-implement",
    });
  });

  it("does not mark the source proposed plan implemented for a rejected turn.started event", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-1");
    const sourceTurnId = asTurnId("turn-plan-source");
    const activeTurnId = asTurnId("turn-already-running");
    const staleTurnId = asTurnId("turn-stale-start");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-source-guarded"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-source-guarded"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    harness.setProviderSession({
      provider: "codex",
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-already-running"),
      provider: "codex",
      createdAt,
      threadId: targetThreadId,
      turnId: activeTurnId,
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === activeTurnId,
      2_000,
      targetThreadId,
    );

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed-guarded"),
      provider: "codex",
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan-target-guarded"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target-guarded"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-stale-plan-implementation"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: targetThreadId,
      turnId: staleTurnId,
    });

    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const sourceThreadAfterRejectedStart = readModel.threads.find(
      (entry) => entry.id === sourceThreadId,
    );
    expect(
      sourceThreadAfterRejectedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    const targetThreadAfterRejectedStart = readModel.threads.find(
      (entry) => entry.id === targetThreadId,
    );
    expect(targetThreadAfterRejectedStart?.session?.status).toBe("running");
    expect(targetThreadAfterRejectedStart?.session?.activeTurnId).toBe(activeTurnId);
  });

  it("does not mark the source proposed plan implemented for an unrelated turn.started when no thread active turn is tracked", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-implement");
    const sourceTurnId = asTurnId("turn-plan-source");
    const expectedTurnId = asTurnId("turn-plan-implement");
    const replayedTurnId = asTurnId("turn-replayed");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-source-unrelated"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-source-unrelated"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-target-unrelated"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Target",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-target-unrelated"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed-unrelated"),
      provider: "codex",
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan-target-unrelated"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target-unrelated"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    harness.setProviderSession({
      provider: "codex",
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: expectedTurnId,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-unrelated-plan-implementation"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: targetThreadId,
      turnId: replayedTurnId,
    });

    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const sourceThreadAfterUnrelatedStart = readModel.threads.find(
      (entry) => entry.id === sourceThreadId,
    );
    expect(
      sourceThreadAfterUnrelatedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });
  });

  it("finalizes buffered proposed-plan deltas into a first-class proposed plan on turn completion", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-plan-buffer"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-plan-buffer",
    );

    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "## Buffered plan\n\n- first",
      },
    });
    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-2"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "\n- second",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-plan-buffer"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        state: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-buffer",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-1:turn:turn-plan-buffer",
    );
    expect(proposedPlan?.planMarkdown).toBe("## Buffered plan\n\n- first\n- second");
  });

  it("buffers assistant deltas until completion when assistant streaming is disabled", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: false } });
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-buffered",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      payload: {
        streamKind: "assistant_text",
        delta: "buffer me",
      },
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(
      midThread?.messages.some(
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-buffered",
      ),
    ).toBe(false);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered",
    );
    expect(message?.text).toBe("buffer me");
    expect(message?.streaming).toBe(false);
  });

  it("streams assistant deltas when thread.turn.start requests streaming mode", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-streaming-mode"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-streaming-mode"),
          role: "user",
          text: "stream please",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-mode",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello live",
      },
    });

    const liveThread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" &&
          message.streaming &&
          message.text === "hello live",
      ),
    );
    const liveMessage = liveThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(liveMessage?.streaming).toBe(true);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "hello live",
      },
    });

    const finalThread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" && !message.streaming,
      ),
    );
    const finalMessage = finalThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(finalMessage?.text).toBe("hello live");
    expect(finalMessage?.streaming).toBe(false);
  });

  it("flushes small cursor assistant delta batches before turn completion", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = new Date().toISOString();
    const followUpDelta = "x".repeat(120);

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-cursor-streaming"),
      provider: "cursor",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-cursor-streaming"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-cursor-streaming",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-cursor-streaming-1"),
      provider: "cursor",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-cursor-streaming"),
      itemId: asItemId("item-cursor-streaming"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello ",
      },
    });

    await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-cursor-streaming" &&
          message.streaming &&
          message.text === "hello ",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-cursor-streaming-2"),
      provider: "cursor",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-cursor-streaming"),
      itemId: asItemId("item-cursor-streaming"),
      payload: {
        streamKind: "assistant_text",
        delta: followUpDelta,
      },
    });

    const liveThread = await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-cursor-streaming" &&
          message.streaming &&
          message.text === `hello ${followUpDelta}`,
      ),
    );
    const liveMessage = liveThread.messages.find(
      (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-cursor-streaming",
    );
    expect(liveMessage?.streaming).toBe(true);
    expect(liveMessage?.text).toBe(`hello ${followUpDelta}`);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-cursor-streaming"),
      provider: "cursor",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-cursor-streaming"),
      itemId: asItemId("item-cursor-streaming"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const finalThread = await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-cursor-streaming" && !message.streaming,
      ),
    );
    const finalMessage = finalThread.messages.find(
      (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-cursor-streaming",
    );
    expect(finalMessage?.streaming).toBe(false);
    expect(finalMessage?.text).toBe(`hello ${followUpDelta}`);
  });

  it("flushes small non-cursor assistant delta batches before turn completion", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = new Date().toISOString();
    const followUpDelta = "x".repeat(120);

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-batch-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-batch"),
      itemId: asItemId("item-streaming-batch"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello ",
      },
    });

    await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-batch" &&
          message.streaming &&
          message.text === "hello ",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-batch-2"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-batch"),
      itemId: asItemId("item-streaming-batch"),
      payload: {
        streamKind: "assistant_text",
        delta: followUpDelta,
      },
    });

    const liveThread = await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-batch" &&
          message.streaming &&
          message.text === `hello ${followUpDelta}`,
      ),
    );
    const liveMessage = liveThread.messages.find(
      (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-streaming-batch",
    );
    expect(liveMessage?.streaming).toBe(true);
    expect(liveMessage?.text).toBe(`hello ${followUpDelta}`);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-batch"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-batch"),
      itemId: asItemId("item-streaming-batch"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const finalThread = await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-batch" && !message.streaming,
      ),
    );
    const finalMessage = finalThread.messages.find(
      (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-streaming-batch",
    );
    expect(finalMessage?.streaming).toBe(false);
    expect(finalMessage?.text).toBe(`hello ${followUpDelta}`);
  });

  it("keeps follow-up cursor assistant deltas buffered after a threshold flush", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = new Date().toISOString();
    const batchedDelta = "x".repeat(120);
    const bufferedTail = " tail";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-cursor-buffered-tail"),
      provider: "cursor",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-cursor-buffered-tail"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-cursor-buffered-tail",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-cursor-buffered-tail-1"),
      provider: "cursor",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-cursor-buffered-tail"),
      itemId: asItemId("item-cursor-buffered-tail"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello ",
      },
    });

    await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-cursor-buffered-tail" &&
          message.streaming &&
          message.text === "hello ",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-cursor-buffered-tail-2"),
      provider: "cursor",
      createdAt: "2026-03-01T12:00:01.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-cursor-buffered-tail"),
      itemId: asItemId("item-cursor-buffered-tail"),
      payload: {
        streamKind: "assistant_text",
        delta: batchedDelta,
      },
    });

    await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-cursor-buffered-tail" &&
          message.streaming &&
          message.text === `hello ${batchedDelta}`,
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-cursor-buffered-tail-3"),
      provider: "cursor",
      createdAt: "2026-03-01T12:00:02.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-cursor-buffered-tail"),
      itemId: asItemId("item-cursor-buffered-tail"),
      payload: {
        streamKind: "assistant_text",
        delta: bufferedTail,
      },
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find((entry) => entry.id === asThreadId("thread-1"));
    const midMessage = midThread?.messages.find(
      (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-cursor-buffered-tail",
    );
    expect(midMessage?.text).toBe(`hello ${batchedDelta}`);
    expect(midMessage?.streaming).toBe(true);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-cursor-buffered-tail"),
      provider: "cursor",
      createdAt: "2026-03-01T12:00:03.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-cursor-buffered-tail"),
      itemId: asItemId("item-cursor-buffered-tail"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: `hello ${batchedDelta}${bufferedTail}`,
      },
    });

    const finalThread = await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-cursor-buffered-tail" && !message.streaming,
      ),
    );
    const finalMessage = finalThread.messages.find(
      (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-cursor-buffered-tail",
    );
    expect(finalMessage?.text).toBe(`hello ${batchedDelta}${bufferedTail}`);
    expect(finalMessage?.streaming).toBe(false);
  });

  it("spills oversized buffered deltas and still finalizes full assistant text", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const oversizedText = "x".repeat(40_000);

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffer-spill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffer-spill",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffer-spill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        streamKind: "assistant_text",
        delta: oversizedText,
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffer-spill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffer-spill" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffer-spill",
    );
    expect(message?.text.length).toBe(oversizedText.length);
    expect(message?.text).toBe(oversizedText);
    expect(message?.streaming).toBe(false);
  });

  it("does not duplicate assistant completion when item.completed is followed by turn.completed", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-complete-dedup",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        streamKind: "assistant_text",
        delta: "done",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      payload: {
        state: "completed",
      },
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "ready" &&
        thread.session?.activeTurnId === null &&
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-complete-dedup" && !message.streaming,
        ),
    );

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const completionEvents = events.filter((event) => {
      if (event.type !== "thread.message-sent") {
        return false;
      }
      return (
        event.payload.messageId === "assistant:item-complete-dedup" &&
        event.payload.streaming === false
      );
    });
    expect(completionEvents).toHaveLength(1);
  });

  it("maps canonical request events into approval activities with requestKind", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.makeUnsafe("req-open"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    harness.emit({
      type: "request.resolved",
      eventId: asEventId("evt-request-resolved"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.makeUnsafe("req-open"),
      payload: {
        requestType: "command_execution_approval",
        decision: "accept",
      },
    });

    await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.resolved",
        ),
    );

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread).toBeDefined();

    const requested = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-opened",
    );
    const requestedPayload =
      requested?.payload && typeof requested.payload === "object"
        ? (requested.payload as Record<string, unknown>)
        : undefined;
    expect(requestedPayload?.requestKind).toBe("command");
    expect(requestedPayload?.requestType).toBe("command_execution_approval");

    const resolved = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolvedPayload?.requestKind).toBe("command");
    expect(resolvedPayload?.requestType).toBe("command_execution_approval");
  });

  it("maps generic runtime requests into permission approval activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-permission-request-opened"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.makeUnsafe("req-permission"),
      payload: {
        requestType: "dynamic_tool_call",
        detail: "Use Browser Use",
      },
    });

    await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-permission-request-opened",
      ),
    );

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    const requested = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-permission-request-opened",
    );
    const requestedPayload =
      requested?.payload && typeof requested.payload === "object"
        ? (requested.payload as Record<string, unknown>)
        : undefined;

    expect(requested?.summary).toBe("Permission approval requested");
    expect(requestedPayload?.requestKind).toBe("permission");
    expect(requestedPayload?.requestType).toBe("dynamic_tool_call");
  });

  it("maps runtime.error into errored session state", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-3"),
      payload: {
        message: "runtime exploded",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-3" &&
        entry.session?.lastError === "runtime exploded",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime exploded");
  });

  it("keeps the session running when an unscoped runtime.error arrives during an active turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-runtime-error-active-turn-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-runtime-error-active"),
      payload: {},
    });

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-unscoped-active"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        message: "JSON-RPC bridge request failed",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "running" &&
        entry.session?.activeTurnId === "turn-runtime-error-active" &&
        entry.session?.lastError === "JSON-RPC bridge request failed" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) =>
            activity.id === "evt-runtime-error-unscoped-active" &&
            activity.kind === "runtime.error",
        ),
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.activeTurnId).toBe("turn-runtime-error-active");
  });

  it("records runtime.error activities from the typed payload message", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-activity"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-runtime-error-activity"),
      payload: {
        message: "runtime activity exploded",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.id === "evt-runtime-error-activity"),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-runtime-error-activity",
    );
    const activityPayload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(activity?.kind).toBe("runtime.error");
    expect(activityPayload?.provider).toBe("codex");
    expect(activityPayload?.message).toBe("runtime activity exploded");
  });

  it("keeps the session running when a runtime.warning arrives during an active turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-warning-turn-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {},
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-warning-runtime"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {
        message: "Reconnecting... 2/5",
        detail: {
          willRetry: true,
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "running" &&
        entry.session?.activeTurnId === "turn-warning" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) =>
            activity.id === "evt-warning-runtime" && activity.kind === "runtime.warning",
        ),
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.activeTurnId).toBe("turn-warning");
    expect(thread.session?.lastError).toBeNull();
  });

  it("maps session/thread lifecycle and item.started into session/activity projections", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      message: "session started",
    });
    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-tool-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-9"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Read file",
        detail: "/tmp/file.ts",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
        ),
    );

    expect(thread.session?.status).toBe("ready");
    expect(
      thread.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
      ),
    ).toBe(true);
  });

  it("preserves provider-agnostic root subagent metadata on collab tool activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-root-collab-tool-started"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-root-collab"),
      itemId: asItemId("root-collab-tool"),
      payload: {
        itemType: "collab_agent_tool_call",
        status: "in_progress",
        title: "Reviewer",
        detail: "Review this change.",
        subagent: {
          id: "agent-root-tool-1",
          type: "code-reviewer",
          name: "Reviewer",
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "evt-root-collab-tool-started" && activity.kind === "tool.started",
      ),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-root-collab-tool-started",
    );
    expect(activity?.payload).toMatchObject({
      itemType: "collab_agent_tool_call",
      subagent: {
        id: "agent-root-tool-1",
        type: "code-reviewer",
        name: "Reviewer",
      },
    });
  });

  it("consumes P1 runtime events into thread metadata, diff checkpoints, and activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.metadata.updated",
      eventId: asEventId("evt-thread-metadata-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        name: "Renamed by provider",
        metadata: { source: "provider" },
      },
    });

    harness.emit({
      type: "turn.plan.updated",
      eventId: asEventId("evt-turn-plan-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        explanation: "Working through the plan",
        plan: [
          { step: "Inspect files", status: "completed" },
          { step: "Apply patch", status: "in_progress" },
        ],
      },
    });

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-item-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-tool"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run tests",
        detail: "bun test",
        data: { pid: 123 },
      },
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-runtime-warning"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        message: "Provider got slow",
        detail: { latencyMs: 1500 },
      },
    });

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-turn-diff-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-assistant"),
      payload: {
        unifiedDiff: "diff --git a/file.txt b/file.txt\n+hello\n",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.title === "Renamed by provider" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "turn.plan.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "runtime.warning",
        ) &&
        entry.checkpoints.some(
          (checkpoint: ProviderRuntimeTestCheckpoint) => checkpoint.turnId === "turn-p1",
        ),
    );

    expect(thread.title).toBe("Renamed by provider");

    const planActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-turn-plan-updated",
    );
    const planPayload =
      planActivity?.payload && typeof planActivity.payload === "object"
        ? (planActivity.payload as Record<string, unknown>)
        : undefined;
    expect(planActivity?.kind).toBe("turn.plan.updated");
    expect(Array.isArray(planPayload?.plan)).toBe(true);

    const toolUpdate = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-item-updated",
    );
    const toolUpdatePayload =
      toolUpdate?.payload && typeof toolUpdate.payload === "object"
        ? (toolUpdate.payload as Record<string, unknown>)
        : undefined;
    expect(toolUpdate?.kind).toBe("tool.updated");
    expect(toolUpdatePayload?.itemType).toBe("command_execution");
    expect(toolUpdatePayload?.status).toBe("in_progress");

    const warning = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-runtime-warning",
    );
    const warningPayload =
      warning?.payload && typeof warning.payload === "object"
        ? (warning.payload as Record<string, unknown>)
        : undefined;
    expect(warning?.kind).toBe("runtime.warning");
    expect(warningPayload?.provider).toBe("codex");
    expect(warningPayload?.message).toBe("Provider got slow");

    const checkpoint = thread.checkpoints.find(
      (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-p1",
    );
    expect(checkpoint?.status).toBe("missing");
    expect(checkpoint?.assistantMessageId).toBe("assistant:item-p1-assistant");
    expect(checkpoint?.checkpointRef).toBe("provider-diff:evt-turn-diff-updated");
    expect(checkpoint?.files).toEqual([
      { path: "file.txt", kind: "modified", additions: 1, deletions: 0 },
    ]);
    expect(checkpoint?.diff).toBe("diff --git a/file.txt b/file.txt\n+hello\n");
  });

  it("projects context window updates into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 1075,
          totalProcessedTokens: 10_200,
          maxTokens: 128_000,
          inputTokens: 1000,
          cachedInputTokens: 500,
          outputTokens: 50,
          reasoningOutputTokens: 25,
          lastUsedTokens: 1075,
          lastInputTokens: 1000,
          lastCachedInputTokens: 500,
          lastOutputTokens: 50,
          lastReasoningOutputTokens: 25,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity).toBeDefined();
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 1075,
      totalProcessedTokens: 10_200,
      maxTokens: 128_000,
      inputTokens: 1000,
      cachedInputTokens: 500,
      outputTokens: 50,
      reasoningOutputTokens: 25,
      lastUsedTokens: 1075,
      compactsAutomatically: true,
    });
  });

  it("projects token-only usage as an observed context usage activity", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-token-only"),
      provider: "cursor",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 1075,
          lastUsedTokens: 1075,
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 1075,
      lastUsedTokens: 1075,
    });
    expect(
      (usageActivity?.payload as { maxTokens?: unknown } | undefined)?.maxTokens,
    ).toBeUndefined();
  });

  it("projects Codex camelCase token usage payloads into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-camel"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 126,
          totalProcessedTokens: 11_839,
          maxTokens: 258_400,
          inputTokens: 120,
          cachedInputTokens: 0,
          outputTokens: 6,
          reasoningOutputTokens: 0,
          lastUsedTokens: 126,
          lastInputTokens: 120,
          lastCachedInputTokens: 0,
          lastOutputTokens: 6,
          lastReasoningOutputTokens: 0,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 126,
      totalProcessedTokens: 11_839,
      maxTokens: 258_400,
      inputTokens: 120,
      cachedInputTokens: 0,
      outputTokens: 6,
      reasoningOutputTokens: 0,
      lastUsedTokens: 126,
      lastInputTokens: 120,
      lastOutputTokens: 6,
      compactsAutomatically: true,
    });
  });

  it("projects Claude usage snapshots with context window into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-claude-window"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 31_251,
          lastUsedTokens: 31_251,
          maxTokens: 200_000,
          toolUses: 25,
          durationMs: 43_567,
        },
      },
      raw: {
        source: "claude.sdk.message",
        method: "claude/result/success",
        payload: {},
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 31_251,
      lastUsedTokens: 31_251,
      maxTokens: 200_000,
      toolUses: 25,
      durationMs: 43_567,
    });
  });

  it("projects provider MCP status snapshots into thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "mcp.status.updated",
      eventId: asEventId("evt-mcp-status-updated"),
      provider: "opencode",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        status: [
          {
            name: "schema-docs",
            status: "tools_changed",
            reason: "mcp.tools.changed",
          },
        ],
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "mcp.status.updated",
      ),
    );

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.kind === "mcp.status.updated",
    );
    expect(activity?.summary).toBe("MCP status updated");
    expect(activity?.tone).toBe("info");
    expect(activity?.payload).toEqual({
      provider: "opencode",
      status: [
        {
          name: "schema-docs",
          status: "tools_changed",
          reason: "mcp.tools.changed",
        },
      ],
    });
  });

  it("projects provider MCP OAuth completion into thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "mcp.oauth.completed",
      eventId: asEventId("evt-mcp-oauth-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        success: false,
        name: "schema-docs",
        error: "OAuth callback failed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "mcp.oauth.completed",
      ),
    );

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.kind === "mcp.oauth.completed",
    );
    expect(activity?.summary).toBe("MCP OAuth failed");
    expect(activity?.tone).toBe("error");
    expect(activity?.payload).toEqual({
      provider: "codex",
      success: false,
      name: "schema-docs",
      error: "OAuth callback failed",
    });
  });

  it("projects provider health, account, and configuration events into thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "auth.status",
      eventId: asEventId("evt-auth-status"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        isAuthenticating: false,
        error: "OAuth expired",
      },
    });
    harness.emit({
      type: "auth.status",
      eventId: asEventId("evt-auth-status-authenticated"),
      provider: "cursor",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        status: "authenticated",
        label: "dev@cursor.example",
        account: {
          email: "dev@cursor.example",
        },
      },
    });
    harness.emit({
      type: "model.rerouted",
      eventId: asEventId("evt-model-rerouted"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        fromModel: "gpt-5",
        toModel: "gpt-5.4",
        reason: "requested model unavailable",
      },
    });
    harness.emit({
      type: "config.warning",
      eventId: asEventId("evt-config-warning"),
      provider: "pi",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        summary: "Unsupported config key",
        details: "Ignoring unknown config key",
        path: "/repo/pi.json",
      },
    });
    harness.emit({
      type: "account.rate-limits.updated",
      eventId: asEventId("evt-rate-limits"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        rateLimits: {
          status: "limited",
        },
      },
    });

    const expectedKinds = [
      "auth.status",
      "model.rerouted",
      "config.warning",
      "account.rate-limits.updated",
    ];
    const thread = await waitForThread(harness.engine, (entry) =>
      expectedKinds.every((kind) =>
        entry.activities.some((activity: ProviderRuntimeTestActivity) => activity.kind === kind),
      ),
    );

    expect(
      thread.activities
        .filter((activity: ProviderRuntimeTestActivity) => expectedKinds.includes(activity.kind))
        .map((activity: ProviderRuntimeTestActivity) => ({
          kind: activity.kind,
          summary: activity.summary,
          tone: activity.tone,
          payload: activity.payload,
        }))
        .toSorted((left, right) => left.kind.localeCompare(right.kind)),
    ).toEqual([
      {
        kind: "account.rate-limits.updated",
        summary: "Provider rate limits updated",
        tone: "info",
        payload: {
          provider: "claudeAgent",
          rateLimits: {
            status: "limited",
          },
        },
      },
      {
        kind: "auth.status",
        summary: "Provider auth status",
        tone: "error",
        payload: {
          provider: "claudeAgent",
          isAuthenticating: false,
          error: "OAuth expired",
        },
      },
      {
        kind: "auth.status",
        summary: "Provider auth status",
        tone: "info",
        payload: {
          provider: "cursor",
          status: "authenticated",
          label: "dev@cursor.example",
          account: {
            email: "dev@cursor.example",
          },
        },
      },
      {
        kind: "config.warning",
        summary: "Provider configuration warning",
        tone: "info",
        payload: {
          provider: "pi",
          summary: "Unsupported config key",
          details: "Ignoring unknown config key",
          path: "/repo/pi.json",
        },
      },
      {
        kind: "model.rerouted",
        summary: "Model rerouted",
        tone: "info",
        payload: {
          provider: "codex",
          fromModel: "gpt-5",
          toModel: "gpt-5.4",
          reason: "requested model unavailable",
        },
      },
    ]);
  });

  it("projects compacted thread state into context compaction activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.state.changed",
      eventId: asEventId("evt-thread-compacted"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "compacted",
        detail: { source: "provider" },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-compaction",
      ),
    );

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.kind === "context-compaction",
    );
    expect(activity?.summary).toBe("Context compacted");
    expect(activity?.tone).toBe("info");
  });

  it("projects Codex task lifecycle chunks into thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const longCompletedSummary = [
      "<task_result>",
      "Here is a summary of each of the three apps found in `/Users/arpanbhandari/.ace/worktrees/t3code/ace-e825ddd9`.",
      "",
      "## Package 0",
      "The server package owns provider sessions, event ingestion, persistence, and orchestration projection.",
      "The web package owns the chat transcript, event rendering, and reconnect behavior.",
      "The shared packages keep contracts and runtime utilities separate so provider adapters do not leak UI-specific details.",
      "</task_result>",
    ].join("\n");

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-task-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        taskType: "plan",
        description:
          "This task description is intentionally long enough that the old projection truncation would have hidden the end of the text from the expanded Task row in the timeline.",
        subagent: {
          id: "turn-task-1",
          type: "plan",
          name: "Planning side task",
        },
      },
    });

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-task-progress"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        description: "Comparing the desktop rollout chunks to the app-server stream.",
        summary: "Code reviewer is validating the desktop rollout chunks.",
        subagent: {
          id: "turn-task-1",
          type: "plan",
          name: "Planning side task",
        },
      },
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-task-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        status: "completed",
        summary: longCompletedSummary,
        subagent: {
          id: "turn-task-1",
          type: "plan",
          name: "Planning side task",
        },
      },
    });
    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-task-proposed-plan-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        planMarkdown: "# Plan title",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "task.completed",
        ) &&
        entry.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-1:turn:turn-task-1",
        ),
    );

    const started = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-started",
    );
    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-progress",
    );
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-completed",
    );

    const progressPayload =
      progress?.payload && typeof progress.payload === "object"
        ? (progress.payload as Record<string, unknown>)
        : undefined;
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(started?.kind).toBe("task.started");
    expect(started?.summary).toBe("Plan task started");
    expect((started?.payload as { detail?: string } | undefined)?.detail).toContain(
      "hidden the end of the text",
    );
    expect((started?.payload as { subagent?: unknown } | undefined)?.subagent).toEqual({
      id: "turn-task-1",
      type: "plan",
      name: "Planning side task",
    });
    expect(progress?.kind).toBe("task.progress");
    expect(progressPayload?.detail).toBe("Code reviewer is validating the desktop rollout chunks.");
    expect(progressPayload?.summary).toBe(
      "Code reviewer is validating the desktop rollout chunks.",
    );
    expect(progressPayload?.subagent).toEqual({
      id: "turn-task-1",
      type: "plan",
      name: "Planning side task",
    });
    expect(completed?.kind).toBe("task.completed");
    expect(completedPayload?.detail).toBe(longCompletedSummary);
    expect(completedPayload?.detail).toContain("The shared packages keep contracts");
    expect(completedPayload?.detail).not.toContain("...");
    expect(completedPayload?.subagent).toEqual({
      id: "turn-task-1",
      type: "plan",
      name: "Planning side task",
    });
    expect(
      thread.proposedPlans.find(
        (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-task-1",
      )?.planMarkdown,
    ).toBe("# Plan title");
  });

  it("projects provider hook lifecycle chunks into thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "hook.started",
      eventId: asEventId("evt-hook-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-hook-1"),
      payload: {
        hookId: "hook-run-1",
        hookName: "command",
        hookEvent: "PreToolUse",
      },
    });

    harness.emit({
      type: "hook.progress",
      eventId: asEventId("evt-hook-progress"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-hook-1"),
      payload: {
        hookId: "hook-run-1",
        stdout: "checking command safety",
      },
    });

    harness.emit({
      type: "hook.completed",
      eventId: asEventId("evt-hook-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-hook-1"),
      payload: {
        hookId: "hook-run-1",
        outcome: "error",
        stderr: "blocked unsafe command",
        exitCode: 2,
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-hook-completed",
      ),
    );

    const started = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-hook-started",
    );
    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-hook-progress",
    );
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-hook-completed",
    );

    expect(started).toMatchObject({
      kind: "hook.started",
      tone: "tool",
      summary: "Hook started: command",
      payload: {
        hookId: "hook-run-1",
        hookName: "command",
        hookEvent: "PreToolUse",
      },
    });
    expect(progress).toMatchObject({
      kind: "hook.progress",
      tone: "tool",
      summary: "Hook output",
      payload: {
        hookId: "hook-run-1",
        detail: "checking command safety",
        stdout: "checking command safety",
      },
    });
    expect(completed).toMatchObject({
      kind: "hook.completed",
      tone: "error",
      summary: "Hook failed",
      payload: {
        hookId: "hook-run-1",
        outcome: "error",
        detail: "blocked unsafe command",
        stderr: "blocked unsafe command",
        exitCode: 2,
      },
    });
  });

  it("projects structured user input request and resolution as thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-user-input-requested"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
      },
    });

    harness.emit({
      type: "user-input.resolved",
      eventId: asEventId("evt-user-input-resolved"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.resolved",
        ),
    );

    const requested = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-requested",
    );
    expect(requested?.kind).toBe("user-input.requested");

    const resolved = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolved?.kind).toBe("user-input.resolved");
    expect(resolvedPayload?.answers).toEqual({
      sandbox_mode: "workspace-write",
    });
  });

  it("continues processing runtime events after a single event handler failure", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-invalid-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-invalid"),
      itemId: asItemId("item-invalid"),
      payload: {
        streamKind: "assistant_text",
        delta: undefined,
      },
    } as unknown as ProviderRuntimeEvent);

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-after-failure"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-after-failure"),
      payload: {
        message: "runtime still processed",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-after-failure" &&
        entry.session?.lastError === "runtime still processed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime still processed");
  });
});
