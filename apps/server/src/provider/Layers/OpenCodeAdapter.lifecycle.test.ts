import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@ace/contracts";
import { assert, it } from "@effect/vitest";
import { afterEach, vi } from "vitest";
import { Effect, Layer } from "effect";

vi.mock("../opencodeRuntime.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../opencodeRuntime.ts")>();
  return {
    ...actual,
    startOpenCodeServer: vi.fn(),
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
import { startOpenCodeServer } from "../opencodeRuntime.ts";
import { OpenCodeAdapterLive } from "./OpenCodeAdapter.ts";

const mockedCreateOpenCodeSdkClient = vi.mocked(createOpenCodeSdkClient);
const mockedStartOpenCodeServer = vi.mocked(startOpenCodeServer);

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

function emptyStream(): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {},
  };
}

function makeFakeOpenCodeClient(sessionId: string) {
  return {
    provider: {
      list: vi.fn(async () => ({
        error: undefined,
        data: {
          default: {
            openai: "gpt-5",
          },
        },
      })),
    },
    session: {
      create: vi.fn(async () => ({
        error: undefined,
        data: {
          id: sessionId,
        },
      })),
      delete: vi.fn(async () => ({
        error: undefined,
      })),
    },
    event: {
      subscribe: vi.fn(async () => ({
        stream: emptyStream(),
      })),
    },
  };
}

afterEach(() => {
  mockedCreateOpenCodeSdkClient.mockReset();
  mockedStartOpenCodeServer.mockReset();
});

const layer = it.layer(
  OpenCodeAdapterLive.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("OpenCodeAdapterLive session lifecycle", (it) => {
  it.effect("acquires and releases an OpenCode server handle per T3 session", () =>
    Effect.gen(function* () {
      const firstServerClose = vi.fn(async () => undefined);
      const secondServerClose = vi.fn(async () => undefined);
      const firstClient = makeFakeOpenCodeClient("opencode-session-1");
      const secondClient = makeFakeOpenCodeClient("opencode-session-2");

      mockedStartOpenCodeServer
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
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-opencode-2"),
        cwd: "/repo-b",
        runtimeMode: "full-access",
      });

      assert.equal(mockedStartOpenCodeServer.mock.calls.length, 2);
      assert.equal(mockedCreateOpenCodeSdkClient.mock.calls.length, 2);
      assert.equal(firstClient.session.create.mock.calls.length, 1);
      assert.equal(secondClient.session.create.mock.calls.length, 1);

      yield* adapter.stopSession(asThreadId("thread-opencode-1"));
      assert.equal(firstClient.session.delete.mock.calls.length, 1);
      assert.equal(firstServerClose.mock.calls.length, 1);
      assert.equal(secondServerClose.mock.calls.length, 0);

      yield* adapter.stopSession(asThreadId("thread-opencode-2"));
      assert.equal(secondClient.session.delete.mock.calls.length, 1);
      assert.equal(secondServerClose.mock.calls.length, 1);
    }),
  );
});
