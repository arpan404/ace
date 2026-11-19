import type { ClientApi } from "@ace/client";
import { expect, test } from "vitest";
import { resolveFileMention } from "./file-reference.ts";

const thread = { threadId: "thread-1", root: "/checkout" };
const reference = { path: "socket.ts" };
const fast = { deadlineMs: 2_000, retryMs: 1 };

type Reply = { paths: string[]; ready: boolean };

/** A connection that answers mention.complete from `replies`, one per request. */
function connection(replies: Reply[]) {
  let asked = 0;
  const client = {
    async request() {
      const reply = replies.shift();
      if (!reply) throw new Error("asked once more than the test answers");
      asked++;
      return {
        type: "context.result",
        requestId: "request",
        result: { kind: "completion", paths: reply.paths, ready: reply.ready },
      };
    },
  } as unknown as ClientApi;
  return { client, asked: () => asked };
}

test("a building index is asked again, never remembered as a miss", async () => {
  const { client, asked } = connection([
    { paths: [], ready: false },
    { paths: ["src/socket.ts"], ready: true },
  ]);
  const found = await resolveFileMention(
    client,
    thread,
    reference,
    new AbortController().signal,
    fast,
  );
  expect(found).toEqual({ kind: "file", path: "src/socket.ts" });
  // The ready answer is settled: the same mention in the thread asks nothing more.
  expect(
    await resolveFileMention(client, thread, reference, new AbortController().signal, fast),
  ).toEqual({ kind: "file", path: "src/socket.ts" });
  expect(asked()).toBe(2);
});

test("a query that outlives its deadline stays plain and is asked afresh later", async () => {
  const { client, asked } = connection([
    { paths: [], ready: false },
    { paths: [], ready: false },
    { paths: ["src/socket.ts"], ready: true },
  ]);
  expect(
    await resolveFileMention(client, thread, reference, new AbortController().signal, {
      deadlineMs: 0,
      retryMs: 1,
    }),
  ).toEqual({ kind: "none" });
  expect(asked()).toBe(1);
  expect(
    await resolveFileMention(client, thread, reference, new AbortController().signal, fast),
  ).toEqual({ kind: "file", path: "src/socket.ts" });
  expect(asked()).toBe(3);
});

test("cancelling a mention waiting on a building index ends the wait", async () => {
  const controller = new AbortController();
  const replies: Reply[] = [{ paths: [], ready: false }];
  const client = {
    async request() {
      const reply = replies.shift();
      if (!reply) throw new Error("asked once more than the test answers");
      // The answer arrives while the index builds; the holder then goes away.
      queueMicrotask(() => controller.abort());
      return {
        type: "context.result",
        requestId: "request",
        result: { kind: "completion", paths: reply.paths, ready: reply.ready },
      };
    },
  } as unknown as ClientApi;
  await expect(
    resolveFileMention(client, thread, reference, controller.signal, {
      deadlineMs: 60_000,
      retryMs: 30_000,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
});
