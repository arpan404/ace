import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../acpClient.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acpClient.ts")>();
  return {
    ...actual,
    startAcpClient: vi.fn(),
  };
});

import {
  buildGeminiInitializeParams,
  canGeminiSetSessionMode,
  canGeminiSetSessionModel,
  GeminiAdapterLive,
  GEMINI_ACP_CLIENT_INFO,
} from "./GeminiAdapter.ts";
import { type ServerConfigShape, ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { type AcpClient, startAcpClient } from "../acpClient.ts";
import { type GeminiAdapterShape, GeminiAdapter } from "../Services/GeminiAdapter.ts";

const mockedStartAcpClient = vi.mocked(startAcpClient);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

function geminiInitializeResult() {
  return {
    protocolVersion: 1,
    authMethods: [],
    agentCapabilities: {
      loadSession: true,
    },
  };
}

function geminiSessionResult(
  sessionId: string,
  input?: {
    readonly currentModeId?: string;
    readonly currentModelId?: string;
  },
) {
  const currentModeId = input?.currentModeId ?? "default";
  const currentModelId = input?.currentModelId ?? "gemini-2.5-pro";
  return {
    sessionId,
    modes: {
      currentModeId,
      availableModes: [
        { id: "default", name: "Default", description: "Prompts for approval" },
        { id: "yolo", name: "YOLO", description: "Auto-approves all actions" },
      ],
    },
    models: {
      currentModelId,
      availableModels: [{ modelId: currentModelId, name: "Gemini 2.5 Pro" }],
    },
  };
}

function makeFakeGeminiClient(options: {
  readonly requestImpl: (
    method: string,
    params?: unknown,
    requestOptions?: { readonly timeoutMs?: number },
  ) => Promise<unknown>;
}): AcpClient & {
  readonly request: ReturnType<typeof vi.fn>;
  readonly getRequestHandler: () =>
    | ((request: {
        readonly id: string | number;
        readonly method: string;
        readonly params?: unknown;
      }) => void)
    | undefined;
} {
  let closeHandler:
    | ((input: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void)
    | undefined;
  let requestHandler:
    | ((request: {
        readonly id: string | number;
        readonly method: string;
        readonly params?: unknown;
      }) => void)
    | undefined;

  const request = vi.fn(options.requestImpl);

  return {
    child: {
      kill: vi.fn(() => true),
    } as unknown as AcpClient["child"],
    request,
    notify: vi.fn(),
    respond: vi.fn(),
    respondError: vi.fn(),
    setNotificationHandler: vi.fn(),
    setRequestHandler: vi.fn((handler) => {
      requestHandler = handler;
    }),
    setCloseHandler: vi.fn((handler) => {
      closeHandler = handler;
    }),
    setProtocolErrorHandler: vi.fn(),
    getRequestHandler: () => requestHandler,
    close: vi.fn(async () => {
      closeHandler?.({ code: 0, signal: null });
    }),
  };
}

const adapterLayer = GeminiAdapterLive.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "gemini-adapter-test-" })),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(NodeServices.layer),
);

async function withAdapter<T>(
  run: (adapter: GeminiAdapterShape, config: ServerConfigShape) => Promise<T>,
): Promise<T> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* GeminiAdapter;
        const config = yield* ServerConfig;
        return yield* Effect.promise(() => run(adapter, config));
      }),
    ).pipe(Effect.provide(adapterLayer)),
  );
}

afterEach(() => {
  mockedStartAcpClient.mockReset();
});

describe("buildGeminiInitializeParams", () => {
  it("declares filesystem capabilities required by older Gemini ACP builds", () => {
    expect(buildGeminiInitializeParams()).toEqual({
      protocolVersion: 1,
      clientInfo: GEMINI_ACP_CLIENT_INFO,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: false,
      },
    });
  });
});

describe("Gemini ACP capability guards", () => {
  it("skips mode switching when the session does not advertise modes", () => {
    expect(canGeminiSetSessionMode({ availableModes: [] })).toBe(false);
  });

  it("skips model switching when the session does not advertise models", () => {
    expect(canGeminiSetSessionModel({ availableModels: [] })).toBe(false);
  });

  it("enables control calls when capabilities are advertised", () => {
    expect(canGeminiSetSessionMode({ availableModes: [{ id: "default" }] })).toBe(true);
    expect(canGeminiSetSessionModel({ availableModels: [{ modelId: "gemini-2.5-pro" }] })).toBe(
      true,
    );
  });
});

describe("GeminiAdapterLive approvals", () => {
  it("auto-resolves Gemini permission requests for full-access sessions", async () => {
    const client = makeFakeGeminiClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
            return geminiInitializeResult();
          case "session/new":
            return geminiSessionResult("gemini-session-full-access", {
              currentModeId: "yolo",
            });
          default:
            throw new Error(`Unexpected Gemini ACP request: ${method}`);
        }
      },
    });
    mockedStartAcpClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        await Effect.runPromise(
          adapter.startSession({
            provider: "gemini",
            threadId: asThreadId("thread-gemini-full-access"),
            cwd: "/repo/gemini-full-access",
            runtimeMode: "full-access",
          }),
        );

        await Effect.runPromise(Stream.take(adapter.streamEvents, 2).pipe(Stream.runDrain));

        const requestHandler = client.getRequestHandler();
        expect(requestHandler).toBeTypeOf("function");
        if (!requestHandler) {
          return;
        }

        const resolvedEventPromise = Effect.runPromise(Stream.runHead(adapter.streamEvents));
        requestHandler({
          id: 101,
          method: "session/request_permission",
          params: {
            sessionId: "gemini-session-full-access",
            toolCall: {
              toolCallId: "tool-call-1",
              title: "Write file",
              kind: "edit",
              status: "pending",
            },
            options: [
              { optionId: "allow-session", kind: "allow_always", name: "Allow for session" },
              { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
              { optionId: "deny-once", kind: "reject_once", name: "Deny" },
            ],
          },
        });

        const resolvedEvent = await resolvedEventPromise;
        expect(resolvedEvent._tag).toBe("Some");
        if (resolvedEvent._tag !== "Some") {
          return;
        }

        expect(resolvedEvent.value.type).toBe("request.resolved");
        if (resolvedEvent.value.type !== "request.resolved") {
          return;
        }

        expect(resolvedEvent.value.payload).toEqual({
          requestType: "file_change_approval",
          decision: "acceptForSession",
          resolution: {
            optionId: "allow-session",
            kind: "allow_always",
          },
        });
        expect(client.respond).toHaveBeenCalledWith(101, {
          outcome: {
            outcome: "selected",
            optionId: "allow-session",
          },
        });
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("keeps Gemini permission requests interactive for approval-required sessions", async () => {
    const client = makeFakeGeminiClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
            return geminiInitializeResult();
          case "session/new":
            return geminiSessionResult("gemini-session-approval-required", {
              currentModeId: "default",
            });
          default:
            throw new Error(`Unexpected Gemini ACP request: ${method}`);
        }
      },
    });
    mockedStartAcpClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        await Effect.runPromise(
          adapter.startSession({
            provider: "gemini",
            threadId: asThreadId("thread-gemini-approval-required"),
            cwd: "/repo/gemini-approval-required",
            runtimeMode: "approval-required",
          }),
        );

        await Effect.runPromise(Stream.take(adapter.streamEvents, 2).pipe(Stream.runDrain));

        const requestHandler = client.getRequestHandler();
        expect(requestHandler).toBeTypeOf("function");
        if (!requestHandler) {
          return;
        }

        const openedEventPromise = Effect.runPromise(Stream.runHead(adapter.streamEvents));
        requestHandler({
          id: 202,
          method: "session/request_permission",
          params: {
            sessionId: "gemini-session-approval-required",
            toolCall: {
              toolCallId: "tool-call-2",
              title: "Write file",
              kind: "edit",
              status: "pending",
            },
            options: [
              { optionId: "allow-session", kind: "allow_always", name: "Allow for session" },
              { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
              { optionId: "deny-once", kind: "reject_once", name: "Deny" },
            ],
          },
        });

        const openedEvent = await openedEventPromise;
        expect(openedEvent._tag).toBe("Some");
        if (openedEvent._tag !== "Some") {
          return;
        }

        expect(openedEvent.value.type).toBe("request.opened");
        if (openedEvent.value.type !== "request.opened") {
          return;
        }

        expect(openedEvent.value.payload.requestType).toBe("file_change_approval");
        expect(openedEvent.value.payload.detail).toBe("Write file");
        expect(client.respond).not.toHaveBeenCalled();
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });
});
