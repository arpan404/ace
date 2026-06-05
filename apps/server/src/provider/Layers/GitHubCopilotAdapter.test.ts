import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AssistantMessageEvent,
  GetAuthStatusResponse,
  ModelInfo,
  ResumeSessionConfig,
  SessionEvent,
  SessionConfig,
} from "@github/copilot-sdk";
import { ApprovalRequestId, type ProviderSlashCommand, ThreadId } from "@ace/contracts";
import { assert, it } from "@effect/vitest";
import { afterEach, vi } from "vitest";
import { Effect, Fiber, Layer, Stream } from "effect";

vi.mock("../githubCopilotSdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../githubCopilotSdk")>();
  return {
    ...actual,
    createGitHubCopilotClient: vi.fn(),
  };
});

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  createGitHubCopilotClient,
  type GitHubCopilotClientLike,
  type GitHubCopilotSessionClient,
} from "../githubCopilotSdk";
import { GitHubCopilotAdapter } from "../Services/GitHubCopilotAdapter.ts";
import { makeGitHubCopilotAdapterLive } from "./GitHubCopilotAdapter.ts";

const mockedCreateGitHubCopilotClient = vi.mocked(createGitHubCopilotClient);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

type FakeStartConfig = SessionConfig;

function makeFakeClient(options: {
  readonly models: ReadonlyArray<ModelInfo>;
  readonly disconnect?: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly send?: ReturnType<typeof vi.fn<(input: unknown) => Promise<string>>>;
  readonly abort?: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly modeSet?: ReturnType<
    typeof vi.fn<(input: { readonly mode: "interactive" | "plan" | "autopilot" }) => Promise<void>>
  >;
  readonly agentSelect?: ReturnType<
    typeof vi.fn<
      (input: { readonly name: string }) => Promise<{
        readonly agent: {
          readonly name: string;
          readonly displayName: string;
          readonly description: string;
        };
      }>
    >
  >;
  readonly planRead?: ReturnType<
    typeof vi.fn<() => Promise<{ exists: boolean; content: string | null; path: string | null }>>
  >;
  readonly workspacePath?: string;
  readonly forkSession?: ReturnType<
    typeof vi.fn<(input: { readonly sessionId: string }) => Promise<{ readonly sessionId: string }>>
  >;
  readonly forkSessionShape?: "rpc.sessions.fork" | "rpc.session.forkSession";
  readonly stop?: ReturnType<typeof vi.fn<() => Promise<ReadonlyArray<Error>>>>;
  readonly forceStop?: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly getAuthStatus?: ReturnType<typeof vi.fn<() => Promise<GetAuthStatusResponse>>>;
}): GitHubCopilotClientLike & {
  readonly createSession: ReturnType<
    typeof vi.fn<(config: FakeStartConfig) => Promise<GitHubCopilotSessionClient>>
  >;
  readonly resumeSession: ReturnType<
    typeof vi.fn<
      (sessionId: string, config: ResumeSessionConfig) => Promise<GitHubCopilotSessionClient>
    >
  >;
  readonly stop: ReturnType<typeof vi.fn<() => Promise<ReadonlyArray<Error>>>>;
  readonly emitSessionEvent: (event: SessionEvent) => void;
} {
  const assistantMessageEvent: AssistantMessageEvent = {
    id: "assistant-message-1",
    type: "assistant.message",
    timestamp: new Date().toISOString(),
    parentId: null,
    data: {
      messageId: "assistant-message-1",
      content: "ok",
    },
  };
  const sessionListeners: Array<(event: SessionEvent) => void> = [];
  const stop = options.stop ?? vi.fn(async (): Promise<ReadonlyArray<Error>> => []);
  const forceStop = options.forceStop ?? vi.fn(async () => undefined);

  const createSession = vi.fn(
    async (config: FakeStartConfig): Promise<GitHubCopilotSessionClient> => {
      const disconnect = options.disconnect
        ? vi.fn(async () => options.disconnect?.())
        : vi.fn(async () => undefined);
      const send = options.send
        ? vi.fn(async (input: unknown) => options.send?.(input) ?? "message-1")
        : vi.fn(async () => "message-1");
      const abort = options.abort
        ? vi.fn(async () => options.abort?.())
        : vi.fn(async () => undefined);
      const planRead =
        options.planRead ??
        vi.fn(async () => ({
          exists: false,
          content: null,
          path: options.workspacePath ? `${options.workspacePath}/plan.md` : null,
        }));
      const modeSet =
        options.modeSet ??
        vi.fn(async (input: { readonly mode: "interactive" | "plan" | "autopilot" }) => {
          void input;
        });
      const agentSelect =
        options.agentSelect ??
        vi.fn(async (input: { readonly name: string }) => ({
          agent: {
            name: input.name,
            displayName: input.name,
            description: "",
          },
        }));

      return {
        sessionId: "copilot-session-1",
        ...(options.workspacePath ? { workspacePath: options.workspacePath } : {}),
        rpc: {
          mode: {
            set: modeSet,
          },
          plan: {
            read: planRead,
          },
          agent: {
            select: agentSelect,
            deselect: vi.fn(async () => undefined),
          },
        },
        on: vi.fn((listener: (event: SessionEvent) => void) => {
          sessionListeners.push(listener);
          return () => {
            const index = sessionListeners.indexOf(listener);
            if (index >= 0) {
              sessionListeners.splice(index, 1);
            }
          };
        }),
        disconnect,
        send,
        sendAndWait: vi.fn(async () => assistantMessageEvent),
        abort,
        ...config,
      };
    },
  );

  const client = {
    listModels: vi.fn(async () => options.models),
    createSession,
    resumeSession: vi.fn(async (_sessionId: string, _config: ResumeSessionConfig) => {
      throw new Error("resumeSession should not be called in this test");
    }),
    getStatus: vi.fn(async () => ({ version: "test", protocolVersion: 1 })),
    getAuthStatus:
      options.getAuthStatus ?? vi.fn(async () => ({ isAuthenticated: true, statusMessage: "ok" })),
    stop,
    forceStop,
    emitSessionEvent: (event: SessionEvent) => {
      for (const listener of sessionListeners) {
        listener(event);
      }
    },
  };
  if (options.forkSession && options.forkSessionShape !== "rpc.session.forkSession") {
    return {
      ...client,
      rpc: {
        sessions: {
          fork: options.forkSession,
        },
      },
    };
  }
  if (options.forkSession) {
    return {
      ...client,
      rpc: {
        session: {
          forkSession: options.forkSession,
        },
      },
    } as unknown as ReturnType<typeof makeFakeClient>;
  }
  return client;
}

afterEach(() => {
  mockedCreateGitHubCopilotClient.mockReset();
});

const layer = it.layer(
  makeGitHubCopilotAdapterLive().pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const fastTimeoutLayer = it.layer(
  makeGitHubCopilotAdapterLive({
    timeouts: {
      sendMs: 25,
      inactivityMs: 40,
      stopMs: 10,
      abortMs: 10,
    },
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("GitHubCopilotAdapterLive startSession", (it) => {
  it.effect("emits replay fork capabilities when the Copilot SDK cannot fork sessions", () =>
    Effect.gen(function* () {
      const fakeClient = makeFakeClient({
        models: [],
      });
      mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

      const adapter = yield* GitHubCopilotAdapter;
      const threadId = asThreadId("thread-copilot-replay-fork-capability");
      const configuredFiber = yield* Stream.runHead(
        Stream.filter(
          adapter.streamEvents,
          (event) => event.threadId === threadId && event.type === "session.configured",
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId,
        cwd: "/repo",
        runtimeMode: "approval-required",
      });

      const configuredEvent = yield* Fiber.join(configuredFiber);
      assert.equal(configuredEvent._tag, "Some");
      if (configuredEvent._tag !== "Some") {
        return;
      }
      assert.equal(configuredEvent.value.type, "session.configured");
      if (configuredEvent.value.type !== "session.configured") {
        return;
      }
      assert.deepEqual(configuredEvent.value.payload.config.capabilities, {
        sessionResumeMode: "native",
        sessionForkMode: "local-replay",
        sideConversationMode: "replay-fork",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("emits native fork capabilities when the Copilot SDK can fork sessions", () =>
    Effect.gen(function* () {
      const forkSession = vi.fn(async (_input: { readonly sessionId: string }) => ({
        sessionId: "copilot-forked-session",
      }));
      const fakeClient = makeFakeClient({
        models: [],
        forkSession,
      });
      mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

      const adapter = yield* GitHubCopilotAdapter;
      const threadId = asThreadId("thread-copilot-native-fork-capability");
      const configuredFiber = yield* Stream.runHead(
        Stream.filter(
          adapter.streamEvents,
          (event) => event.threadId === threadId && event.type === "session.configured",
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId,
        cwd: "/repo",
        runtimeMode: "approval-required",
      });

      const configuredEvent = yield* Fiber.join(configuredFiber);
      assert.equal(configuredEvent._tag, "Some");
      if (configuredEvent._tag !== "Some") {
        return;
      }
      assert.equal(configuredEvent.value.type, "session.configured");
      if (configuredEvent.value.type !== "session.configured") {
        return;
      }
      assert.deepEqual(configuredEvent.value.payload.config.capabilities, {
        sessionResumeMode: "native",
        sessionForkMode: "native",
        sideConversationMode: "native-fork",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("emits native fork capabilities for newer Copilot ACP fork spellings", () =>
    Effect.gen(function* () {
      const forkSession = vi.fn(async (_input: { readonly sessionId: string }) => ({
        sessionId: "copilot-forked-session",
      }));
      const fakeClient = makeFakeClient({
        models: [],
        forkSession,
        forkSessionShape: "rpc.session.forkSession",
      });
      mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

      const adapter = yield* GitHubCopilotAdapter;
      const threadId = asThreadId("thread-copilot-native-fork-session-spelling");
      const configuredFiber = yield* Stream.runHead(
        Stream.filter(
          adapter.streamEvents,
          (event) => event.threadId === threadId && event.type === "session.configured",
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId,
        cwd: "/repo",
        runtimeMode: "approval-required",
      });

      const configuredEvent = yield* Fiber.join(configuredFiber);
      assert.equal(configuredEvent._tag, "Some");
      if (configuredEvent._tag !== "Some") {
        return;
      }
      assert.equal(configuredEvent.value.type, "session.configured");
      if (configuredEvent.value.type !== "session.configured") {
        return;
      }
      assert.deepEqual(configuredEvent.value.payload.config.capabilities, {
        sessionResumeMode: "native",
        sessionForkMode: "native",
        sideConversationMode: "native-fork",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("emits Copilot SDK auth status when a session starts", () =>
    Effect.gen(function* () {
      const getAuthStatus = vi.fn(async () => ({
        isAuthenticated: true,
        authType: "user" as const,
        login: "dev@github.example",
        statusMessage: "Logged in as dev@github.example",
      }));
      const fakeClient = makeFakeClient({
        models: [],
        getAuthStatus,
      });
      mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

      const adapter = yield* GitHubCopilotAdapter;
      const threadId = asThreadId("thread-copilot-auth-status");
      const authStatusFiber = yield* Stream.runHead(
        Stream.filter(
          adapter.streamEvents,
          (event) => event.threadId === threadId && event.type === "auth.status",
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId,
        cwd: "/repo",
        runtimeMode: "approval-required",
      });

      const authStatusEvent = yield* Fiber.join(authStatusFiber);
      assert.equal(authStatusEvent._tag, "Some");
      if (authStatusEvent._tag !== "Some" || authStatusEvent.value.type !== "auth.status") {
        return;
      }
      assert.deepEqual(authStatusEvent.value.payload, {
        isAuthenticating: false,
        status: "authenticated",
        label: "dev@github.example",
        account: {
          type: "user",
          login: "dev@github.example",
        },
        output: ["Logged in as dev@github.example"],
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("loads installed Copilot plugin directories into the runtime", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        mkdtemp(path.join(tmpdir(), "ace-copilot-runtime-plugins-")),
      );
      try {
        const copilotHome = path.join(root, ".copilot");
        const releasePlugin = path.join(
          copilotHome,
          "installed-plugins",
          "_direct",
          "release-tools",
        );
        const skillOnlyPlugin = path.join(copilotHome, "plugins", "skill-only-plugin");
        yield* Effect.promise(() => mkdir(releasePlugin, { recursive: true }));
        yield* Effect.promise(() =>
          writeFile(
            path.join(releasePlugin, "plugin.json"),
            JSON.stringify({ name: "release-tools" }),
          ),
        );
        yield* Effect.promise(() => mkdir(skillOnlyPlugin, { recursive: true }));
        yield* Effect.promise(() =>
          writeFile(
            path.join(skillOnlyPlugin, "SKILL.md"),
            [
              "---",
              "name: skill-only-review",
              "description: Review through a skill-only plugin",
              "---",
              "",
              "# Skill-only review",
            ].join("\n"),
          ),
        );

        const fakeClient = makeFakeClient({ models: [] });
        mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

        const settingsService = yield* ServerSettingsService;
        yield* settingsService.updateSettings({
          providers: {
            githubCopilot: {
              homePath: copilotHome,
            },
          },
        });

        const adapter = yield* GitHubCopilotAdapter;
        const threadId = asThreadId("thread-copilot-runtime-plugins");
        yield* adapter.startSession({
          provider: "githubCopilot",
          threadId,
          cwd: root,
          runtimeMode: "approval-required",
        });

        assert.deepEqual(mockedCreateGitHubCopilotClient.mock.calls[0]?.[1], {
          cliArgs: ["--plugin-dir", releasePlugin, "--plugin-dir", skillOnlyPlugin],
        });

        yield* adapter.stopSession(threadId);
      } finally {
        yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
      }
    }),
  );

  it.effect("syncs Ace Plan mode to the Copilot native session mode before sending", () =>
    Effect.gen(function* () {
      const modeSet = vi.fn(
        async (input: { readonly mode: "interactive" | "plan" | "autopilot" }) => {
          void input;
        },
      );
      const send = vi.fn(async (_input: unknown) => "message-1");
      const fakeClient = makeFakeClient({
        models: [],
        modeSet,
        send,
      });
      mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

      const adapter = yield* GitHubCopilotAdapter;
      const threadId = asThreadId("thread-copilot-plan-mode-sync");

      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId,
        cwd: "/repo",
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({
        threadId,
        interactionMode: "plan",
        input: "Create the implementation plan.",
      });

      assert.deepEqual(
        modeSet.mock.calls.map(([input]) => input.mode),
        ["interactive", "plan"],
      );
      assert.deepEqual(send.mock.calls[0]?.[0], {
        prompt: "Create the implementation plan.",
      });
    }),
  );

  it.effect("drops pending approval requests once the turn completes", () =>
    Effect.gen(function* () {
      const fakeClient = makeFakeClient({
        models: [],
      });
      mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

      const adapter = yield* GitHubCopilotAdapter;
      const threadId = asThreadId("thread-copilot-stale-approval");
      const openedRequestFiber = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(
            adapter.streamEvents,
            (event) => event.threadId === threadId && event.type === "request.opened",
          ),
          1,
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId,
        cwd: "/repo",
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Run a shell command that needs approval.",
      });

      const createConfig = fakeClient.createSession.mock.calls[0]?.[0];
      assert.equal(typeof createConfig?.onPermissionRequest, "function");

      const permissionRequestPromise = createConfig?.onPermissionRequest(
        {
          kind: "shell",
          fullCommandText: "ls -la",
          intention: "List repository files.",
          canOfferSessionApproval: true,
          commands: [{ identifier: "ls", readOnly: true }],
          hasWriteFileRedirection: false,
          possiblePaths: [],
          possibleUrls: [],
        } as SessionEvent["data"] extends { permissionRequest: infer T } ? T : never,
        { sessionId: "copilot-session-1" },
      );

      const openedRequests = Array.from(yield* Fiber.join(openedRequestFiber));
      const openedRequest = openedRequests[0];
      assert.equal(openedRequest?.type, "request.opened");
      if (!openedRequest || openedRequest.type !== "request.opened") {
        return;
      }
      if (!openedRequest.requestId) {
        return;
      }

      fakeClient.emitSessionEvent({
        id: "event-session-idle-stale-approval",
        type: "session.idle",
        timestamp: "2024-01-01T00:00:05.000Z",
        parentId: null,
        ephemeral: true,
        data: {},
      });

      const responseExit = yield* Effect.exit(
        adapter.respondToRequest(
          threadId,
          ApprovalRequestId.makeUnsafe(openedRequest.requestId),
          "accept",
        ),
      );
      assert.equal(responseExit._tag, "Failure");

      if (permissionRequestPromise) {
        void Promise.resolve(permissionRequestPromise).catch(() => undefined);
      }
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("round-trips structured user input requests through the adapter", () =>
    Effect.gen(function* () {
      const fakeClient = makeFakeClient({
        models: [],
      });
      mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

      const adapter = yield* GitHubCopilotAdapter;
      const threadId = asThreadId("thread-copilot-user-input");
      const userInputRequestedFiber = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(
            adapter.streamEvents,
            (event) => event.threadId === threadId && event.type === "user-input.requested",
          ),
          1,
        ),
      ).pipe(Effect.forkChild);
      const userInputResolvedFiber = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(
            adapter.streamEvents,
            (event) => event.threadId === threadId && event.type === "user-input.resolved",
          ),
          1,
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId,
        cwd: "/repo",
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Ask the user how to proceed.",
      });

      const createConfig = fakeClient.createSession.mock.calls[0]?.[0];
      assert.equal(typeof createConfig?.onUserInputRequest, "function");

      const userInputPromise = Promise.resolve(
        createConfig?.onUserInputRequest?.(
          {
            question: "How should we proceed?",
            choices: ["Retry reading files", "Show local commands", "Stop"],
            allowFreeform: true,
          },
          { sessionId: "copilot-session-1" },
        ),
      );

      const requested = Array.from(yield* Fiber.join(userInputRequestedFiber))[0];
      assert.equal(requested?.type, "user-input.requested");
      if (!requested || requested.type !== "user-input.requested") {
        return;
      }
      if (!requested.requestId) {
        return;
      }

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.makeUnsafe(requested.requestId),
        { response: "Retry reading files" },
      );

      const resolved = Array.from(yield* Fiber.join(userInputResolvedFiber))[0];
      assert.equal(resolved?.type, "user-input.resolved");
      if (!resolved || resolved.type !== "user-input.resolved") {
        return;
      }

      const response = yield* Effect.promise(() => userInputPromise);
      assert.deepEqual(response, {
        answer: "Retry reading files",
        wasFreeform: false,
      });
      assert.deepEqual(resolved.payload.answers, {
        response: "Retry reading files",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "passes reasoning effort during startup when the selected Copilot model supports it",
    () =>
      Effect.gen(function* () {
        const fakeClient = makeFakeClient({
          models: [
            {
              id: "gpt-5",
              name: "GPT-5",
              capabilities: {
                supports: {
                  vision: false,
                  reasoningEffort: true,
                },
                limits: {
                  max_context_window_tokens: 200_000,
                },
              },
              supportedReasoningEfforts: ["medium", "high", "xhigh"],
              defaultReasoningEffort: "high",
            },
          ],
        });
        mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

        const adapter = yield* GitHubCopilotAdapter;
        const session = yield* adapter.startSession({
          provider: "githubCopilot",
          threadId: asThreadId("thread-supported"),
          cwd: "/repo",
          modelSelection: {
            provider: "githubCopilot",
            model: "gpt-5",
            options: {
              reasoningEffort: "xhigh",
            },
          },
          runtimeMode: "full-access",
        });

        assert.equal(session.model, "gpt-5");
        const createConfig = fakeClient.createSession.mock.calls[0]?.[0];
        assert.equal(typeof createConfig?.onPermissionRequest, "function");
        assert.equal(typeof createConfig?.onUserInputRequest, "function");
        assert.equal(createConfig?.model, "gpt-5");
        assert.equal(createConfig?.reasoningEffort, "xhigh");
        assert.equal(createConfig?.workingDirectory, "/repo");
        assert.equal(createConfig?.streaming, true);

        yield* adapter.stopSession(asThreadId("thread-supported"));
      }),
  );

  it.effect(
    "omits reasoning effort during startup when the selected Copilot model does not support it",
    () =>
      Effect.gen(function* () {
        const fakeClient = makeFakeClient({
          models: [
            {
              id: "gpt-4.1",
              name: "GPT-4.1",
              capabilities: {
                supports: {
                  vision: false,
                  reasoningEffort: false,
                },
                limits: {
                  max_context_window_tokens: 128_000,
                },
              },
            },
          ],
        });
        mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

        const adapter = yield* GitHubCopilotAdapter;
        const session = yield* adapter.startSession({
          provider: "githubCopilot",
          threadId: asThreadId("thread-unsupported"),
          cwd: "/repo",
          modelSelection: {
            provider: "githubCopilot",
            model: "gpt-4.1",
            options: {
              reasoningEffort: "high",
            },
          },
          runtimeMode: "full-access",
        });

        assert.equal(session.model, "gpt-4.1");
        const createConfig = fakeClient.createSession.mock.calls[0]?.[0];
        assert.equal(typeof createConfig?.onPermissionRequest, "function");
        assert.equal(typeof createConfig?.onUserInputRequest, "function");
        assert.equal(createConfig?.model, "gpt-4.1");
        assert.equal("reasoningEffort" in (createConfig ?? {}), false);
        assert.equal(createConfig?.workingDirectory, "/repo");
        assert.equal(createConfig?.streaming, true);

        yield* adapter.stopSession(asThreadId("thread-unsupported"));
      }),
  );

  it.effect("passes repository custom agents to Copilot session startup", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() =>
        mkdtemp(path.join(tmpdir(), "ace-copilot-custom-agents-")),
      );
      const copilotHome = path.join(repo, ".copilot");
      try {
        yield* Effect.promise(() =>
          mkdir(path.join(repo, ".github", "agents"), { recursive: true }),
        );
        yield* Effect.promise(() =>
          mkdir(path.join(repo, ".github", "chatmodes"), { recursive: true }),
        );
        yield* Effect.promise(() => mkdir(path.join(repo, ".vscode"), { recursive: true }));
        yield* Effect.promise(() =>
          writeFile(
            path.join(repo, ".vscode", "settings.json"),
            JSON.stringify({
              "chat.useCustomAgentHooks": true,
            }),
          ),
        );
        yield* Effect.promise(() =>
          writeFile(
            path.join(repo, ".vscode", "mcp.json"),
            JSON.stringify({
              servers: {
                fetch: {
                  type: "stdio",
                  command: "uvx",
                  args: ["mcp-server-fetch"],
                  tools: ["fetch"],
                },
              },
            }),
          ),
        );
        yield* Effect.promise(() =>
          writeFile(
            path.join(repo, ".github", "mcp.json"),
            JSON.stringify({
              mcpServers: {
                docs: {
                  type: "http",
                  url: "https://repo.example.test/mcp",
                  tools: ["search"],
                },
              },
            }),
          ),
        );
        yield* Effect.promise(() =>
          mkdir(path.join(repo, ".github", "skills", "repo-review"), {
            recursive: true,
          }),
        );
        yield* Effect.promise(() =>
          mkdir(path.join(repo, ".github-copilot", "skills", "release-review"), {
            recursive: true,
          }),
        );
        yield* Effect.promise(() =>
          mkdir(path.join(copilotHome, "agents"), {
            recursive: true,
          }),
        );
        yield* Effect.promise(() =>
          mkdir(path.join(copilotHome, "skills", "personal-review"), {
            recursive: true,
          }),
        );
        yield* Effect.promise(() =>
          writeFile(
            path.join(repo, ".github", "agents", "security-auditor.agent.md"),
            [
              "---",
              "name: Security Auditor",
              "description: Reviews code for security issues",
              "argument-hint: <risk area>",
              "agents: [programmatic-researcher]",
              "model: Claude Sonnet 4.5",
              "metadata:",
              "  team: AppSec",
              "  runbook: security-review",
              "  ignoredNumber: 42",
              "handoffs:",
              "  - label: Ask Researcher",
              "    agent: programmatic-researcher",
              "    prompt: Research the risky area.",
              "    send: true",
              "hooks:",
              "  postToolUse:",
              "    - type: command",
              "      command: ./scripts/format-changed-files.sh",
              "      timeout: 15",
              "skills:",
              "  - release-review",
              "tools: [read_file, grep]",
              "infer: false",
              "---",
              "",
              "Inspect code for vulnerabilities and report concrete risks.",
            ].join("\n"),
          ),
        );
        yield* Effect.promise(() =>
          writeFile(
            path.join(copilotHome, "agents", "personal-reviewer.agent.md"),
            [
              "---",
              "description: Reviews user-level tasks",
              "---",
              "",
              "Review the request using the user's personal workflow.",
            ].join("\n"),
          ),
        );
        yield* Effect.promise(() =>
          writeFile(
            path.join(repo, ".github", "agents", "schema-explorer.agent.md"),
            [
              "---",
              "description: Explores schema docs with a dedicated MCP server",
              'mcpServers: {"schema-docs":{"type":"http","url":"https://docs.example.test/mcp","tools":["search"],"headers":{"X-Team":"Schema"}}}',
              "---",
              "",
              "Explore schema documentation before implementation.",
            ].join("\n"),
          ),
        );
        yield* Effect.promise(() =>
          writeFile(
            path.join(repo, ".github", "agents", "programmatic-researcher.agent.md"),
            [
              "---",
              "description: Researches implementation context programmatically",
              "tools: []",
              "disable-model-invocation: true",
              "user-invocable: false",
              'mcp-servers: {"local-docs":{"type":"stdio","command":"docs-mcp","args":["--stdio"],"tools":["search"]}}',
              "---",
              "",
              "Research implementation details without direct user invocation.",
            ].join("\n"),
          ),
        );
        yield* Effect.promise(() =>
          writeFile(
            path.join(repo, ".github", "chatmodes", "planning.chatmode.md"),
            [
              "---",
              "description: Plan work before implementation",
              "tools: [read_file]",
              "---",
              "",
              "Plan implementation options before editing.",
            ].join("\n"),
          ),
        );
        yield* Effect.promise(() =>
          writeFile(
            path.join(repo, ".github", "agents", "missing-description.agent.md"),
            [
              "---",
              "name: Missing Description",
              "target: github-copilot",
              "---",
              "",
              "This malformed custom agent is missing GitHub Copilot's required description.",
            ].join("\n"),
          ),
        );
        yield* Effect.promise(() =>
          writeFile(
            path.join(repo, ".github", "skills", "repo-review", "SKILL.md"),
            ["# Repo Review", "", "Use this skill for repository-level review context."].join("\n"),
          ),
        );
        yield* Effect.promise(() =>
          writeFile(
            path.join(repo, ".github-copilot", "skills", "release-review", "SKILL.md"),
            [
              "# Release Review",
              "",
              "Use this skill to inspect release notes, migration notes, and rollout risks.",
            ].join("\n"),
          ),
        );
        yield* Effect.promise(() =>
          writeFile(
            path.join(copilotHome, "skills", "personal-review", "SKILL.md"),
            ["# Personal Review", "", "Use this skill for personal review preferences."].join("\n"),
          ),
        );

        const fakeClient = makeFakeClient({
          models: [],
        });
        mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

        const settingsService = yield* ServerSettingsService;
        yield* settingsService.updateSettings({
          providers: {
            githubCopilot: {
              homePath: copilotHome,
            },
          },
        });

        const adapter = yield* GitHubCopilotAdapter;
        const threadId = asThreadId("thread-copilot-custom-agents");
        const lifecycleEventsFiber = yield* Stream.runCollect(
          Stream.take(
            Stream.filter(
              adapter.streamEvents,
              (event) =>
                event.threadId === threadId &&
                (event.type === "session.configured" || event.type === "mcp.status.updated"),
            ),
            2,
          ),
        ).pipe(Effect.forkChild);
        yield* adapter.startSession({
          provider: "githubCopilot",
          threadId,
          cwd: repo,
          runtimeMode: "full-access",
          modelSelection: {
            provider: "githubCopilot",
            model: "gpt-5",
            options: {
              agent: "security-auditor",
            },
          },
        });

        const createConfig = fakeClient.createSession.mock.calls[0]?.[0] as
          | (FakeStartConfig & {
              readonly customAgents?: ReadonlyArray<{
                readonly name: string;
                readonly displayName?: string | undefined;
                readonly description?: string | undefined;
                readonly argumentHint?: string | undefined;
                readonly agents?: ReadonlyArray<string> | undefined;
                readonly model?: string | ReadonlyArray<string> | undefined;
                readonly metadata?: Record<string, string> | undefined;
                readonly handoffs?:
                  | ReadonlyArray<{
                      readonly label?: string | undefined;
                      readonly agent?: string | undefined;
                      readonly prompt?: string | undefined;
                      readonly send?: boolean | undefined;
                      readonly model?: string | undefined;
                    }>
                  | undefined;
                readonly hooks?: Record<string, ReadonlyArray<Record<string, unknown>>> | undefined;
                readonly skills?: ReadonlyArray<string> | undefined;
                readonly tools?: ReadonlyArray<string> | null | undefined;
                readonly infer?: boolean | undefined;
                readonly mcpServers?: Record<string, unknown> | undefined;
                readonly prompt: string;
              }>;
              readonly enableConfigDiscovery?: boolean;
              readonly agent?: string;
              readonly mcpServers?: Record<string, unknown> | undefined;
              readonly skillDirectories?: ReadonlyArray<string>;
            })
          | undefined;
        assert.deepEqual(createConfig?.customAgents as unknown, [
          {
            name: "programmatic-researcher",
            description: "Researches implementation context programmatically",
            tools: [],
            infer: false,
            disableModelInvocation: true,
            mcpServers: {
              "local-docs": {
                type: "local",
                command: "docs-mcp",
                args: ["--stdio"],
                tools: ["search"],
              },
            },
            prompt: "Research implementation details without direct user invocation.",
          },
          {
            name: "schema-explorer",
            description: "Explores schema docs with a dedicated MCP server",
            mcpServers: {
              "schema-docs": {
                type: "http",
                url: "https://docs.example.test/mcp",
                tools: ["search"],
                headers: {
                  "X-Team": "Schema",
                },
              },
            },
            prompt: "Explore schema documentation before implementation.",
          },
          {
            name: "security-auditor",
            displayName: "Security Auditor",
            description: "Reviews code for security issues",
            argumentHint: "<risk area>",
            agents: ["programmatic-researcher"],
            model: "Claude Sonnet 4.5",
            metadata: {
              team: "AppSec",
              runbook: "security-review",
            },
            handoffs: [
              {
                label: "Ask Researcher",
                agent: "programmatic-researcher",
                prompt: "Research the risky area.",
                send: true,
              },
            ],
            hooks: {
              PostToolUse: [
                {
                  type: "command",
                  command: "./scripts/format-changed-files.sh",
                  timeout: 15,
                },
              ],
            },
            skills: ["release-review"],
            tools: ["read_file", "grep"],
            infer: false,
            prompt: "Inspect code for vulnerabilities and report concrete risks.",
          },
          {
            name: "planning",
            description: "Plan work before implementation",
            tools: ["read_file"],
            prompt: "Plan implementation options before editing.",
          },
          {
            name: "personal-reviewer",
            description: "Reviews user-level tasks",
            prompt: "Review the request using the user's personal workflow.",
          },
        ]);
        assert.equal(createConfig?.configDir, copilotHome);
        assert.deepEqual(createConfig?.mcpServers as unknown, {
          fetch: {
            type: "local",
            command: "uvx",
            args: ["mcp-server-fetch"],
            tools: ["fetch"],
          },
          docs: {
            type: "http",
            url: "https://repo.example.test/mcp",
            tools: ["search"],
          },
        });
        assert.equal(
          createConfig?.skillDirectories?.includes(path.join(repo, ".github", "skills")),
          true,
        );
        assert.equal(
          createConfig?.skillDirectories?.includes(path.join(repo, ".github-copilot", "skills")),
          true,
        );
        assert.equal(
          createConfig?.skillDirectories?.includes(path.join(copilotHome, "skills")),
          true,
        );
        assert.equal(createConfig?.enableConfigDiscovery, true);
        assert.equal(createConfig?.includeSubAgentStreamingEvents, true);
        assert.equal(createConfig?.agent, "security-auditor");
        const lifecycleEvents = Array.from(yield* Fiber.join(lifecycleEventsFiber));
        const mcpStatusEvent = lifecycleEvents.find((event) => event.type === "mcp.status.updated");
        assert.equal(mcpStatusEvent?.type, "mcp.status.updated");
        if (mcpStatusEvent?.type === "mcp.status.updated") {
          assert.deepEqual(mcpStatusEvent.payload.status, {
            provider: "githubCopilot",
            mcpServers: [
              {
                type: "local",
                command: "uvx",
                args: ["mcp-server-fetch"],
                tools: ["fetch"],
                name: "fetch",
                status: "configured",
              },
              {
                type: "http",
                url: "https://repo.example.test/mcp",
                tools: ["search"],
                name: "docs",
                status: "configured",
              },
            ],
          });
        }
        const configuredEvent = lifecycleEvents.find(
          (event) => event.type === "session.configured",
        );
        assert.equal(configuredEvent?.type, "session.configured");
        if (configuredEvent?.type === "session.configured") {
          const availableCommands = (configuredEvent.payload.config.availableCommands ??
            []) as ReadonlyArray<ProviderSlashCommand>;
          const securityAuditorCommand = availableCommands.find(
            (command) => command.name === "security-auditor",
          );
          assert.equal(securityAuditorCommand !== undefined, true);
          assert.deepEqual(
            {
              name: securityAuditorCommand?.name,
              kind: securityAuditorCommand?.kind,
              promptPrefix: securityAuditorCommand?.promptPrefix,
              description: securityAuditorCommand?.description,
              inputHint: securityAuditorCommand?.inputHint,
            },
            {
              name: "security-auditor",
              kind: "agent",
              promptPrefix: "@security-auditor",
              description: "Reviews code for security issues",
              inputHint: "<risk area>",
            },
          );
          assert.deepEqual(
            availableCommands.find((command) => command.name === "explore"),
            {
              name: "explore",
              kind: "agent",
              promptPrefix: "@explore",
              description:
                "Explore the codebase and gather implementation context with GitHub Copilot.",
              inputHint: "<prompt>",
            },
          );
          const configOptions = (configuredEvent.payload.config.configOptions ??
            []) as ReadonlyArray<{
            readonly id: string;
            readonly name: string;
            readonly category?: string;
            readonly type: "select";
            readonly currentValue: string;
            readonly description?: string;
            readonly options: ReadonlyArray<{
              readonly value: string;
              readonly name: string;
              readonly description?: string;
            }>;
          }>;
          const agentOption = configOptions.find((option) => option.id === "agent");
          assert.deepEqual(agentOption ? { ...agentOption, options: undefined } : undefined, {
            id: "agent",
            name: "Agent",
            category: "agent",
            type: "select",
            currentValue: "security-auditor",
            description: "GitHub Copilot custom agent for this session.",
            options: undefined,
          });
          assert.deepEqual(
            agentOption?.options.find((option) => option.value === "default"),
            {
              value: "default",
              name: "Default",
              description: "Use GitHub Copilot's default agent for this session.",
            },
          );
          assert.deepEqual(
            agentOption?.options.find((option) => option.value === "security-auditor"),
            {
              value: "security-auditor",
              name: "security-auditor",
              description: "Reviews code for security issues",
            },
          );
          assert.equal(
            availableCommands.some((command) => command.name === "programmatic-researcher"),
            false,
          );
          assert.deepEqual(
            availableCommands.find((command) => command.name === "release-review"),
            {
              name: "release-review",
              kind: "skill",
              promptPrefix: "/release-review",
              description: "Use release-review",
              inputHint: "<prompt>",
            },
          );
        }

        yield* adapter.stopSession(threadId);
      } finally {
        yield* Effect.promise(() => rm(repo, { recursive: true, force: true }));
      }
    }),
  );

  it.effect("selects a repository custom agent before sending a provider agent prompt", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() =>
        mkdtemp(path.join(tmpdir(), "ace-copilot-agent-select-")),
      );
      try {
        yield* Effect.promise(() =>
          mkdir(path.join(repo, ".github", "agents"), { recursive: true }),
        );
        yield* Effect.promise(() =>
          writeFile(
            path.join(repo, ".github", "agents", "security-auditor.md"),
            [
              "---",
              "name: Security Auditor",
              "description: Reviews code for security issues",
              "---",
              "",
              "Inspect code for vulnerabilities and report concrete risks.",
            ].join("\n"),
          ),
        );

        const send = vi.fn(async (_input: unknown) => "message-1");
        const agentSelect = vi.fn(async (input: { readonly name: string }) => ({
          agent: {
            name: input.name,
            displayName: "Security Auditor",
            description: "Reviews code for security issues",
          },
        }));
        const fakeClient = makeFakeClient({
          models: [],
          send,
          agentSelect,
        });
        mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

        const adapter = yield* GitHubCopilotAdapter;
        const threadId = asThreadId("thread-copilot-agent-select");
        yield* adapter.startSession({
          provider: "githubCopilot",
          threadId,
          cwd: repo,
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId,
          input: "@security-auditor inspect auth flows",
        });

        assert.deepEqual(agentSelect.mock.calls, [[{ name: "security-auditor" }]]);
        assert.deepEqual(send.mock.calls[0]?.[0], {
          prompt: "inspect auth flows",
        });

        yield* adapter.stopSession(threadId);
      } finally {
        yield* Effect.promise(() => rm(repo, { recursive: true, force: true }));
      }
    }),
  );

  it.effect("selects a configured Copilot agent before sending a normal prompt", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() =>
        mkdtemp(path.join(tmpdir(), "ace-copilot-configured-agent-select-")),
      );
      try {
        yield* Effect.promise(() =>
          mkdir(path.join(repo, ".github", "agents"), { recursive: true }),
        );
        yield* Effect.promise(() =>
          writeFile(
            path.join(repo, ".github", "agents", "security-auditor.md"),
            [
              "---",
              "name: Security Auditor",
              "description: Reviews code for security issues",
              "---",
              "",
              "Inspect code for vulnerabilities and report concrete risks.",
            ].join("\n"),
          ),
        );

        const send = vi.fn(async (_input: unknown) => "message-1");
        const agentSelect = vi.fn(async (input: { readonly name: string }) => ({
          agent: {
            name: input.name,
            displayName: "Security Auditor",
            description: "Reviews code for security issues",
          },
        }));
        const fakeClient = makeFakeClient({
          models: [],
          send,
          agentSelect,
        });
        mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

        const adapter = yield* GitHubCopilotAdapter;
        const threadId = asThreadId("thread-copilot-configured-agent-select");
        yield* adapter.startSession({
          provider: "githubCopilot",
          threadId,
          cwd: repo,
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId,
          input: "inspect auth flows",
          modelSelection: {
            provider: "githubCopilot",
            model: "gpt-5",
            options: {
              agent: "security-auditor",
            },
          },
        });

        assert.deepEqual(agentSelect.mock.calls, [[{ name: "security-auditor" }]]);
        assert.deepEqual(send.mock.calls[0]?.[0], {
          prompt: "inspect auth flows",
        });

        yield* adapter.stopSession(threadId);
      } finally {
        yield* Effect.promise(() => rm(repo, { recursive: true, force: true }));
      }
    }),
  );

  it.effect("preselects a configured Copilot custom agent at session creation", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() =>
        mkdtemp(path.join(tmpdir(), "ace-copilot-start-agent-select-")),
      );
      try {
        yield* Effect.promise(() =>
          mkdir(path.join(repo, ".github", "agents"), { recursive: true }),
        );
        yield* Effect.promise(() =>
          writeFile(
            path.join(repo, ".github", "agents", "security-auditor.md"),
            [
              "---",
              "name: Security Auditor",
              "description: Reviews code for security issues",
              "---",
              "",
              "Inspect code for vulnerabilities and report concrete risks.",
            ].join("\n"),
          ),
        );

        const send = vi.fn(async (_input: unknown) => "message-1");
        const agentSelect = vi.fn(async (input: { readonly name: string }) => ({
          agent: {
            name: input.name,
            displayName: "Security Auditor",
            description: "Reviews code for security issues",
          },
        }));
        const fakeClient = makeFakeClient({
          models: [],
          send,
          agentSelect,
        });
        mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

        const adapter = yield* GitHubCopilotAdapter;
        const threadId = asThreadId("thread-copilot-start-agent-select");
        yield* adapter.startSession({
          provider: "githubCopilot",
          threadId,
          cwd: repo,
          runtimeMode: "full-access",
          modelSelection: {
            provider: "githubCopilot",
            model: "gpt-5",
            options: {
              agent: "security-auditor",
            },
          },
        });

        const createConfig = fakeClient.createSession.mock.calls[0]?.[0] as
          | (FakeStartConfig & { readonly agent?: string })
          | undefined;
        assert.equal(createConfig?.agent, "security-auditor");

        yield* adapter.sendTurn({
          threadId,
          input: "inspect auth flows",
          modelSelection: {
            provider: "githubCopilot",
            model: "gpt-5",
            options: {
              agent: "security-auditor",
            },
          },
        });

        assert.deepEqual(agentSelect.mock.calls, []);
        assert.deepEqual(send.mock.calls[0]?.[0], {
          prompt: "inspect auth flows",
        });

        yield* adapter.stopSession(threadId);
      } finally {
        yield* Effect.promise(() => rm(repo, { recursive: true, force: true }));
      }
    }),
  );

  it.effect("selects a Copilot built-in agent before sending a prompt-file command", () =>
    Effect.gen(function* () {
      const send = vi.fn(async (_input: unknown) => "message-1");
      const agentSelect = vi.fn(async (input: { readonly name: string }) => ({
        agent: {
          name: input.name,
          displayName: "Plan",
          description: "Plan with Copilot",
        },
      }));
      const fakeClient = makeFakeClient({
        models: [],
        send,
        agentSelect,
      });
      mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

      const adapter = yield* GitHubCopilotAdapter;
      const threadId = asThreadId("thread-copilot-built-in-agent-select");
      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "@plan Review release readiness for v2.0.",
      });

      assert.deepEqual(agentSelect.mock.calls, [[{ name: "plan" }]]);
      assert.deepEqual(send.mock.calls[0]?.[0], {
        prompt: "Review release readiness for v2.0.",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("passes selected Copilot built-in agents into session startup", () =>
    Effect.gen(function* () {
      const fakeClient = makeFakeClient({
        models: [],
      });
      mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

      const adapter = yield* GitHubCopilotAdapter;
      const threadId = asThreadId("thread-copilot-start-built-in-agent-select");
      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId,
        runtimeMode: "full-access",
        modelSelection: {
          provider: "githubCopilot",
          model: "gpt-5",
          options: {
            agent: "explore",
          },
        },
      });

      const createConfig = fakeClient.createSession.mock.calls[0]?.[0] as
        | (FakeStartConfig & { readonly agent?: string })
        | undefined;
      assert.equal(createConfig?.agent, "explore");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("selects advertised built-in Copilot agents instead of sending mentions as text", () =>
    Effect.gen(function* () {
      const send = vi.fn(async (_input: unknown) => "message-1");
      const agentSelect = vi.fn(async (input: { readonly name: string }) => ({
        agent: {
          name: input.name,
          displayName: input.name,
          description: "Built-in Copilot agent",
        },
      }));
      const fakeClient = makeFakeClient({
        models: [],
        send,
        agentSelect,
      });
      mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

      const adapter = yield* GitHubCopilotAdapter;
      const threadId = asThreadId("thread-copilot-advertised-built-in-agent-select");
      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "@explore inspect the auth boundary",
      });

      assert.deepEqual(agentSelect.mock.calls, [[{ name: "explore" }]]);
      assert.deepEqual(send.mock.calls[0]?.[0], {
        prompt: "inspect the auth boundary",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("refreshes available commands from Copilot SDK loaded skills and agents", () =>
    Effect.gen(function* () {
      const send = vi.fn(async (_input: unknown) => "message-1");
      const agentSelect = vi.fn(async (input: { readonly name: string }) => ({
        agent: {
          name: input.name,
          displayName: "SDK Auditor",
          description: "Audit with SDK-discovered agent",
        },
      }));
      const fakeClient = makeFakeClient({
        models: [],
        send,
        agentSelect,
      });
      mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

      const adapter = yield* GitHubCopilotAdapter;
      const threadId = asThreadId("thread-copilot-sdk-loaded-commands");
      const configuredFiber = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(
            adapter.streamEvents,
            (event) => event.threadId === threadId && event.type === "session.configured",
          ),
          3,
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId,
        cwd: "/repo",
        runtimeMode: "full-access",
      });

      fakeClient.emitSessionEvent({
        id: "event-skills-loaded",
        type: "session.skills_loaded",
        timestamp: new Date().toISOString(),
        parentId: null,
        ephemeral: true,
        data: {
          skills: [
            {
              name: "sdk-review",
              description: "Review with SDK-discovered skill",
              enabled: true,
              userInvocable: true,
              source: "plugin",
            },
            {
              name: "background-only",
              description: "Hidden background skill",
              enabled: true,
              userInvocable: false,
              source: "project",
            },
          ],
        },
      } as unknown as SessionEvent);

      fakeClient.emitSessionEvent({
        id: "event-custom-agents-updated",
        type: "session.custom_agents_updated",
        timestamp: new Date().toISOString(),
        parentId: "event-skills-loaded",
        ephemeral: true,
        data: {
          agents: [
            {
              id: "sdk-agent-1",
              name: "sdk-auditor",
              displayName: "SDK Auditor",
              description: "Audit with SDK-discovered agent",
              source: "plugin",
              tools: [],
              userInvocable: true,
            },
            {
              id: "sdk-agent-2",
              name: "hidden-agent",
              displayName: "Hidden Agent",
              description: "Hidden SDK agent",
              source: "plugin",
              tools: [],
              userInvocable: false,
            },
          ],
          errors: [],
          warnings: [],
        },
      } as unknown as SessionEvent);

      const configuredEvents = Array.from(yield* Fiber.join(configuredFiber));
      const latest = configuredEvents.at(-1);
      assert.equal(latest?.type, "session.configured");
      if (latest?.type !== "session.configured") {
        return;
      }
      const availableCommands = (latest.payload.config.availableCommands ??
        []) as ReadonlyArray<ProviderSlashCommand>;
      assert.deepEqual(
        availableCommands.find((command) => command.name === "sdk-review"),
        {
          name: "sdk-review",
          kind: "skill",
          promptPrefix: "/sdk-review",
          description: "Review with SDK-discovered skill",
          inputHint: "<prompt>",
        },
      );
      assert.deepEqual(
        availableCommands.find((command) => command.name === "sdk-auditor"),
        {
          name: "sdk-auditor",
          kind: "agent",
          promptPrefix: "@sdk-auditor",
          description: "Audit with SDK-discovered agent",
          inputHint: "<prompt>",
        },
      );
      assert.equal(
        availableCommands.some((command) => command.name === "background-only"),
        false,
      );
      assert.equal(
        availableCommands.some((command) => command.name === "hidden-agent"),
        false,
      );

      yield* adapter.sendTurn({
        threadId,
        input: "@sdk-auditor inspect auth flows",
      });

      assert.deepEqual(agentSelect.mock.calls, [[{ name: "sdk-auditor" }]]);
      assert.deepEqual(send.mock.calls[0]?.[0], {
        prompt: "inspect auth flows",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "falls back to a fresh Copilot session when the persisted resume cursor no longer exists remotely",
    () =>
      Effect.gen(function* () {
        const fakeClient = makeFakeClient({
          models: [],
        });
        fakeClient.resumeSession.mockRejectedValueOnce(
          new Error(
            "Request session.resume failed with message: Session not found: ca96227e-940f-4997-912e-e959c8c844e9",
          ),
        );
        mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

        const adapter = yield* GitHubCopilotAdapter;
        const session = yield* adapter.startSession({
          provider: "githubCopilot",
          threadId: asThreadId("thread-stale-resume"),
          cwd: "/repo",
          resumeCursor: "ca96227e-940f-4997-912e-e959c8c844e9",
          runtimeMode: "full-access",
        });

        assert.equal(fakeClient.resumeSession.mock.calls.length, 1);
        assert.equal(fakeClient.createSession.mock.calls.length, 1);
        assert.equal(session.resumeCursor, "copilot-session-1");

        yield* adapter.stopSession(asThreadId("thread-stale-resume"));
      }),
  );

  it.effect("creates and stops a dedicated Copilot client per T3 session", () =>
    Effect.gen(function* () {
      const firstClient = makeFakeClient({
        models: [],
      });
      const secondClient = makeFakeClient({
        models: [],
      });
      mockedCreateGitHubCopilotClient
        .mockResolvedValueOnce(firstClient)
        .mockResolvedValueOnce(secondClient);

      const adapter = yield* GitHubCopilotAdapter;
      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId: asThreadId("thread-isolated-1"),
        cwd: "/repo-a",
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId: asThreadId("thread-isolated-2"),
        cwd: "/repo-b",
        runtimeMode: "full-access",
      });

      assert.equal(mockedCreateGitHubCopilotClient.mock.calls.length, 2);
      assert.equal(firstClient.createSession.mock.calls.length, 1);
      assert.equal(secondClient.createSession.mock.calls.length, 1);

      yield* adapter.stopSession(asThreadId("thread-isolated-1"));
      assert.equal(firstClient.stop.mock.calls.length, 1);
      assert.equal(secondClient.stop.mock.calls.length, 0);

      yield* adapter.stopSession(asThreadId("thread-isolated-2"));
      assert.equal(secondClient.stop.mock.calls.length, 1);
    }),
  );

  it.effect("emits context window updates from GitHub Copilot usage events", () =>
    Effect.gen(function* () {
      const fakeClient = makeFakeClient({
        models: [],
      });
      mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

      const adapter = yield* GitHubCopilotAdapter;
      const usageEventsFiber = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(
            adapter.streamEvents,
            (event) => event.type === "thread.token-usage.updated",
          ),
          2,
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId: asThreadId("thread-usage"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-usage"),
        input: "Explain the repository.",
      });

      fakeClient.emitSessionEvent({
        id: "event-usage-info",
        type: "session.usage_info",
        timestamp: new Date().toISOString(),
        parentId: null,
        ephemeral: true,
        data: {
          tokenLimit: 128_000,
          currentTokens: 6_400,
          messagesLength: 3,
        },
      });

      fakeClient.emitSessionEvent({
        id: "event-assistant-usage",
        type: "assistant.usage",
        timestamp: new Date().toISOString(),
        parentId: "event-usage-info",
        ephemeral: true,
        data: {
          model: "gpt-4.1",
          inputTokens: 512,
          cacheReadTokens: 128,
          outputTokens: 64,
          duration: 1_250,
        },
      });

      const events = Array.from(yield* Fiber.join(usageEventsFiber));

      assert.equal(events.length, 2);
      assert.equal(events[0]?.type, "thread.token-usage.updated");
      assert.equal(events[1]?.type, "thread.token-usage.updated");

      if (events[0]?.type !== "thread.token-usage.updated") {
        return;
      }
      if (events[1]?.type !== "thread.token-usage.updated") {
        return;
      }

      assert.equal(events[0].threadId, asThreadId("thread-usage"));
      assert.equal(events[0].turnId, events[1].turnId);
      assert.deepEqual(events[0].payload.usage, {
        usedTokens: 6_400,
        maxTokens: 128_000,
        lastUsedTokens: 6_400,
      });
      assert.deepEqual(events[1].payload.usage, {
        usedTokens: 6_400,
        maxTokens: 128_000,
        lastUsedTokens: 6_400,
        lastInputTokens: 512,
        lastCachedInputTokens: 128,
        lastOutputTokens: 64,
        durationMs: 1_250,
      });

      yield* adapter.stopSession(asThreadId("thread-usage"));
    }),
  );

  it.effect(
    "emits rich tool metadata and reasoning completions from GitHub Copilot session events",
    () =>
      Effect.gen(function* () {
        const fakeClient = makeFakeClient({
          models: [],
        });
        mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

        const adapter = yield* GitHubCopilotAdapter;
        const interestingEventsFiber = yield* Stream.runCollect(
          Stream.take(
            Stream.filter(adapter.streamEvents, (event) => {
              if (event.type === "item.started") {
                return event.payload.itemType === "file_change";
              }
              if (event.type === "item.completed") {
                return (
                  event.payload.itemType === "file_change" || event.payload.itemType === "reasoning"
                );
              }
              return false;
            }),
            3,
          ),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          provider: "githubCopilot",
          threadId: asThreadId("thread-tooling"),
          cwd: "/repo",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-tooling"),
          input: "Patch the chat timeline.",
        });

        fakeClient.emitSessionEvent({
          id: "event-assistant-tool-request",
          type: "assistant.message",
          timestamp: new Date().toISOString(),
          parentId: null,
          data: {
            messageId: "assistant-tool-request",
            content: "I will update the timeline and then explain the changes.",
            toolRequests: [
              {
                toolCallId: "tool-call-1",
                name: "apply_patch",
                arguments: {
                  filePath: "apps/web/src/components/chat/MessagesTimeline.tsx",
                },
                toolTitle: "Patch Messages Timeline",
                intentionSummary: "Update the message ordering UI",
              },
            ],
          },
        });

        fakeClient.emitSessionEvent({
          id: "event-tool-start",
          type: "tool.execution_start",
          timestamp: new Date().toISOString(),
          parentId: "event-assistant-tool-request",
          data: {
            toolCallId: "tool-call-1",
            toolName: "apply_patch",
            arguments: {
              filePath: "apps/web/src/components/chat/MessagesTimeline.tsx",
            },
          },
        });

        fakeClient.emitSessionEvent({
          id: "event-tool-complete",
          type: "tool.execution_complete",
          timestamp: new Date().toISOString(),
          parentId: "event-tool-start",
          data: {
            toolCallId: "tool-call-1",
            success: true,
            result: {
              content: "Patch applied",
              detailedContent:
                "Updated MessagesTimeline.tsx to show ordered tool and thinking rows.",
            },
          },
        });

        fakeClient.emitSessionEvent({
          id: "event-reasoning-complete",
          type: "assistant.reasoning",
          timestamp: new Date().toISOString(),
          parentId: "event-tool-complete",
          data: {
            reasoningId: "reasoning-1",
            content: "The timeline needs assistant segment boundaries around tool execution.",
          },
        });

        const events = Array.from(yield* Fiber.join(interestingEventsFiber));
        assert.equal(events.length, 3);

        const toolStarted = events[0];
        const toolCompleted = events[1];
        const reasoningCompleted = events[2];

        assert.equal(toolStarted?.type, "item.started");
        assert.equal(toolCompleted?.type, "item.completed");
        assert.equal(reasoningCompleted?.type, "item.completed");

        if (toolStarted?.type !== "item.started") {
          return;
        }
        if (toolCompleted?.type !== "item.completed") {
          return;
        }
        if (reasoningCompleted?.type !== "item.completed") {
          return;
        }

        assert.equal(toolStarted.payload.title, "Patch Messages Timeline");
        assert.match(
          toolStarted.payload.detail ?? "",
          /apps\/web\/src\/components\/chat\/MessagesTimeline\.tsx/,
        );
        const toolStartedData =
          toolStarted.payload.data && typeof toolStarted.payload.data === "object"
            ? (toolStarted.payload.data as {
                toolName?: string;
                arguments?: { filePath?: string };
                toolTitle?: string;
                intentionSummary?: string;
              })
            : {};
        assert.equal(toolStartedData.toolName, "apply_patch");
        assert.deepEqual(toolStartedData.arguments, {
          filePath: "apps/web/src/components/chat/MessagesTimeline.tsx",
        });
        assert.equal(toolStartedData.toolTitle, "Patch Messages Timeline");
        assert.equal(toolStartedData.intentionSummary, "Update the message ordering UI");

        assert.equal(toolCompleted.payload.itemType, "file_change");
        assert.equal(toolCompleted.payload.title, "Patch Messages Timeline");
        assert.match(
          toolCompleted.payload.detail ?? "",
          /Updated MessagesTimeline\.tsx to show ordered tool and thinking rows\./,
        );

        assert.equal(reasoningCompleted.payload.itemType, "reasoning");
        const reasoningData =
          reasoningCompleted.payload.data && typeof reasoningCompleted.payload.data === "object"
            ? (reasoningCompleted.payload.data as { content?: string })
            : {};
        assert.equal(
          reasoningData.content,
          "The timeline needs assistant segment boundaries around tool execution.",
        );

        yield* adapter.stopSession(asThreadId("thread-tooling"));
      }),
  );

  it.effect("maps Copilot subagent lifecycle events into collab agent items", () =>
    Effect.gen(function* () {
      const fakeClient = makeFakeClient({
        models: [],
      });
      mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

      const adapter = yield* GitHubCopilotAdapter;
      const subagentEventsFiber = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(adapter.streamEvents, (event) => {
            return (
              (event.type === "item.started" || event.type === "item.completed") &&
              event.payload.itemType === "collab_agent_tool_call"
            );
          }),
          2,
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId: asThreadId("thread-subagent-events"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-subagent-events"),
        input: "Use a custom reviewer agent.",
      });

      fakeClient.emitSessionEvent({
        id: "event-subagent-started",
        type: "subagent.started",
        timestamp: new Date().toISOString(),
        parentId: null,
        data: {
          subagent_id: "copilot-subagent-1",
          agentName: "runtime-reviewer",
          agent_display_name: "Runtime Reviewer",
          agentRole: "code-reviewer",
          model: "gpt-5.4",
          description: "Review runtime events.",
        },
      } as unknown as SessionEvent);

      fakeClient.emitSessionEvent({
        id: "event-subagent-completed",
        type: "subagent.completed",
        timestamp: new Date().toISOString(),
        parentId: "event-subagent-started",
        data: {
          subagent_id: "copilot-subagent-1",
          agentName: "runtime-reviewer",
          agent_display_name: "Runtime Reviewer",
          agentRole: "code-reviewer",
          model: "gpt-5.4",
          summary: "Runtime event handling is consistent.",
        },
      } as unknown as SessionEvent);

      const events = Array.from(yield* Fiber.join(subagentEventsFiber));
      assert.equal(events.length, 2);
      const started = events[0];
      const completed = events[1];
      assert.equal(started?.type, "item.started");
      assert.equal(completed?.type, "item.completed");
      if (started?.type !== "item.started" || completed?.type !== "item.completed") {
        return;
      }

      assert.equal(started.payload.status, "inProgress");
      assert.equal(completed.payload.status, "completed");
      assert.deepEqual((completed.payload.data as { subagent?: unknown }).subagent, {
        id: "copilot-subagent-1",
        parentId: "event-subagent-started",
        type: "code-reviewer",
        name: "Runtime Reviewer",
        model: "gpt-5.4",
      });

      yield* adapter.stopSession(asThreadId("thread-subagent-events"));
    }),
  );

  it.effect("maps Copilot assistant intents to reasoning work immediately", () =>
    Effect.gen(function* () {
      const fakeClient = makeFakeClient({
        models: [],
      });
      mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

      const adapter = yield* GitHubCopilotAdapter;
      const reasoningEventsFiber = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(
            adapter.streamEvents,
            (event) =>
              event.type === "item.started" ||
              (event.type === "item.completed" && event.payload.itemType === "reasoning"),
          ),
          2,
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId: asThreadId("thread-copilot-intent"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-copilot-intent"),
        input: "Inspect the repository state.",
      });

      fakeClient.emitSessionEvent({
        id: "event-assistant-intent",
        type: "assistant.intent",
        timestamp: "2024-01-01T00:00:01.000Z",
        parentId: null,
        ephemeral: true,
        data: {
          intent: "Checking codebase",
        },
      });

      const events = Array.from(yield* Fiber.join(reasoningEventsFiber));
      assert.equal(events.length, 2);

      const reasoningStarted = events[0];
      const reasoningCompleted = events[1];

      assert.equal(reasoningStarted?.type, "item.started");
      assert.equal(reasoningCompleted?.type, "item.completed");

      if (reasoningStarted?.type !== "item.started") {
        return;
      }
      if (reasoningCompleted?.type !== "item.completed") {
        return;
      }

      assert.equal(reasoningStarted.payload.itemType, "reasoning");
      assert.equal(reasoningCompleted.payload.itemType, "reasoning");
      assert.equal(reasoningCompleted.payload.detail, "Checking codebase");

      const reasoningData =
        reasoningCompleted.payload.data && typeof reasoningCompleted.payload.data === "object"
          ? (reasoningCompleted.payload.data as { content?: string; source?: string })
          : {};
      assert.equal(reasoningData.content, "Checking codebase");
      assert.equal(reasoningData.source, "assistant.intent");

      yield* adapter.stopSession(asThreadId("thread-copilot-intent"));
    }),
  );

  it.effect(
    "announces Copilot tool requests before execution starts and reuses the same tool item",
    () =>
      Effect.gen(function* () {
        const fakeClient = makeFakeClient({
          models: [],
        });
        mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

        const adapter = yield* GitHubCopilotAdapter;
        const lifecycleEventsFiber = yield* Stream.runCollect(
          Stream.take(
            Stream.filter(adapter.streamEvents, (event) => {
              if (event.type === "item.completed") {
                return event.payload.itemType === "assistant_message";
              }
              if (event.type === "item.started" || event.type === "item.updated") {
                return event.payload.itemType === "file_change";
              }
              return false;
            }),
            3,
          ),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          provider: "githubCopilot",
          threadId: asThreadId("thread-copilot-tool-announcement"),
          cwd: "/repo",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-copilot-tool-announcement"),
          input: "Check the codebase and patch the adapter.",
        });

        fakeClient.emitSessionEvent({
          id: "event-assistant-tool-announcement",
          type: "assistant.message",
          timestamp: "2024-01-01T00:00:02.000Z",
          parentId: null,
          data: {
            messageId: "assistant-tool-announcement",
            content: "Checking codebase",
            toolRequests: [
              {
                toolCallId: "tool-call-announced",
                name: "apply_patch",
                arguments: {
                  filePath: "apps/server/src/provider/Layers/GitHubCopilotAdapter.ts",
                },
                toolTitle: "Patch GitHub Copilot Adapter",
                intentionSummary: "Inspect and update ordering behavior",
              },
            ],
          },
        });

        fakeClient.emitSessionEvent({
          id: "event-tool-execution-start",
          type: "tool.execution_start",
          timestamp: "2024-01-01T00:00:03.000Z",
          parentId: "event-assistant-tool-announcement",
          data: {
            toolCallId: "tool-call-announced",
            toolName: "apply_patch",
            arguments: {
              filePath: "apps/server/src/provider/Layers/GitHubCopilotAdapter.ts",
            },
          },
        });

        const events = Array.from(yield* Fiber.join(lifecycleEventsFiber));
        assert.equal(events.length, 3);

        const toolStarted = events[0];
        const assistantCompleted = events[1];
        const toolUpdated = events[2];

        assert.equal(toolStarted?.type, "item.started");
        assert.equal(assistantCompleted?.type, "item.completed");
        assert.equal(toolUpdated?.type, "item.updated");

        if (toolStarted?.type !== "item.started") {
          return;
        }
        if (assistantCompleted?.type !== "item.completed") {
          return;
        }
        if (toolUpdated?.type !== "item.updated") {
          return;
        }

        assert.equal(toolStarted.payload.itemType, "file_change");
        assert.equal(toolStarted.payload.title, "Patch GitHub Copilot Adapter");
        assert.equal(assistantCompleted.payload.itemType, "assistant_message");
        assert.equal(assistantCompleted.payload.detail, "Checking codebase");
        assert.equal(toolUpdated.payload.itemType, "file_change");
        assert.equal(toolUpdated.payload.title, "Patch GitHub Copilot Adapter");
        assert.equal(toolStarted.itemId, toolUpdated.itemId);

        yield* adapter.stopSession(asThreadId("thread-copilot-tool-announcement"));
      }),
  );

  it.effect("emits native turn.plan.updated events from Copilot update_todo markdown", () =>
    Effect.gen(function* () {
      const fakeClient = makeFakeClient({
        models: [],
      });
      mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

      const adapter = yield* GitHubCopilotAdapter;
      const planEventsFiber = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(adapter.streamEvents, (event) => event.type === "turn.plan.updated"),
          1,
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId: asThreadId("thread-copilot-native-todo"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-copilot-native-todo"),
        input: "Track the implementation todos.",
      });

      fakeClient.emitSessionEvent({
        id: "event-assistant-message-native-todo",
        type: "assistant.message",
        timestamp: "2024-01-01T00:00:02.000Z",
        parentId: null,
        data: {
          messageId: "assistant-message-native-todo",
          content: "Tracking native todos",
          toolRequests: [
            {
              toolCallId: "tool-call-native-todo",
              name: "update_todo",
              arguments: {
                todos: [
                  "- [x] Inspect the adapter",
                  "- [ ] Capture plan.md",
                  "- [ ] Render the SQL-backed todo state",
                ].join("\n"),
              },
              toolTitle: "Update Todo List",
            },
          ],
        },
      });

      fakeClient.emitSessionEvent({
        id: "event-tool-start-native-todo",
        type: "tool.execution_start",
        timestamp: "2024-01-01T00:00:03.000Z",
        parentId: "event-assistant-message-native-todo",
        data: {
          toolCallId: "tool-call-native-todo",
          toolName: "update_todo",
          arguments: {
            todos: [
              "- [x] Inspect the adapter",
              "- [ ] Capture plan.md",
              "- [ ] Render the SQL-backed todo state",
            ].join("\n"),
          },
        },
      });

      fakeClient.emitSessionEvent({
        id: "event-tool-complete-native-todo",
        type: "tool.execution_complete",
        timestamp: "2024-01-01T00:00:04.000Z",
        parentId: "event-tool-start-native-todo",
        data: {
          toolCallId: "tool-call-native-todo",
          success: true,
          result: {
            content: "Todo list updated",
          },
        },
      });

      const events = Array.from(yield* Fiber.join(planEventsFiber));
      assert.equal(events.length, 1);

      const [planUpdated] = events;
      assert.equal(planUpdated?.type, "turn.plan.updated");
      if (planUpdated?.type !== "turn.plan.updated") {
        return;
      }

      assert.deepEqual(planUpdated.payload.plan, [
        { step: "Inspect the adapter", status: "completed" },
        { step: "Capture plan.md", status: "pending" },
        { step: "Render the SQL-backed todo state", status: "pending" },
      ]);

      yield* adapter.stopSession(asThreadId("thread-copilot-native-todo"));
    }),
  );

  it.effect("emits native proposed plans from Copilot plan mode events and file-path hints", () =>
    Effect.gen(function* () {
      const planRead = vi.fn(async () => ({
        exists: true,
        content: "# Native plan\n\n- Audit the adapter\n- Read the SQL todos\n- Render the plan",
        path: "/tmp/copilot-session/plan.md",
      }));
      const fakeClient = makeFakeClient({
        models: [],
        planRead,
        workspacePath: "/tmp/copilot-session",
      });
      mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

      const adapter = yield* GitHubCopilotAdapter;
      const proposedPlanEventsFiber = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(adapter.streamEvents, (event) => event.type === "turn.proposed.completed"),
          2,
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId: asThreadId("thread-copilot-native-plan"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-copilot-native-plan"),
        input: "Create the implementation plan.",
      });

      fakeClient.emitSessionEvent({
        id: "event-exit-plan-mode",
        type: "exit_plan_mode.requested",
        timestamp: "2024-01-01T00:00:02.000Z",
        parentId: null,
        ephemeral: true,
        data: {
          requestId: "exit-plan-request-1",
          summary: "- Audit\n- Render",
          planContent: "# Exit plan\n\n- Use the native exit payload\n- Wait for user review",
          actions: ["exit_only", "interactive"],
          recommendedAction: "interactive",
        },
      });

      fakeClient.emitSessionEvent({
        id: "event-assistant-message-plan-path",
        type: "assistant.message",
        timestamp: "2024-01-01T00:00:03.000Z",
        parentId: "event-exit-plan-mode",
        data: {
          messageId: "assistant-message-plan-path",
          content: "The plan is in file:///tmp/copilot-session/plan.md and is ready for review.",
        },
      });

      const events = Array.from(yield* Fiber.join(proposedPlanEventsFiber));
      assert.equal(events.length, 2);

      const [exitPlanEvent, filePathPlanEvent] = events;
      assert.equal(exitPlanEvent?.type, "turn.proposed.completed");
      assert.equal(filePathPlanEvent?.type, "turn.proposed.completed");

      if (exitPlanEvent?.type !== "turn.proposed.completed") {
        return;
      }
      if (filePathPlanEvent?.type !== "turn.proposed.completed") {
        return;
      }

      assert.equal(
        exitPlanEvent.payload.planMarkdown,
        "# Exit plan\n\n- Use the native exit payload\n- Wait for user review",
      );
      assert.equal(
        filePathPlanEvent.payload.planMarkdown,
        "# Native plan\n\n- Audit the adapter\n- Read the SQL todos\n- Render the plan",
      );
      assert.equal(planRead.mock.calls.length, 1);

      yield* adapter.stopSession(asThreadId("thread-copilot-native-plan"));
    }),
  );

  it.effect(
    "suppresses Copilot assistant messages that only repeat the active intent before a tool call",
    () =>
      Effect.gen(function* () {
        const fakeClient = makeFakeClient({
          models: [],
        });
        mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

        const adapter = yield* GitHubCopilotAdapter;
        const lifecycleEventsFiber = yield* Stream.runCollect(
          Stream.take(
            Stream.filter(adapter.streamEvents, (event) => {
              if (event.type === "item.completed") {
                return (
                  event.payload.itemType === "assistant_message" ||
                  event.payload.itemType === "reasoning"
                );
              }
              if (event.type === "item.started" || event.type === "item.updated") {
                return event.payload.itemType === "file_change";
              }
              return false;
            }),
            3,
          ),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          provider: "githubCopilot",
          threadId: asThreadId("thread-copilot-intent-suppression"),
          cwd: "/repo",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-copilot-intent-suppression"),
          input: "Check the codebase and patch the adapter.",
        });

        fakeClient.emitSessionEvent({
          id: "event-assistant-intent-checking",
          type: "assistant.intent",
          timestamp: "2024-01-01T00:00:01.000Z",
          parentId: null,
          ephemeral: true,
          data: {
            intent: "Checking codebase",
          },
        });

        fakeClient.emitSessionEvent({
          id: "event-assistant-message-duplicate-intent",
          type: "assistant.message",
          timestamp: "2024-01-01T00:00:02.000Z",
          parentId: "event-assistant-intent-checking",
          data: {
            messageId: "assistant-message-duplicate-intent",
            content: "Checking codebase",
            toolRequests: [
              {
                toolCallId: "tool-call-duplicate-intent",
                name: "apply_patch",
                arguments: {
                  filePath: "apps/server/src/provider/Layers/GitHubCopilotAdapter.ts",
                },
                toolTitle: "Patch GitHub Copilot Adapter",
                intentionSummary: "Inspect and update ordering behavior",
              },
            ],
          },
        });

        fakeClient.emitSessionEvent({
          id: "event-tool-execution-start-duplicate-intent",
          type: "tool.execution_start",
          timestamp: "2024-01-01T00:00:03.000Z",
          parentId: "event-assistant-message-duplicate-intent",
          data: {
            toolCallId: "tool-call-duplicate-intent",
            toolName: "apply_patch",
            arguments: {
              filePath: "apps/server/src/provider/Layers/GitHubCopilotAdapter.ts",
            },
          },
        });

        const events = Array.from(yield* Fiber.join(lifecycleEventsFiber));
        assert.equal(events.length, 3);

        const reasoningCompleted = events[0];
        const toolStarted = events[1];
        const toolUpdated = events[2];

        assert.equal(reasoningCompleted?.type, "item.completed");
        assert.equal(toolStarted?.type, "item.started");
        assert.equal(toolUpdated?.type, "item.updated");

        if (reasoningCompleted?.type !== "item.completed") {
          return;
        }
        if (toolStarted?.type !== "item.started") {
          return;
        }
        if (toolUpdated?.type !== "item.updated") {
          return;
        }

        assert.equal(reasoningCompleted.payload.itemType, "reasoning");
        assert.equal(reasoningCompleted.payload.detail, "Checking codebase");
        assert.equal(toolStarted.payload.itemType, "file_change");
        assert.equal(toolUpdated.payload.itemType, "file_change");
        assert.equal(toolStarted.itemId, toolUpdated.itemId);
        assert.equal(
          events.some(
            (event) =>
              event.type === "item.completed" && event.payload.itemType === "assistant_message",
          ),
          false,
        );

        yield* adapter.stopSession(asThreadId("thread-copilot-intent-suppression"));
      }),
  );

  it.effect("sanitizes noisy GitHub Copilot tool wrapper metadata", () =>
    Effect.gen(function* () {
      const fakeClient = makeFakeClient({
        models: [],
      });
      mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

      const adapter = yield* GitHubCopilotAdapter;
      const toolStartedFiber = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(
            adapter.streamEvents,
            (event) =>
              event.type === "item.started" &&
              event.payload.data !== undefined &&
              typeof event.payload.data === "object" &&
              (event.payload.data as { toolName?: string }).toolName === "run_in_terminal",
          ),
          1,
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId: asThreadId("thread-sanitized-tooling"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-sanitized-tooling"),
        input: "Run the repository checks.",
      });

      fakeClient.emitSessionEvent({
        id: "event-assistant-tool-request-intent",
        type: "assistant.message",
        timestamp: new Date().toISOString(),
        parentId: null,
        data: {
          messageId: "assistant-tool-request-intent",
          content: "I will run the repository checks.",
          toolRequests: [
            {
              toolCallId: "tool-call-intent",
              name: "run_in_terminal",
              arguments: {
                intent: "Running format & checks",
                command:
                  "cat package.json || true\nnode -e \"const p=require('./package.json'); console.log(Object.keys(p.scripts||{}).join('\\n'))\"\nbun fmt && bun lint && bun typecheck",
              },
              toolTitle:
                'Report Intent - {"intent":"Running format & checks"} Running format & checks',
            },
          ],
        },
      });

      fakeClient.emitSessionEvent({
        id: "event-tool-start-intent",
        type: "tool.execution_start",
        timestamp: new Date().toISOString(),
        parentId: "event-assistant-tool-request-intent",
        data: {
          toolCallId: "tool-call-intent",
          toolName: "run_in_terminal",
          arguments: {
            intent: "Running format & checks",
            command:
              "cat package.json || true\nnode -e \"const p=require('./package.json'); console.log(Object.keys(p.scripts||{}).join('\\n'))\"\nbun fmt && bun lint && bun typecheck",
          },
        },
      });

      const [toolStarted] = Array.from(yield* Fiber.join(toolStartedFiber));
      assert.equal(toolStarted?.type, "item.started");

      if (toolStarted?.type !== "item.started") {
        return;
      }

      assert.equal(toolStarted.payload.title, "Running format & checks");
      assert.equal(toolStarted.payload.detail, "Running format & checks");
      assert.equal(/cat package\.json/.test(toolStarted.payload.detail ?? ""), false);

      yield* adapter.stopSession(asThreadId("thread-sanitized-tooling"));
    }),
  );

  it.effect(
    "suppresses Copilot assistant messages that only repeat tool argument intent text",
    () =>
      Effect.gen(function* () {
        const fakeClient = makeFakeClient({
          models: [],
        });
        mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

        const adapter = yield* GitHubCopilotAdapter;
        const lifecycleEventsFiber = yield* Stream.runCollect(
          Stream.take(
            Stream.filter(adapter.streamEvents, (event) => {
              if (event.type === "item.completed") {
                return event.payload.itemType === "assistant_message";
              }
              if (event.type === "item.started" || event.type === "item.updated") {
                return event.payload.itemType === "command_execution";
              }
              return false;
            }),
            2,
          ),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          provider: "githubCopilot",
          threadId: asThreadId("thread-copilot-argument-intent-suppression"),
          cwd: "/repo",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-copilot-argument-intent-suppression"),
          input: "Run the repository checks.",
        });

        fakeClient.emitSessionEvent({
          id: "event-assistant-message-argument-intent",
          type: "assistant.message",
          timestamp: "2024-01-01T00:00:02.000Z",
          parentId: null,
          data: {
            messageId: "assistant-message-argument-intent",
            content: "Running checks",
            toolRequests: [
              {
                toolCallId: "tool-call-argument-intent",
                name: "run_in_terminal",
                arguments: {
                  intent: "Running checks",
                  command: "bun fmt && bun lint && bun typecheck",
                },
              },
            ],
          },
        });

        fakeClient.emitSessionEvent({
          id: "event-tool-start-argument-intent",
          type: "tool.execution_start",
          timestamp: "2024-01-01T00:00:03.000Z",
          parentId: "event-assistant-message-argument-intent",
          data: {
            toolCallId: "tool-call-argument-intent",
            toolName: "run_in_terminal",
            arguments: {
              intent: "Running checks",
              command: "bun fmt && bun lint && bun typecheck",
            },
          },
        });

        const events = Array.from(yield* Fiber.join(lifecycleEventsFiber));
        assert.equal(events.length, 2);
        assert.equal(events[0]?.type, "item.started");
        assert.equal(events[1]?.type, "item.updated");
        assert.equal(
          events.some(
            (event) =>
              event.type === "item.completed" && event.payload.itemType === "assistant_message",
          ),
          false,
        );

        yield* adapter.stopSession(asThreadId("thread-copilot-argument-intent-suppression"));
      }),
  );

  it.effect("projects assistant.message reasoningText before the final Copilot reply", () =>
    Effect.gen(function* () {
      const fakeClient = makeFakeClient({
        models: [],
      });
      mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

      const adapter = yield* GitHubCopilotAdapter;
      const lifecycleEventsFiber = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(
            adapter.streamEvents,
            (event) =>
              event.type === "item.completed" &&
              (event.payload.itemType === "reasoning" ||
                event.payload.itemType === "assistant_message"),
          ),
          2,
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId: asThreadId("thread-copilot-embedded-reasoning"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-copilot-embedded-reasoning"),
        input: "Explain the ordering issue.",
      });

      fakeClient.emitSessionEvent({
        id: "event-assistant-message-with-reasoning-text",
        type: "assistant.message",
        timestamp: "2024-01-01T00:00:02.000Z",
        parentId: null,
        data: {
          messageId: "assistant-message-with-reasoning-text",
          reasoningText: "Inspecting the provider timeline before writing the summary.",
          content:
            "The ordering issue comes from announcement messages being projected as replies.",
        },
      });

      const events = Array.from(yield* Fiber.join(lifecycleEventsFiber));
      assert.equal(events.length, 2);

      const reasoningCompleted = events[0];
      const assistantCompleted = events[1];

      assert.equal(reasoningCompleted?.type, "item.completed");
      assert.equal(assistantCompleted?.type, "item.completed");

      if (reasoningCompleted?.type !== "item.completed") {
        return;
      }
      if (assistantCompleted?.type !== "item.completed") {
        return;
      }

      assert.equal(reasoningCompleted.payload.itemType, "reasoning");
      assert.equal(
        reasoningCompleted.payload.detail,
        "Inspecting the provider timeline before writing the summary.",
      );
      assert.equal(assistantCompleted.payload.itemType, "assistant_message");
      assert.equal(
        assistantCompleted.payload.detail,
        "The ordering issue comes from announcement messages being projected as replies.",
      );

      yield* adapter.stopSession(asThreadId("thread-copilot-embedded-reasoning"));
    }),
  );

  it.effect("reuses a single reasoning item when Copilot reasoning deltas omit reasoningId", () =>
    Effect.gen(function* () {
      const fakeClient = makeFakeClient({
        models: [],
      });
      mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

      const adapter = yield* GitHubCopilotAdapter;
      const reasoningEventsFiber = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(
            adapter.streamEvents,
            (event) =>
              (event.type === "content.delta" && event.payload.streamKind === "reasoning_text") ||
              (event.type === "item.completed" && event.payload.itemType === "reasoning"),
          ),
          3,
        ),
      ).pipe(Effect.forkChild);

      const threadId = asThreadId("thread-copilot-missing-reasoning-id");

      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId,
        cwd: "/repo",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "Explain the ordering issue.",
      });

      fakeClient.emitSessionEvent({
        id: "event-reasoning-delta-1",
        type: "assistant.reasoning_delta",
        timestamp: "2024-01-01T00:00:02.000Z",
        parentId: null,
        ephemeral: true,
        data: {
          deltaContent: "Inspecting",
        },
      } as SessionEvent);

      fakeClient.emitSessionEvent({
        id: "event-reasoning-delta-2",
        type: "assistant.reasoning_delta",
        timestamp: "2024-01-01T00:00:03.000Z",
        parentId: "event-reasoning-delta-1",
        ephemeral: true,
        data: {
          deltaContent: " the provider timeline",
        },
      } as SessionEvent);

      fakeClient.emitSessionEvent({
        id: "event-reasoning-complete",
        type: "assistant.reasoning",
        timestamp: "2024-01-01T00:00:04.000Z",
        parentId: "event-reasoning-delta-2",
        data: {
          reasoningId: "reasoning-1",
          content: "Inspecting the provider timeline",
        },
      });

      const events = Array.from(yield* Fiber.join(reasoningEventsFiber));
      assert.equal(events.length, 3);

      const reasoningDeltaOne = events[0];
      const reasoningDeltaTwo = events[1];
      const reasoningCompleted = events[2];

      assert.equal(reasoningDeltaOne?.type, "content.delta");
      assert.equal(reasoningDeltaTwo?.type, "content.delta");
      assert.equal(reasoningCompleted?.type, "item.completed");

      if (reasoningDeltaOne?.type !== "content.delta") {
        return;
      }
      if (reasoningDeltaTwo?.type !== "content.delta") {
        return;
      }
      if (reasoningCompleted?.type !== "item.completed") {
        return;
      }

      assert.equal(reasoningDeltaOne.payload.streamKind, "reasoning_text");
      assert.equal(reasoningDeltaTwo.payload.streamKind, "reasoning_text");
      assert.equal(reasoningDeltaOne.itemId, reasoningDeltaTwo.itemId);
      assert.equal(reasoningDeltaTwo.itemId, reasoningCompleted.itemId);
      assert.equal(reasoningDeltaOne.payload.delta, "Inspecting");
      assert.equal(reasoningDeltaTwo.payload.delta, " the provider timeline");
      assert.equal(reasoningCompleted.payload.itemType, "reasoning");
      assert.equal(reasoningCompleted.payload.detail, "Inspecting the provider timeline");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "splits repeated Copilot assistant completions into separate items and preserves provider timestamp order",
    () =>
      Effect.gen(function* () {
        const fakeClient = makeFakeClient({
          models: [],
        });
        mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

        const adapter = yield* GitHubCopilotAdapter;
        const assistantCompletionsFiber = yield* Stream.runCollect(
          Stream.take(
            Stream.filter(
              adapter.streamEvents,
              (event) =>
                event.type === "item.completed" && event.payload.itemType === "assistant_message",
            ),
            2,
          ),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          provider: "githubCopilot",
          threadId: asThreadId("thread-copilot-assistant-segments"),
          cwd: "/repo",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-copilot-assistant-segments"),
          input: "Walk through the changes.",
        });

        fakeClient.emitSessionEvent({
          id: "event-assistant-message-late",
          type: "assistant.message",
          timestamp: "2024-01-01T00:00:02.000Z",
          parentId: null,
          data: {
            messageId: "assistant-message-late",
            content: "Final explanation.",
          },
        });

        fakeClient.emitSessionEvent({
          id: "event-assistant-message-early",
          type: "assistant.message",
          timestamp: "2024-01-01T00:00:01.000Z",
          parentId: null,
          data: {
            messageId: "assistant-message-early",
            content: "Planning the steps.",
          },
        });

        const events = Array.from(yield* Fiber.join(assistantCompletionsFiber));
        assert.equal(events.length, 2);

        const firstCompletion = events[0];
        const secondCompletion = events[1];

        assert.equal(firstCompletion?.type, "item.completed");
        assert.equal(secondCompletion?.type, "item.completed");

        if (firstCompletion?.type !== "item.completed") {
          return;
        }
        if (secondCompletion?.type !== "item.completed") {
          return;
        }

        assert.notStrictEqual(firstCompletion.itemId, secondCompletion.itemId);

        const firstSequence = (
          firstCompletion as typeof firstCompletion & { sessionSequence?: number }
        ).sessionSequence;
        const secondSequence = (
          secondCompletion as typeof secondCompletion & { sessionSequence?: number }
        ).sessionSequence;

        assert.equal(typeof firstSequence, "number");
        assert.equal(typeof secondSequence, "number");
        assert.equal((secondSequence ?? 0) < (firstSequence ?? 0), true);

        yield* adapter.stopSession(asThreadId("thread-copilot-assistant-segments"));
      }),
  );

  it.effect(
    "restarts Copilot sessions on rollback and bootstraps the next prompt from preserved transcript",
    () =>
      Effect.gen(function* () {
        const fakeClient = makeFakeClient({
          models: [],
        });
        mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

        const adapter = yield* GitHubCopilotAdapter;
        const threadId = asThreadId("thread-copilot-rollback");

        yield* adapter.startSession({
          provider: "githubCopilot",
          threadId,
          cwd: "/repo",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId,
          input: "Original prompt",
        });

        fakeClient.emitSessionEvent({
          id: "event-assistant-message-rollback-history",
          type: "assistant.message",
          timestamp: "2024-01-01T00:00:02.000Z",
          parentId: null,
          data: {
            messageId: "assistant-message-rollback-history",
            content: "Original answer",
          },
        });
        fakeClient.emitSessionEvent({
          id: "event-session-idle-original",
          type: "session.idle",
          timestamp: "2024-01-01T00:00:03.000Z",
          parentId: "event-assistant-message-rollback-history",
          ephemeral: true,
          data: {},
        });

        yield* adapter.sendTurn({
          threadId,
          input: "Reverted prompt",
        });
        fakeClient.emitSessionEvent({
          id: "event-assistant-message-reverted-history",
          type: "assistant.message",
          timestamp: "2024-01-01T00:00:04.000Z",
          parentId: null,
          data: {
            messageId: "assistant-message-reverted-history",
            content: "Reverted answer",
          },
        });
        fakeClient.emitSessionEvent({
          id: "event-session-idle-reverted",
          type: "session.idle",
          timestamp: "2024-01-01T00:00:05.000Z",
          parentId: "event-assistant-message-reverted-history",
          ephemeral: true,
          data: {},
        });

        const rolledBack = yield* adapter.rollbackThread(threadId, 1);
        assert.equal(rolledBack.turns.length, 1);
        assert.equal(fakeClient.createSession.mock.calls.length, 2);

        const secondSessionPromise = fakeClient.createSession.mock.results[1]?.value;
        assert.equal(secondSessionPromise !== undefined, true);
        const secondSession = (yield* Effect.promise(
          () => secondSessionPromise as Promise<GitHubCopilotSessionClient>,
        )) as GitHubCopilotSessionClient & {
          send: ReturnType<typeof vi.fn>;
        };

        yield* adapter.sendTurn({
          threadId,
          input: "New prompt",
        });

        const bootstrapPrompt = secondSession.send.mock.calls[0]?.[0]?.prompt;
        assert.equal(typeof bootstrapPrompt, "string");
        assert.equal(
          bootstrapPrompt?.includes(
            "Continue this conversation using the transcript context below.",
          ),
          true,
        );
        assert.equal(bootstrapPrompt?.includes("Original prompt"), true);
        assert.equal(bootstrapPrompt?.includes("Reverted prompt"), false);
        assert.equal(
          bootstrapPrompt?.includes("Latest user request (answer this now):\nNew prompt"),
          true,
        );

        yield* adapter.stopSession(threadId);
      }),
  );
});

fastTimeoutLayer("GitHubCopilotAdapterLive recovery", (it) => {
  it.effect(
    "recovers Copilot turns that never produce runtime activity and force stops the CLI",
    () =>
      Effect.gen(function* () {
        const forceStop = vi.fn(async () => undefined);
        const fakeClient = makeFakeClient({
          models: [],
          stop: vi.fn(() => new Promise<ReadonlyArray<Error>>(() => undefined)),
          forceStop,
        });
        mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

        const adapter = yield* GitHubCopilotAdapter;
        const threadId = asThreadId("thread-copilot-hung");
        const recoveryEventsFiber = yield* Stream.runCollect(
          Stream.take(
            Stream.filter(adapter.streamEvents, (event) => {
              return (
                event.threadId === threadId &&
                (event.type === "runtime.error" ||
                  event.type === "turn.completed" ||
                  event.type === "session.exited")
              );
            }),
            3,
          ),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          provider: "githubCopilot",
          threadId,
          cwd: "/repo",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId,
          input: "Inspect why the runtime hangs.",
        });

        const recoveryEvents = Array.from(yield* Fiber.join(recoveryEventsFiber));
        assert.equal(forceStop.mock.calls.length, 1);

        const runtimeError = recoveryEvents.find((event) => event.type === "runtime.error");
        const turnCompleted = recoveryEvents.find((event) => event.type === "turn.completed");
        const sessionExited = recoveryEvents.find((event) => event.type === "session.exited");

        assert.equal(runtimeError?.type, "runtime.error");
        assert.equal(turnCompleted?.type, "turn.completed");
        assert.equal(sessionExited?.type, "session.exited");

        if (runtimeError?.type !== "runtime.error") {
          return;
        }
        if (turnCompleted?.type !== "turn.completed") {
          return;
        }
        if (sessionExited?.type !== "session.exited") {
          return;
        }

        assert.match(runtimeError.payload.message, /did not produce runtime activity/i);
        assert.equal(turnCompleted.payload.state, "failed");
        assert.match(turnCompleted.payload.errorMessage ?? "", /recovering the session/i);
        assert.equal(sessionExited.payload.exitKind, "error");
        assert.equal(sessionExited.payload.recoverable, true);

        const sessions = yield* adapter.listSessions();
        assert.equal(sessions.length, 0);
      }),
  );

  it.effect("force stops the Copilot CLI when explicit session shutdown hangs", () =>
    Effect.gen(function* () {
      const forceStop = vi.fn(async () => undefined);
      const fakeClient = makeFakeClient({
        models: [],
        stop: vi.fn(() => new Promise<ReadonlyArray<Error>>(() => undefined)),
        forceStop,
      });
      mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

      const adapter = yield* GitHubCopilotAdapter;
      const threadId = asThreadId("thread-copilot-stop-timeout");

      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId,
        cwd: "/repo",
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(threadId);

      assert.equal(forceStop.mock.calls.length, 1);
      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 0);
    }),
  );
});
