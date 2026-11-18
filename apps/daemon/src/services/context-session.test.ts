import { expect, it } from "vitest";
import { ThreadId, type ServerMessage } from "@ace/protocol";
import { createContextSession } from "./context.ts";
import type { SocketContext, SocketMessage } from "./socket.ts";

const threadId = ThreadId.parse("main");

function request(requestId: string): SocketMessage {
  return {
    type: "context.request",
    requestId,
    operation: { op: "mention.complete", threadId, query: "sr", limit: 10 },
  };
}

function setup() {
  const sent: ServerMessage[] = [];
  const asked: { path: string; query: string; limit: number }[] = [];
  const handled: unknown[] = [];
  let connected = true;
  let scope = true;
  let readable = true;
  let answer: (() => Promise<string[]>) | undefined;

  const session = createContextSession({
    options: {
      store: {
        getThread: () => ({ deletedAt: undefined }),
        executionWorkspace: () => ({ ready: true, path: "/w" }),
      },
      filesNative: {
        tool: {
          quickOpen: (path: string, query: string, limit: number) => {
            asked.push({ path, query, limit });
            return answer ? answer() : Promise.resolve(["src/main.ts"]);
          },
        },
      },
      context: {
        handle: (async (_device: string, message: SocketMessage) => {
          handled.push(message);
          return {
            type: "context.result",
            requestId: "requestId" in message ? message.requestId : "",
            result: { kind: "completion", paths: ["fallback.ts"] },
          };
        }) as unknown as NonNullable<SocketContext["options"]["context"]>["handle"],
      },
    },
    authorize: () => scope,
    canReadThread: () => readable,
    connected: () => connected,
    send: (message) => sent.push(message),
    tasks: new Set(),
  } as unknown as SocketContext);

  return {
    session,
    sent,
    asked,
    handled,
    revokeRead: () => {
      scope = false;
    },
    revokeThread: () => {
      readable = false;
    },
    disconnect: () => {
      connected = false;
    },
    answerWith: (fn: () => Promise<string[]>) => {
      answer = fn;
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

it("drops a native quick open whose thread access is revoked while the index answers", async () => {
  const fixture = setup();
  const pending = Promise.withResolvers<string[]>();
  fixture.answerWith(() => pending.promise);
  await fixture.session.handle?.(request("quick"), "device");
  await settle();
  fixture.revokeThread();
  pending.resolve(["src/main.ts"]);
  await settle();
  expect(fixture.sent).toEqual([
    {
      type: "context.result",
      requestId: "quick",
      result: { kind: "error", code: "forbidden", message: "read scope required" },
    },
  ]);
  expect(fixture.handled).toEqual([]);
});

it("does not run a queued native quick open after the socket loses its scope", async () => {
  const fixture = setup();
  const first = Promise.withResolvers<string[]>();
  fixture.answerWith(() => first.promise);
  await fixture.session.handle?.(request("first"), "device");
  await fixture.session.handle?.(request("second"), "device");
  await settle();
  expect(fixture.asked).toHaveLength(1);
  fixture.revokeRead();
  first.resolve(["src/main.ts"]);
  await settle();
  expect(fixture.asked).toHaveLength(1);
  expect(fixture.sent).toEqual([
    {
      type: "context.result",
      requestId: "first",
      result: { kind: "error", code: "forbidden", message: "read scope required" },
    },
    {
      type: "context.result",
      requestId: "second",
      result: { kind: "error", code: "forbidden", message: "read scope required" },
    },
  ]);
  expect(fixture.handled).toEqual([]);
});

it("drops a native quick open whose socket disconnected while the index answers", async () => {
  const fixture = setup();
  const pending = Promise.withResolvers<string[]>();
  fixture.answerWith(() => pending.promise);
  await fixture.session.handle?.(request("quick"), "device");
  await settle();
  fixture.disconnect();
  pending.resolve(["src/main.ts"]);
  await settle();
  expect(fixture.sent).toMatchObject([
    { type: "context.result", requestId: "quick", result: { kind: "error", code: "forbidden" } },
  ]);
});
