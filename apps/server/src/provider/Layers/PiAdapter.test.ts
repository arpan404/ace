import * as NodeServices from "@effect/platform-node/NodeServices";
import { ApprovalRequestId, ThreadId, type ProviderRuntimeEvent } from "@ace/contracts";
import { Effect, Layer, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../piRpcClient.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../piRpcClient.ts")>();
  return {
    ...actual,
    startPiRpcClient: vi.fn(),
  };
});

import { type ServerConfigShape, ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { startPiRpcClient, type PiRpcClient, type PiRpcEvent } from "../piRpcClient.ts";
import { type PiAdapterShape, PiAdapter } from "../Services/PiAdapter.ts";
import { PiAdapterLive } from "./PiAdapter.ts";

const mockedStartPiRpcClient = vi.mocked(startPiRpcClient);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

function collectEvents(
  adapter: PiAdapterShape,
  count: number,
  predicate: (event: ProviderRuntimeEvent) => boolean,
) {
  return Effect.runPromise(
    Stream.runCollect(Stream.take(Stream.filter(adapter.streamEvents, predicate), count)),
  ).then((events) => Array.from(events));
}

function makeFakePiClient(options: {
  readonly requestImpl: (
    command: string,
    payload?: Record<string, unknown>,
    requestOptions?: { readonly timeoutMs?: number },
  ) => Promise<unknown>;
  readonly pid?: number;
}): PiRpcClient & {
  readonly request: ReturnType<typeof vi.fn>;
  readonly notify: ReturnType<typeof vi.fn>;
  emitEvent: (event: PiRpcEvent) => void;
  emitClose: (code?: number | null, signal?: NodeJS.Signals | null) => void;
  emitProtocolError: (error: Error) => void;
} {
  let eventHandler: ((event: PiRpcEvent) => void) | undefined;
  let closeHandler:
    | ((input: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void)
    | undefined;
  let protocolErrorHandler: ((error: Error) => void) | undefined;

  const request = vi.fn(options.requestImpl);
  const notify = vi.fn();

  return {
    child: {
      pid: options.pid ?? 7777,
      kill: vi.fn(() => true),
    } as unknown as PiRpcClient["child"],
    request,
    notify,
    setEventHandler: vi.fn((handler) => {
      eventHandler = handler;
    }),
    setCloseHandler: vi.fn((handler) => {
      closeHandler = handler;
    }),
    setProtocolErrorHandler: vi.fn((handler) => {
      protocolErrorHandler = handler;
    }),
    close: vi.fn(async () => {
      closeHandler?.({ code: 0, signal: null });
    }),
    emitEvent: (event) => {
      eventHandler?.(event);
    },
    emitClose: (code = 0, signal = null) => {
      closeHandler?.({ code, signal });
    },
    emitProtocolError: (error) => {
      protocolErrorHandler?.(error);
    },
  };
}

const adapterLayer = PiAdapterLive.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-test-" })),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(NodeServices.layer),
);

async function withAdapter<T>(
  run: (adapter: PiAdapterShape, config: ServerConfigShape) => Promise<T>,
): Promise<T> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const config = yield* ServerConfig;
        return yield* Effect.promise(() => run(adapter, config));
      }),
    ).pipe(Effect.provide(adapterLayer)),
  );
}

afterEach(() => {
  mockedStartPiRpcClient.mockReset();
});

describe("PiAdapterLive", () => {
  it("syncs Pi model and thought-level selection and emits unsupported mode warnings", async () => {
    const client = makeFakePiClient({
      requestImpl: async (command) => {
        switch (command) {
          case "get_state":
            return {
              sessionId: "pi-session-config",
              model: {
                id: "gpt-5.4",
                provider: "openai",
                name: "GPT-5.4",
                reasoning: true,
                contextWindow: 128_000,
              },
              thinkingLevel: "medium",
            };
          case "get_available_models":
            return {
              models: [
                { id: "gpt-5.4", provider: "openai", name: "GPT-5.4", reasoning: true },
                { id: "gpt-5.5", provider: "openai", name: "GPT-5.5", reasoning: true },
              ],
            };
          case "get_commands":
            return {
              commands: [{ name: "review", description: "Review the workspace" }],
            };
          case "set_model":
            return {
              id: "gpt-5.5",
              provider: "openai",
              name: "GPT-5.5",
              reasoning: true,
              contextWindow: 256_000,
            };
          case "set_thinking_level":
            return {};
          default:
            throw new Error(`Unexpected Pi RPC command: ${command}`);
        }
      },
    });
    mockedStartPiRpcClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        const configuredEventsPromise = collectEvents(
          adapter,
          3,
          (event) => event.type === "session.configured",
        );
        const warningEventsPromise = collectEvents(
          adapter,
          2,
          (event) => event.type === "config.warning",
        );

        const session = await Effect.runPromise(
          adapter.startSession({
            provider: "pi",
            threadId: asThreadId("thread-pi-config"),
            cwd: "/repo/pi-config",
            runtimeMode: "approval-required",
            interactionMode: "plan",
            modelSelection: {
              provider: "pi",
              model: "openai/gpt-5.5",
              options: {
                thoughtLevel: "xhigh",
              },
            },
          }),
        );

        expect(session.model).toBe("openai/gpt-5.5");
        expect(mockedStartPiRpcClient).toHaveBeenCalledWith({
          binaryPath: "pi",
          args: ["--mode", "rpc", "--no-session", "--model", "openai/gpt-5.5"],
          cwd: "/repo/pi-config",
        });
        expect(client.request).toHaveBeenCalledWith(
          "set_model",
          { provider: "openai", modelId: "gpt-5.5" },
          { timeoutMs: 20_000 },
        );
        expect(client.request).toHaveBeenCalledWith(
          "set_thinking_level",
          { level: "xhigh" },
          { timeoutMs: 20_000 },
        );

        const configuredEvents = await configuredEventsPromise;
        expect(configuredEvents).toHaveLength(3);
        const latestConfiguredEvent = configuredEvents.at(-1);
        expect(latestConfiguredEvent?.type).toBe("session.configured");
        if (latestConfiguredEvent?.type !== "session.configured") {
          return;
        }
        expect(latestConfiguredEvent.payload.config.availableCommands).toEqual([
          {
            name: "review",
            description: "Review the workspace",
            kind: "provider",
          },
        ]);
        expect(latestConfiguredEvent.payload.config.configOptions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "model",
              currentValue: "openai/gpt-5.5",
            }),
            expect.objectContaining({
              id: "thought_level",
              currentValue: "xhigh",
            }),
          ]),
        );

        const warningEvents = await warningEventsPromise;
        expect(warningEvents.map((event) => event.type)).toEqual([
          "config.warning",
          "config.warning",
        ]);
        expect(
          warningEvents.map((event) =>
            event.type === "config.warning" ? event.payload.summary : undefined,
          ),
        ).toEqual([
          "Pi does not expose a native plan mode over RPC.",
          "Pi does not expose Codex-style approval mode over RPC.",
        ]);
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("streams assistant, reasoning, and tool events for Pi turns", async () => {
    const client = makeFakePiClient({
      requestImpl: async (command) => {
        switch (command) {
          case "get_state":
            return {
              sessionId: "pi-session-turn",
              model: { id: "gpt-5.4", provider: "openai", name: "GPT-5.4", reasoning: true },
              thinkingLevel: "medium",
            };
          case "get_available_models":
            return {
              models: [{ id: "gpt-5.4", provider: "openai", name: "GPT-5.4", reasoning: true }],
            };
          case "get_commands":
            return { commands: [] };
          case "prompt":
            return {};
          case "get_session_stats":
            return {
              tokens: {
                input: 10,
                output: 20,
                total: 30,
              },
              toolCalls: 1,
            };
          default:
            throw new Error(`Unexpected Pi RPC command: ${command}`);
        }
      },
    });
    mockedStartPiRpcClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        await Effect.runPromise(
          adapter.startSession({
            provider: "pi",
            threadId: asThreadId("thread-pi-turn"),
            cwd: "/repo/pi-turn",
            runtimeMode: "full-access",
          }),
        );

        const turnEventsPromise = collectEvents(
          adapter,
          8,
          (event) =>
            event.type === "turn.started" ||
            event.type === "content.delta" ||
            event.type === "item.started" ||
            event.type === "item.completed" ||
            event.type === "turn.completed",
        );

        const turnStart = await Effect.runPromise(
          adapter.sendTurn({
            threadId: asThreadId("thread-pi-turn"),
            input: "Investigate the failure.",
            interactionMode: "default",
          }),
        );

        expect(client.request).toHaveBeenCalledWith(
          "prompt",
          { message: "Investigate the failure." },
          { timeoutMs: 20_000 },
        );

        client.emitEvent({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "I found the issue." },
        });
        client.emitEvent({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta: "Checking the failing branch." },
        });
        client.emitEvent({
          type: "tool_execution_start",
          toolCallId: "tool-1",
          toolName: "bash",
          args: { command: "npm test" },
        });
        client.emitEvent({
          type: "tool_execution_update",
          toolCallId: "tool-1",
          toolName: "bash",
          args: { command: "npm test" },
          partialResult: {
            content: [{ type: "text", text: "running tests" }],
          },
        });
        client.emitEvent({
          type: "tool_execution_end",
          toolCallId: "tool-1",
          toolName: "bash",
          result: {
            content: [{ type: "text", text: "running tests\nok" }],
          },
          isError: false,
        });
        client.emitEvent({
          type: "turn_end",
          message: { stopReason: "end_turn" },
        });
        client.emitEvent({
          type: "agent_end",
          message: { stopReason: "end_turn" },
        });

        const events = await turnEventsPromise;
        expect(events).toHaveLength(8);
        expect(events[0]?.type).toBe("turn.started");
        expect(events[1]?.type).toBe("content.delta");
        expect(events[2]?.type).toBe("content.delta");
        expect(events[3]?.type).toBe("item.started");
        expect(events[4]?.type).toBe("content.delta");
        expect(events[5]?.type).toBe("content.delta");
        expect(events[6]?.type).toBe("item.completed");
        expect(events[7]?.type).toBe("turn.completed");

        const contentKinds = events.flatMap((event) =>
          event.type === "content.delta" ? [event.payload.streamKind] : [],
        );
        expect(contentKinds).toEqual([
          "assistant_text",
          "reasoning_text",
          "command_output",
          "command_output",
        ]);
        const toolStartEvent = events.find((event) => event.type === "item.started");
        expect(toolStartEvent?.payload).toMatchObject({
          itemType: "command_execution",
          title: "npm test",
        });
        const turnCompletedEvent = events.at(-1);
        expect(turnCompletedEvent?.type).toBe("turn.completed");
        if (turnCompletedEvent?.type !== "turn.completed") {
          return;
        }
        expect(turnCompletedEvent.payload.state).toBe("completed");

        const thread = await Effect.runPromise(adapter.readThread(turnStart.threadId));
        expect(thread.turns).toHaveLength(1);
        expect(thread.turns[0]?.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "assistant_text", text: "I found the issue." }),
            expect.objectContaining({
              kind: "reasoning_text",
              text: "Checking the failing branch.",
            }),
            expect.objectContaining({
              id: expect.any(String),
              itemType: "command_execution",
              status: "completed",
            }),
          ]),
        );
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("keeps the session alive when optional Pi discovery calls fail", async () => {
    const client = makeFakePiClient({
      requestImpl: async (command) => {
        switch (command) {
          case "get_state":
            return {
              sessionId: "pi-session-degraded",
              model: { id: "gpt-5.4", provider: "openai", name: "GPT-5.4", reasoning: true },
              thinkingLevel: "medium",
            };
          case "get_available_models":
            throw new Error("model discovery down");
          case "get_commands":
            throw new Error("command discovery down");
          case "set_session_name":
            throw new Error("rename failed");
          default:
            throw new Error(`Unexpected Pi RPC command: ${command}`);
        }
      },
    });
    mockedStartPiRpcClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        const configuredEventsPromise = collectEvents(
          adapter,
          1,
          (event) => event.type === "session.configured",
        );
        const warningEventsPromise = collectEvents(
          adapter,
          3,
          (event) => event.type === "runtime.warning",
        );

        const session = await Effect.runPromise(
          adapter.startSession({
            provider: "pi",
            threadId: asThreadId("thread-pi-degraded"),
            cwd: "/repo/pi-degraded",
            runtimeMode: "full-access",
            threadTitle: "Rename me",
          }),
        );

        expect(session.status).toBe("ready");
        expect(session.model).toBe("openai/gpt-5.4");

        const [configuredEvent] = await configuredEventsPromise;
        expect(configuredEvent?.type).toBe("session.configured");
        if (configuredEvent?.type !== "session.configured") {
          return;
        }
        expect(configuredEvent.payload.config.availableCommands).not.toEqual([]);

        const warningMessages = (await warningEventsPromise).flatMap((event) =>
          event.type === "runtime.warning" ? [event.payload.message] : [],
        );
        expect(warningMessages).toEqual([
          "rename failed",
          "Pi model discovery failed; Ace continued with the current Pi session state.",
          "Pi command discovery failed; Ace continued with fallback slash commands.",
        ]);
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("fails the active Pi turn and preserves the thread snapshot when the RPC process exits", async () => {
    const client = makeFakePiClient({
      requestImpl: async (command) => {
        switch (command) {
          case "get_state":
            return {
              sessionId: "pi-session-close",
              model: { id: "gpt-5.4", provider: "openai", name: "GPT-5.4", reasoning: true },
              thinkingLevel: "medium",
            };
          case "get_available_models":
            return {
              models: [{ id: "gpt-5.4", provider: "openai", name: "GPT-5.4", reasoning: true }],
            };
          case "get_commands":
            return { commands: [] };
          case "prompt":
            return {};
          default:
            throw new Error(`Unexpected Pi RPC command: ${command}`);
        }
      },
    });
    mockedStartPiRpcClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        await Effect.runPromise(
          adapter.startSession({
            provider: "pi",
            threadId: asThreadId("thread-pi-close"),
            cwd: "/repo/pi-close",
            runtimeMode: "full-access",
          }),
        );

        const turnStartedPromise = collectEvents(
          adapter,
          1,
          (event) => event.type === "turn.started",
        );
        const turnStart = await Effect.runPromise(
          adapter.sendTurn({
            threadId: asThreadId("thread-pi-close"),
            input: "Keep running until I stop you.",
            interactionMode: "default",
          }),
        );
        await turnStartedPromise;

        const requestedPromise = collectEvents(
          adapter,
          1,
          (event) => event.type === "user-input.requested",
        );
        client.emitEvent({
          type: "extension_ui_request",
          id: "ui-close-1",
          method: "confirm",
          title: "Confirm action",
          message: "Continue the running task?",
        });
        const [requestedEvent] = await requestedPromise;
        expect(requestedEvent?.type).toBe("user-input.requested");
        if (requestedEvent?.type !== "user-input.requested") {
          return;
        }

        const closeEventsPromise = collectEvents(
          adapter,
          6,
          (event) =>
            event.type === "user-input.resolved" ||
            event.type === "turn.completed" ||
            event.type === "session.state.changed" ||
            event.type === "session.exited" ||
            event.type === "runtime.error",
        );
        client.emitClose(23, null);

        const closeEvents = await closeEventsPromise;
        expect(closeEvents.map((event) => event.type)).toEqual([
          "user-input.resolved",
          "turn.completed",
          "session.state.changed",
          "session.state.changed",
          "session.exited",
          "runtime.error",
        ]);

        const resolvedEvent = closeEvents[0];
        expect(resolvedEvent?.type).toBe("user-input.resolved");
        if (resolvedEvent?.type === "user-input.resolved") {
          expect(resolvedEvent.requestId).toBe(String(requestedEvent.requestId));
          expect(resolvedEvent.payload.answers).toEqual({});
        }

        const turnCompletedEvent = closeEvents[1];
        expect(turnCompletedEvent?.type).toBe("turn.completed");
        if (turnCompletedEvent?.type === "turn.completed") {
          expect(turnCompletedEvent.payload.state).toBe("failed");
          expect(turnCompletedEvent.payload.errorMessage).toContain("code=23");
        }

        const sessionStateEvents = closeEvents.filter(
          (event) => event.type === "session.state.changed",
        );
        expect(sessionStateEvents).toHaveLength(2);
        expect(
          sessionStateEvents.flatMap((event) =>
            event.type === "session.state.changed" ? [event.payload.state] : [],
          ),
        ).toEqual(["error", "error"]);

        const exitedEvent = closeEvents.find((event) => event.type === "session.exited");
        expect(exitedEvent?.payload).toMatchObject({
          exitKind: "error",
          recoverable: true,
        });

        const runtimeErrorEvent = closeEvents.find((event) => event.type === "runtime.error");
        expect(runtimeErrorEvent?.payload).toMatchObject({
          class: "transport_error",
          message: expect.stringContaining("code=23"),
        });

        const thread = await Effect.runPromise(adapter.readThread(turnStart.threadId));
        expect(thread.turns).toHaveLength(1);
        expect(thread.turns[0]?.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: String(requestedEvent.requestId),
              kind: "user_input",
              answers: {},
            }),
          ]),
        );

        const [session] = await Effect.runPromise(adapter.listSessions());
        expect(session).toMatchObject({
          status: "error",
          activeTurnId: undefined,
          lastError: expect.stringContaining("code=23"),
        });
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("responds to Pi confirm extension UI requests", async () => {
    const client = makeFakePiClient({
      requestImpl: async (command) => {
        switch (command) {
          case "get_state":
            return {
              sessionId: "pi-session-confirm",
              model: { id: "gpt-5.4", provider: "openai", name: "GPT-5.4" },
            };
          case "get_available_models":
            return {
              models: [{ id: "gpt-5.4", provider: "openai", name: "GPT-5.4" }],
            };
          case "get_commands":
            return { commands: [] };
          default:
            throw new Error(`Unexpected Pi RPC command: ${command}`);
        }
      },
    });
    mockedStartPiRpcClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        await Effect.runPromise(
          adapter.startSession({
            provider: "pi",
            threadId: asThreadId("thread-pi-confirm"),
            cwd: "/repo/pi-confirm",
            runtimeMode: "full-access",
          }),
        );

        const requestedPromise = collectEvents(
          adapter,
          1,
          (event) => event.type === "user-input.requested",
        );
        client.emitEvent({
          type: "extension_ui_request",
          id: "ui-confirm-1",
          method: "confirm",
          title: "Confirm write",
          message: "Allow the write?",
        });

        const [requestedEvent] = await requestedPromise;
        expect(requestedEvent?.type).toBe("user-input.requested");
        if (requestedEvent?.type !== "user-input.requested" || !requestedEvent.requestId) {
          return;
        }
        expect(requestedEvent.payload.questions).toEqual([
          {
            id: "confirm",
            header: "Confirm write",
            question: "Allow the write?",
            options: [
              { label: "Confirm", description: "Continue" },
              { label: "Decline", description: "Do not continue" },
            ],
          },
        ]);

        const resolvedPromise = collectEvents(
          adapter,
          1,
          (event) => event.type === "user-input.resolved",
        );
        await Effect.runPromise(
          adapter.respondToUserInput(
            asThreadId("thread-pi-confirm"),
            ApprovalRequestId.makeUnsafe(String(requestedEvent.requestId)),
            { confirm: "Confirm" },
          ),
        );

        const [resolvedEvent] = await resolvedPromise;
        expect(resolvedEvent?.type).toBe("user-input.resolved");
        expect(client.notify).toHaveBeenCalledWith("extension_ui_response", {
          id: "ui-confirm-1",
          confirmed: true,
        });
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("responds to Pi select extension UI requests", async () => {
    const client = makeFakePiClient({
      requestImpl: async (command) => {
        switch (command) {
          case "get_state":
            return {
              sessionId: "pi-session-select",
              model: { id: "gpt-5.4", provider: "openai", name: "GPT-5.4" },
            };
          case "get_available_models":
            return {
              models: [{ id: "gpt-5.4", provider: "openai", name: "GPT-5.4" }],
            };
          case "get_commands":
            return { commands: [] };
          default:
            throw new Error(`Unexpected Pi RPC command: ${command}`);
        }
      },
    });
    mockedStartPiRpcClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        await Effect.runPromise(
          adapter.startSession({
            provider: "pi",
            threadId: asThreadId("thread-pi-select"),
            cwd: "/repo/pi-select",
            runtimeMode: "full-access",
          }),
        );

        const requestedPromise = collectEvents(
          adapter,
          1,
          (event) => event.type === "user-input.requested",
        );
        client.emitEvent({
          type: "extension_ui_request",
          id: "ui-select-1",
          method: "select",
          title: "Pick a model",
          options: ["Alpha", "Beta"],
        });

        const [requestedEvent] = await requestedPromise;
        expect(requestedEvent?.type).toBe("user-input.requested");
        if (requestedEvent?.type !== "user-input.requested" || !requestedEvent.requestId) {
          return;
        }

        await Effect.runPromise(
          adapter.respondToUserInput(
            asThreadId("thread-pi-select"),
            ApprovalRequestId.makeUnsafe(String(requestedEvent.requestId)),
            { select: "Beta" },
          ),
        );

        expect(client.notify).toHaveBeenCalledWith("extension_ui_response", {
          id: "ui-select-1",
          value: "Beta",
        });
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });
});
