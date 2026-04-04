import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../cursorAcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cursorAcp")>();
  return {
    ...actual,
    startCursorAcpClient: vi.fn(),
  };
});

import {
  CursorAdapterLive,
  classifyCursorToolItemType,
  describePermissionRequest,
  extractCursorStreamText,
  permissionOptionIdForRuntimeMode,
  requestTypeForCursorTool,
  runtimeItemStatusFromCursorStatus,
  streamKindFromUpdateKind,
} from "./CursorAdapter";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { startCursorAcpClient, type CursorAcpClient } from "../cursorAcp";
import { type CursorAdapterShape, CursorAdapter } from "../Services/CursorAdapter.ts";

const mockedStartCursorAcpClient = vi.mocked(startCursorAcpClient);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeFakeCursorClient(options: {
  readonly requestImpl: (
    method: string,
    params?: unknown,
    requestOptions?: { readonly timeoutMs?: number },
  ) => Promise<unknown>;
}): CursorAcpClient & {
  readonly request: ReturnType<typeof vi.fn>;
} {
  let closeHandler:
    | ((input: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void)
    | undefined;

  const request = vi.fn(options.requestImpl);

  return {
    child: {
      kill: vi.fn(() => true),
    } as unknown as CursorAcpClient["child"],
    request,
    respond: vi.fn(),
    respondError: vi.fn(),
    setNotificationHandler: vi.fn(),
    setRequestHandler: vi.fn(),
    setCloseHandler: vi.fn((handler) => {
      closeHandler = handler;
    }),
    setProtocolErrorHandler: vi.fn(),
    close: vi.fn(async () => {
      closeHandler?.({ code: 0, signal: null });
    }),
  };
}

const adapterLayer = CursorAdapterLive.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "cursor-adapter-test-" })),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(NodeServices.layer),
);

async function withAdapter<T>(run: (adapter: CursorAdapterShape) => Promise<T>): Promise<T> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        return yield* Effect.promise(() => run(adapter));
      }),
    ).pipe(Effect.provide(adapterLayer)),
  );
}

afterEach(() => {
  mockedStartCursorAcpClient.mockReset();
});

describe("permissionOptionIdForRuntimeMode", () => {
  it("auto-approves Cursor ACP tool permissions for full-access sessions", () => {
    expect(permissionOptionIdForRuntimeMode("full-access")).toEqual({
      primary: "allow-always",
      decision: "acceptForSession",
    });
  });

  it("keeps manual approval flow for approval-required sessions", () => {
    expect(permissionOptionIdForRuntimeMode("approval-required")).toEqual({
      primary: "allow-once",
      decision: "accept",
    });
  });
});

describe("streamKindFromUpdateKind", () => {
  it("maps Cursor thought chunks to reasoning text", () => {
    expect(streamKindFromUpdateKind("agent_thought_chunk")).toBe("reasoning_text");
  });

  it("keeps normal assistant chunks as assistant text", () => {
    expect(streamKindFromUpdateKind("agent_message_chunk")).toBe("assistant_text");
  });
});

describe("extractCursorStreamText", () => {
  it("preserves leading and trailing whitespace for streamed chunks", () => {
    expect(extractCursorStreamText({ content: { text: "  hello world  \n" } })).toBe(
      "  hello world  \n",
    );
  });

  it("keeps whitespace-only streamed chunks instead of trimming them away", () => {
    expect(extractCursorStreamText({ text: "   " })).toBe("   ");
  });
});

describe("classifyCursorToolItemType", () => {
  it("classifies execute/terminal tool calls as command execution", () => {
    expect(
      classifyCursorToolItemType({
        kind: "execute",
        title: "Terminal",
      }),
    ).toBe("command_execution");
  });

  it("classifies explore subagent tasks as collab agent tool calls", () => {
    expect(
      classifyCursorToolItemType({
        title: "Explore codebase",
        subagentType: "explore",
      }),
    ).toBe("collab_agent_tool_call");
  });
});

describe("requestTypeForCursorTool", () => {
  it("classifies read-style tools as file-read approvals", () => {
    expect(
      requestTypeForCursorTool({
        kind: "read",
        title: "Read file",
      }),
    ).toBe("file_read_approval");
  });
});

describe("runtimeItemStatusFromCursorStatus", () => {
  it("normalizes Cursor in-progress and completed statuses", () => {
    expect(runtimeItemStatusFromCursorStatus("in_progress")).toBe("inProgress");
    expect(runtimeItemStatusFromCursorStatus("completed")).toBe("completed");
    expect(runtimeItemStatusFromCursorStatus("failed")).toBe("failed");
  });
});

describe("describePermissionRequest", () => {
  it("extracts the command text from Cursor permission requests", () => {
    expect(
      describePermissionRequest({
        toolCall: {
          toolCallId: "tool_123",
          title: "`pwd && ls -la /tmp/repo`",
          kind: "execute",
          status: "pending",
        },
      }),
    ).toBe("pwd && ls -la /tmp/repo");
  });
});

describe("CursorAdapterLive", () => {
  it("uses the current ACP session params for new and resumed sessions", async () => {
    const newClient = makeFakeCursorClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
          case "authenticate":
            return {};
          case "session/new":
            return { sessionId: "cursor-session-new" };
          default:
            throw new Error(`Unexpected Cursor ACP request: ${method}`);
        }
      },
    });
    const resumedClient = makeFakeCursorClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
          case "authenticate":
            return {};
          case "session/load":
            return { sessionId: "cursor-session-existing" };
          default:
            throw new Error(`Unexpected Cursor ACP request: ${method}`);
        }
      },
    });
    mockedStartCursorAcpClient.mockReturnValueOnce(newClient).mockReturnValueOnce(resumedClient);

    await withAdapter(async (adapter) => {
      try {
        const started = await Effect.runPromise(
          adapter.startSession({
            provider: "cursor",
            threadId: asThreadId("thread-new"),
            cwd: "/repo/new",
            runtimeMode: "full-access",
          }),
        );
        expect(started.resumeCursor).toEqual({ sessionId: "cursor-session-new" });
        expect(newClient.request).toHaveBeenNthCalledWith(
          3,
          "session/new",
          {
            cwd: "/repo/new",
            mcpServers: [],
          },
          { timeoutMs: 15_000 },
        );

        const resumed = await Effect.runPromise(
          adapter.startSession({
            provider: "cursor",
            threadId: asThreadId("thread-existing"),
            cwd: "/repo/existing",
            resumeCursor: { sessionId: "cursor-session-existing" },
            runtimeMode: "full-access",
          }),
        );
        expect(resumed.resumeCursor).toEqual({ sessionId: "cursor-session-existing" });
        expect(resumedClient.request).toHaveBeenNthCalledWith(
          3,
          "session/load",
          {
            cwd: "/repo/existing",
            mcpServers: [],
            sessionId: "cursor-session-existing",
          },
          { timeoutMs: 15_000 },
        );
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("waits for an in-flight startup instead of returning a connecting session", async () => {
    const sessionNew = deferred<{ readonly sessionId: string }>();
    const client = makeFakeCursorClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
          case "authenticate":
            return {};
          case "session/new":
            return sessionNew.promise;
          default:
            throw new Error(`Unexpected Cursor ACP request: ${method}`);
        }
      },
    });
    mockedStartCursorAcpClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        const input = {
          provider: "cursor" as const,
          threadId: asThreadId("thread-race"),
          cwd: "/repo/race",
          runtimeMode: "full-access" as const,
        };
        let secondResolved = false;

        const firstStart = Effect.runPromise(adapter.startSession(input));
        await waitForCondition(() =>
          client.request.mock.calls.some(([method]) => method === "session/new"),
        );

        const secondStart = Effect.runPromise(
          adapter.startSession(input).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                secondResolved = true;
              }),
            ),
          ),
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(secondResolved).toBe(false);

        sessionNew.resolve({ sessionId: "cursor-session-race" });

        const [firstSession, secondSession] = await Promise.all([firstStart, secondStart]);
        expect(firstSession.status).toBe("ready");
        expect(firstSession.resumeCursor).toEqual({ sessionId: "cursor-session-race" });
        expect(secondSession.status).toBe("ready");
        expect(secondSession.resumeCursor).toEqual({ sessionId: "cursor-session-race" });
        expect(
          client.request.mock.calls.filter(([method]) => method === "initialize"),
        ).toHaveLength(1);
        expect(
          client.request.mock.calls.filter(([method]) => method === "session/new"),
        ).toHaveLength(1);
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("preserves active-turn send failures without wrapping them in Effect.tryPromise", async () => {
    const promptResult = deferred<{ readonly stopReason: string }>();
    const client = makeFakeCursorClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
          case "authenticate":
            return {};
          case "session/new":
            return { sessionId: "cursor-session-send-turn" };
          case "session/prompt":
            return promptResult.promise;
          default:
            throw new Error(`Unexpected Cursor ACP request: ${method}`);
        }
      },
    });
    mockedStartCursorAcpClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        await Effect.runPromise(
          adapter.startSession({
            provider: "cursor",
            threadId: asThreadId("thread-send-turn"),
            cwd: "/repo/send-turn",
            runtimeMode: "full-access",
          }),
        );

        await Effect.runPromise(
          adapter.sendTurn({
            threadId: asThreadId("thread-send-turn"),
            input: "first prompt",
          }),
        );

        await expect(
          Effect.runPromise(
            adapter.sendTurn({
              threadId: asThreadId("thread-send-turn"),
              input: "second prompt",
            }),
          ),
        ).rejects.toMatchObject({
          _tag: "ProviderAdapterRequestError",
          provider: "cursor",
          method: "session/prompt",
          detail: "Cursor session already has an active turn.",
        });

        promptResult.resolve({ stopReason: "end_turn" });
        await new Promise((resolve) => setTimeout(resolve, 0));
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });
});
