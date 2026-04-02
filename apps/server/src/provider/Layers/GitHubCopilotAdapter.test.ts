import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  AssistantMessageEvent,
  ModelInfo,
  ResumeSessionConfig,
  SessionConfig,
} from "@github/copilot-sdk";
import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { afterEach, vi } from "vitest";
import { Effect, Layer } from "effect";

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
}): GitHubCopilotClientLike & {
  readonly createSession: ReturnType<
    typeof vi.fn<(config: FakeStartConfig) => Promise<GitHubCopilotSessionClient>>
  >;
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

  const createSession = vi.fn(
    async (config: FakeStartConfig): Promise<GitHubCopilotSessionClient> => ({
      sessionId: "copilot-session-1",
      on: vi.fn(() => () => undefined),
      disconnect: vi.fn(async () => undefined),
      send: vi.fn(async () => "message-1"),
      sendAndWait: vi.fn(async () => assistantMessageEvent),
      abort: vi.fn(async () => undefined),
      ...config,
    }),
  );

  return {
    listModels: vi.fn(async () => options.models),
    createSession,
    resumeSession: vi.fn(async (_sessionId: string, _config: ResumeSessionConfig) => {
      throw new Error("resumeSession should not be called in this test");
    }),
    getStatus: vi.fn(async () => ({ version: "test", protocolVersion: 1 })),
    getAuthStatus: vi.fn(async () => ({ isAuthenticated: true, statusMessage: "ok" })),
    stop: vi.fn(async () => []),
  };
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

layer("GitHubCopilotAdapterLive startSession", (it) => {
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
});
