import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@ace/contracts";
import { assert, it } from "@effect/vitest";
import { afterEach, vi } from "vitest";
import { Effect, Fiber, Layer, Option, Stream } from "effect";

vi.mock("../opencodeRuntime.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../opencodeRuntime.ts")>();
  return {
    ...actual,
    startOpenCodeServerIsolated: vi.fn(),
  };
});

vi.mock("../opencodeSdk.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../opencodeSdk.ts")>();
  return {
    ...actual,
    createOpenCodeSdkClient: vi.fn(),
  };
});

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OpenCodeAdapter } from "../Services/OpenCodeAdapter.ts";
import { createOpenCodeSdkClient } from "../opencodeSdk.ts";
import { startOpenCodeServerIsolated } from "../opencodeRuntime.ts";
import { OpenCodeAdapterLive } from "./OpenCodeAdapter.ts";

const mockedCreateOpenCodeSdkClient = vi.mocked(createOpenCodeSdkClient);
const mockedStartOpenCodeServerIsolated = vi.mocked(startOpenCodeServerIsolated);

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

function emptyStream(): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {},
  };
}

function controllableStream<T>() {
  const values: Array<T> = [];
  const waiters: Array<(value: IteratorResult<T>) => void> = [];
  let closed = false;

  const stream: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          const value = values.shift();
          if (value !== undefined) {
            return { value, done: false };
          }
          if (closed) {
            return { value: undefined, done: true };
          }
          return new Promise<IteratorResult<T>>((resolve) => {
            waiters.push(resolve);
          });
        },
      };
    },
  };

  return {
    stream,
    emit(value: T) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value, done: false });
        return;
      }
      values.push(value);
    },
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter({ value: undefined, done: true });
      }
    },
  };
}

function makeFakeOpenCodeClient(
  sessionId: string,
  options?: {
    readonly stream?: AsyncIterable<unknown>;
    readonly fork?: ReturnType<
      typeof vi.fn<
        (input: { readonly sessionID: string; readonly directory: string }) => Promise<{
          readonly error?: unknown;
          readonly data?: { readonly id: string };
        }>
      >
    >;
  },
) {
  return {
    config: {
      providers: vi.fn(async () => ({
        error: undefined,
        data: {
          default: {
            openai: "gpt-5",
          },
          providers: [
            {
              id: "openai",
              name: "OpenAI",
              env: ["OPENAI_API_KEY"],
              models: {
                "gpt-5": {
                  id: "gpt-5",
                  name: "GPT-5",
                  release_date: "2026-01-01",
                  attachment: true,
                  reasoning: true,
                  tool_call: true,
                  limit: {
                    context: 400_000,
                    output: 128_000,
                  },
                },
              },
            },
          ],
        },
      })),
    },
    command: {
      list: vi.fn(async () => ({
        error: undefined,
        data: [],
      })),
    },
    session: {
      create: vi.fn(async (_input?: unknown) => ({
        error: undefined,
        data: {
          id: sessionId,
        },
      })),
      delete: vi.fn(async () => ({
        error: undefined,
      })),
      promptAsync: vi.fn(async () => ({
        error: undefined,
        data: {},
      })),
      ...(options?.fork ? { fork: options.fork } : {}),
    },
    event: {
      subscribe: vi.fn(async () => ({
        stream: options?.stream ?? emptyStream(),
      })),
    },
  };
}

afterEach(() => {
  mockedCreateOpenCodeSdkClient.mockReset();
  mockedStartOpenCodeServerIsolated.mockReset();
});

const layer = it.layer(
  OpenCodeAdapterLive.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("OpenCodeAdapterLive session lifecycle", (it) => {
  it.effect("reports in-session model switching capability", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      assert.deepStrictEqual(adapter.capabilities, {
        sessionModelSwitch: "in-session",
        sessionModelOptionsSwitch: "in-session",
        liveTurnDiffMode: "workspace",
        reviewChangesMode: "git",
        reviewSurface: "git-worktree",
        approvalRequestsMode: "native",
        turnSteeringMode: "queued-message",
        transcriptAuthority: "local",
        historyAuthority: "local-server-session",
        sessionResumeMode: "local-replay",
        sessionForkMode: "local-replay",
        sideConversationMode: "replay-fork",
        providerThreadTargetingMode: "native",
      });
    }),
  );

  it.effect("emits replay fork capabilities when the OpenCode SDK cannot fork sessions", () =>
    Effect.gen(function* () {
      const serverClose = vi.fn(async () => undefined);
      const client = makeFakeOpenCodeClient("opencode-session-replay-capabilities");
      const threadId = asThreadId("thread-opencode-replay-capabilities");

      mockedStartOpenCodeServerIsolated.mockResolvedValueOnce({
        binaryPath: "/bin/opencode",
        url: "http://127.0.0.1:4014",
        close: serverClose,
      });
      mockedCreateOpenCodeSdkClient.mockReturnValueOnce(
        client as unknown as ReturnType<typeof createOpenCodeSdkClient>,
      );

      const adapter = yield* OpenCodeAdapter;
      const configuredFiber = yield* Stream.runHead(
        Stream.filter(
          adapter.streamEvents,
          (event) => event.threadId === threadId && event.type === "session.configured",
        ),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        provider: "opencode",
        threadId,
        cwd: "/repo-replay",
        runtimeMode: "full-access",
      });

      const configuredEvent = yield* Fiber.join(configuredFiber);
      assert.isTrue(Option.isSome(configuredEvent));
      if (!Option.isSome(configuredEvent)) {
        return;
      }
      assert.equal(configuredEvent.value.type, "session.configured");
      if (configuredEvent.value.type !== "session.configured") {
        return;
      }
      assert.deepStrictEqual(configuredEvent.value.payload.config.capabilities, {
        sessionForkMode: "local-replay",
        sideConversationMode: "replay-fork",
        providerThreadTargetingMode: "native",
      });

      yield* adapter.stopSession(threadId);
      assert.equal(serverClose.mock.calls.length, 1);
    }),
  );

  it.effect("emits native fork capabilities when the OpenCode SDK can fork sessions", () =>
    Effect.gen(function* () {
      const serverClose = vi.fn(async () => undefined);
      const fork = vi.fn(async () => ({
        error: undefined,
        data: { id: "opencode-session-native-forked" },
      }));
      const client = makeFakeOpenCodeClient("opencode-session-native-capabilities", { fork });
      const threadId = asThreadId("thread-opencode-native-capabilities");

      mockedStartOpenCodeServerIsolated.mockResolvedValueOnce({
        binaryPath: "/bin/opencode",
        url: "http://127.0.0.1:4015",
        close: serverClose,
      });
      mockedCreateOpenCodeSdkClient.mockReturnValueOnce(
        client as unknown as ReturnType<typeof createOpenCodeSdkClient>,
      );

      const adapter = yield* OpenCodeAdapter;
      const configuredFiber = yield* Stream.runHead(
        Stream.filter(
          adapter.streamEvents,
          (event) => event.threadId === threadId && event.type === "session.configured",
        ),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        provider: "opencode",
        threadId,
        cwd: "/repo-native",
        runtimeMode: "full-access",
      });

      const configuredEvent = yield* Fiber.join(configuredFiber);
      assert.isTrue(Option.isSome(configuredEvent));
      if (!Option.isSome(configuredEvent)) {
        return;
      }
      assert.equal(configuredEvent.value.type, "session.configured");
      if (configuredEvent.value.type !== "session.configured") {
        return;
      }
      assert.deepStrictEqual(configuredEvent.value.payload.config.capabilities, {
        sessionForkMode: "native",
        sideConversationMode: "native-fork",
        providerThreadTargetingMode: "native",
      });

      yield* adapter.stopSession(threadId);
      assert.equal(serverClose.mock.calls.length, 1);
    }),
  );

  it.effect("acquires and releases an OpenCode server handle per T3 session", () =>
    Effect.gen(function* () {
      const firstServerClose = vi.fn(async () => undefined);
      const secondServerClose = vi.fn(async () => undefined);
      const firstClient = makeFakeOpenCodeClient("opencode-session-1");
      const secondClient = makeFakeOpenCodeClient("opencode-session-2");

      mockedStartOpenCodeServerIsolated
        .mockResolvedValueOnce({
          binaryPath: "/bin/opencode",
          url: "http://127.0.0.1:4011",
          close: firstServerClose,
        })
        .mockResolvedValueOnce({
          binaryPath: "/bin/opencode",
          url: "http://127.0.0.1:4012",
          close: secondServerClose,
        });
      mockedCreateOpenCodeSdkClient
        .mockReturnValueOnce(firstClient as unknown as ReturnType<typeof createOpenCodeSdkClient>)
        .mockReturnValueOnce(secondClient as unknown as ReturnType<typeof createOpenCodeSdkClient>);

      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-opencode-1"),
        cwd: "/repo-a",
        threadTitle: "Repo A thread",
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-opencode-2"),
        cwd: "/repo-b",
        threadTitle: "Repo B thread",
        runtimeMode: "full-access",
      });

      assert.equal(mockedStartOpenCodeServerIsolated.mock.calls.length, 2);
      assert.equal(mockedCreateOpenCodeSdkClient.mock.calls.length, 2);
      assert.equal(firstClient.session.create.mock.calls.length, 1);
      assert.equal(secondClient.session.create.mock.calls.length, 1);
      assert.deepStrictEqual(firstClient.session.create.mock.calls[0]?.[0], {
        directory: "/repo-a",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
        title: "Repo A thread",
      });
      assert.deepStrictEqual(secondClient.session.create.mock.calls[0]?.[0], {
        directory: "/repo-b",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
        title: "Repo B thread",
      });

      yield* adapter.stopSession(asThreadId("thread-opencode-1"));
      assert.equal(firstClient.session.delete.mock.calls.length, 1);
      assert.equal(firstServerClose.mock.calls.length, 1);
      assert.equal(secondServerClose.mock.calls.length, 0);

      yield* adapter.stopSession(asThreadId("thread-opencode-2"));
      assert.equal(secondClient.session.delete.mock.calls.length, 1);
      assert.equal(secondServerClose.mock.calls.length, 1);
    }),
  );

  it.effect("does not override OpenCode defaults for approval-required sessions", () =>
    Effect.gen(function* () {
      const serverClose = vi.fn(async () => undefined);
      const client = makeFakeOpenCodeClient("opencode-session-approval");

      mockedStartOpenCodeServerIsolated.mockResolvedValueOnce({
        binaryPath: "/bin/opencode",
        url: "http://127.0.0.1:4013",
        close: serverClose,
      });
      mockedCreateOpenCodeSdkClient.mockReturnValueOnce(
        client as unknown as ReturnType<typeof createOpenCodeSdkClient>,
      );

      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-opencode-approval"),
        cwd: "/repo-c",
        threadTitle: "Repo C thread",
        runtimeMode: "approval-required",
      });

      assert.deepStrictEqual(client.session.create.mock.calls[0]?.[0], {
        directory: "/repo-c",
        title: "Repo C thread",
      });

      yield* adapter.stopSession(asThreadId("thread-opencode-approval"));
      assert.equal(serverClose.mock.calls.length, 1);
    }),
  );

  it.effect("maps OpenCode subtask parts into collab agent items", () =>
    Effect.gen(function* () {
      const serverClose = vi.fn(async () => undefined);
      const events = controllableStream<unknown>();
      const client = makeFakeOpenCodeClient("opencode-session-subtask", {
        stream: events.stream,
      });
      const threadId = asThreadId("thread-opencode-subtask");

      mockedStartOpenCodeServerIsolated.mockResolvedValueOnce({
        binaryPath: "/bin/opencode",
        url: "http://127.0.0.1:4016",
        close: serverClose,
      });
      mockedCreateOpenCodeSdkClient.mockReturnValueOnce(
        client as unknown as ReturnType<typeof createOpenCodeSdkClient>,
      );

      const adapter = yield* OpenCodeAdapter;
      const subtaskFiber = yield* Stream.runHead(
        Stream.filter(
          adapter.streamEvents,
          (event) =>
            event.threadId === threadId &&
            event.type === "item.completed" &&
            event.payload.itemType === "collab_agent_tool_call",
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        provider: "opencode",
        threadId,
        cwd: "/repo-subtask",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Ask a scout subagent to inspect dependencies.",
      });

      events.emit({
        type: "message.part.updated",
        properties: {
          sessionID: "opencode-session-subtask",
          part: {
            id: "part-subtask-1",
            sessionID: "opencode-session-subtask",
            messageID: "message-assistant-1",
            type: "subtask",
            prompt: "Inspect dependency usage.",
            description: "Read-only dependency research",
            agent: "scout",
            model: {
              providerID: "openai",
              modelID: "gpt-5",
            },
            command: "@scout Inspect dependency usage.",
          },
        },
      });

      const subtaskEvent = yield* Fiber.join(subtaskFiber);
      assert.isTrue(Option.isSome(subtaskEvent));
      if (!Option.isSome(subtaskEvent)) {
        return;
      }
      assert.equal(subtaskEvent.value.type, "item.completed");
      if (subtaskEvent.value.type !== "item.completed") {
        return;
      }
      assert.deepStrictEqual((subtaskEvent.value.payload.data as { subagent?: unknown }).subagent, {
        id: "scout",
        type: "opencode subagent",
        name: "scout",
        model: "openai/gpt-5",
      });
      assert.equal(subtaskEvent.value.payload.detail, "Inspect dependency usage.");

      events.close();
      yield* adapter.stopSession(threadId);
      assert.equal(serverClose.mock.calls.length, 1);
    }),
  );

  it.effect("maps OpenCode child sessions into addressable subagent items", () =>
    Effect.gen(function* () {
      const serverClose = vi.fn(async () => undefined);
      const events = controllableStream<unknown>();
      const client = makeFakeOpenCodeClient("opencode-session-parent", {
        stream: events.stream,
      });
      const threadId = asThreadId("thread-opencode-child-session");

      mockedStartOpenCodeServerIsolated.mockResolvedValueOnce({
        binaryPath: "/bin/opencode",
        url: "http://127.0.0.1:4017",
        close: serverClose,
      });
      mockedCreateOpenCodeSdkClient.mockReturnValueOnce(
        client as unknown as ReturnType<typeof createOpenCodeSdkClient>,
      );

      const adapter = yield* OpenCodeAdapter;
      const childSessionFiber = yield* Stream.runHead(
        Stream.filter(
          adapter.streamEvents,
          (event) =>
            event.threadId === threadId &&
            event.type === "item.completed" &&
            event.payload.itemType === "collab_agent_tool_call",
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        provider: "opencode",
        threadId,
        cwd: "/repo-child-session",
        runtimeMode: "full-access",
      });

      events.emit({
        type: "session.created",
        properties: {
          sessionID: "opencode-session-child-scout",
          info: {
            id: "opencode-session-child-scout",
            slug: "child-scout",
            projectID: "project-1",
            directory: "/repo-child-session",
            parentID: "opencode-session-parent",
            title: "Scout dependency review",
            agent: "scout",
            model: {
              providerID: "openai",
              id: "gpt-5",
            },
            version: "1.0.0",
            time: {
              created: 1_742_533_200,
              updated: 1_742_533_200,
            },
          },
        },
      });

      const childSessionEvent = yield* Fiber.join(childSessionFiber);
      assert.isTrue(Option.isSome(childSessionEvent));
      if (!Option.isSome(childSessionEvent)) {
        return;
      }
      assert.equal(childSessionEvent.value.type, "item.completed");
      if (childSessionEvent.value.type !== "item.completed") {
        return;
      }
      assert.deepStrictEqual(
        (childSessionEvent.value.payload.data as { subagent?: unknown }).subagent,
        {
          id: "opencode-session-child-scout",
          type: "opencode subagent",
          name: "scout",
          model: "openai/gpt-5",
        },
      );
      assert.equal(
        (childSessionEvent.value.payload.data as { childProviderThreadId?: unknown })
          .childProviderThreadId,
        "opencode-session-child-scout",
      );
      assert.equal(childSessionEvent.value.payload.detail, "Scout dependency review");

      const childDeltaFiber = yield* Stream.runHead(
        Stream.filter(
          adapter.streamEvents,
          (event) =>
            event.threadId === threadId &&
            event.type === "content.delta" &&
            event.payload.streamKind === "assistant_text",
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.sendTurn({
        threadId,
        providerThreadId: "opencode-session-child-scout",
        input: "Continue the dependency review.",
      });

      const promptAsyncCalls = client.session.promptAsync.mock.calls as unknown as Array<
        [{ readonly sessionID?: string }]
      >;
      assert.equal(promptAsyncCalls[0]?.[0]?.sessionID, "opencode-session-child-scout");

      events.emit({
        type: "message.part.delta",
        properties: {
          sessionID: "opencode-session-child-scout",
          partID: "child-text-part-1",
          field: "text",
          delta: "Child answer.",
        },
      });

      const childDeltaEvent = yield* Fiber.join(childDeltaFiber);
      assert.isTrue(Option.isSome(childDeltaEvent));
      if (!Option.isSome(childDeltaEvent)) {
        return;
      }
      assert.equal(childDeltaEvent.value.type, "content.delta");
      if (childDeltaEvent.value.type !== "content.delta") {
        return;
      }
      assert.equal(
        (childDeltaEvent.value.payload.data as { childProviderThreadId?: unknown })
          .childProviderThreadId,
        "opencode-session-child-scout",
      );
      assert.deepStrictEqual(
        (childDeltaEvent.value.payload.data as { subagent?: unknown }).subagent,
        {
          id: "opencode-session-child-scout",
          type: "opencode subagent",
          name: "scout",
          model: "openai/gpt-5",
        },
      );

      events.close();
      yield* adapter.stopSession(threadId);
      assert.equal(serverClose.mock.calls.length, 1);
    }),
  );
});
