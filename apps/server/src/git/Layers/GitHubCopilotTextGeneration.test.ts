import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  AssistantMessageEvent,
  ModelInfo,
  ResumeSessionConfig,
  SessionConfig,
} from "@github/copilot-sdk";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi, afterEach } from "vitest";

vi.mock("../../provider/githubCopilotSdk.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../provider/githubCopilotSdk.ts")>();
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
} from "../../provider/githubCopilotSdk.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { GitHubCopilotTextGenerationLive } from "./GitHubCopilotTextGeneration.ts";

const mockedCreateGitHubCopilotClient = vi.mocked(createGitHubCopilotClient);

type FakeCreateSessionConfig = SessionConfig;

function makeFakeClient(input: {
  models: ReadonlyArray<ModelInfo>;
  response: string;
}): GitHubCopilotClientLike & {
  readonly createSession: ReturnType<
    typeof vi.fn<(config: FakeCreateSessionConfig) => Promise<GitHubCopilotSessionClient>>
  >;
} {
  const disconnect = vi.fn(async () => undefined);
  const sendAndWait = vi.fn(
    async (): Promise<AssistantMessageEvent> => ({
      id: "assistant-message-1",
      type: "assistant.message",
      timestamp: new Date().toISOString(),
      parentId: null,
      data: {
        messageId: "assistant-message-1",
        content: input.response,
      },
    }),
  );
  const createSession = vi.fn(
    async (config: FakeCreateSessionConfig): Promise<GitHubCopilotSessionClient> => ({
      disconnect,
      on: vi.fn(() => () => undefined),
      send: vi.fn(async () => "message-1"),
      sendAndWait,
      abort: vi.fn(async () => undefined),
      sessionId: "copilot-text-generation-session-1",
      ...config,
    }),
  );

  return {
    listModels: vi.fn(async () => input.models),
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
  GitHubCopilotTextGenerationLive.pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "ace-copilot-text-generation-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("GitHubCopilotTextGenerationLive", (it) => {
  it.effect(
    "forwards Copilot reasoning effort for text generation when the model supports it",
    () =>
      Effect.gen(function* () {
        const fakeClient = makeFakeClient({
          models: [
            {
              id: "gpt-5-mini",
              name: "GPT-5 Mini",
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
          response: JSON.stringify({
            title: "Fix Copilot trait handling",
          }),
        });
        mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "fix the Copilot traits selector",
          modelSelection: {
            provider: "githubCopilot",
            model: "gpt-5-mini",
            options: {
              reasoningEffort: "xhigh",
            },
          },
        });

        expect(generated.title).toBe("Fix Copilot trait handling");
        expect(fakeClient.createSession).toHaveBeenCalledWith(
          expect.objectContaining({
            model: "gpt-5-mini",
            reasoningEffort: "xhigh",
          }),
        );
      }),
  );

  it.effect(
    "strips Copilot reasoning effort for text generation when the model does not support it",
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
          response: JSON.stringify({
            title: "Fix Copilot trait handling",
          }),
        });
        mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

        const textGeneration = yield* TextGeneration;
        yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "fix the Copilot traits selector",
          modelSelection: {
            provider: "githubCopilot",
            model: "gpt-4.1",
            options: {
              reasoningEffort: "high",
            },
          },
        });

        expect(fakeClient.createSession).toHaveBeenCalledWith(
          expect.not.objectContaining({
            reasoningEffort: expect.anything(),
          }),
        );
        expect(fakeClient.createSession).toHaveBeenCalledWith(
          expect.objectContaining({
            model: "gpt-4.1",
          }),
        );
      }),
  );
});
