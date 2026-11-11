import type { ClientApi } from "@ace/client";
import { expect, test } from "vitest";
import { ConversationFollow } from "./conversation-follow.ts";

const selection = <T>(value: T) => ({ getSnapshot: () => value, subscribe: () => () => {} });

/**
 * A ready connection whose `spade.http` history reads wait until the test answers them, and
 * which records every one-way message the follow sends.
 */
function fakeClient() {
  const sent: { type: string; requestId?: string; path?: string }[] = [];
  const reads: ((body: string) => void)[] = [];
  const listeners = new Set<(message: unknown) => void>();
  const client = {
    state: "ready",
    connectionState: () => selection("ready"),
    connectionGeneration: () => selection(1),
    onMessage: (listener: (message: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: (message: { type: string; requestId?: string; path?: string }) => void sent.push(message),
    request: (input: { type: string }, options?: { requestId?: string }) =>
      new Promise((resolve) => {
        if (input.type !== "spade.http") return;
        reads.push((body) =>
          resolve({
            type: "spade.http.result",
            requestId: options?.requestId ?? "",
            result: { kind: "response", status: 200, body, encoding: "text" },
          }),
        );
      }),
  };
  // The follow reads only these members of the client.
  /** One frame of the open live stream. */
  const frame = (event: string, data: unknown) => {
    const live = sent.findLast((message) => message.type === "spade.live.subscribe");
    for (const listener of listeners)
      listener({
        type: "spade.live.frame",
        requestId: live?.requestId,
        event,
        data: JSON.stringify(data),
      });
  };
  return { client: client as unknown as ClientApi, sent, reads, frame };
}

const deps = {
  id: (() => {
    let next = 0;
    return () => `id-${++next}`;
  })(),
  frame: (callback: () => void) => callback(),
  later: () => () => {},
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
const subscribes = (sent: { type: string; requestId?: string; path?: string }[]) =>
  sent.filter((message) => message.type === "spade.live.subscribe");

test("a conversation closed while its history loads never opens a live stream", async () => {
  const { client, sent, reads } = fakeClient();
  const follow = new ConversationFollow(client, "c1", deps);
  follow.start();
  follow.setReady(true);
  await flush();
  follow.stop();
  reads.shift()?.("[]");
  await flush();
  expect(subscribes(sent)).toEqual([]);
});

test("the live stream opens after the history, and closes when the conversation does", async () => {
  const { client, sent, reads } = fakeClient();
  const follow = new ConversationFollow(client, "c1", deps);
  follow.start();
  follow.setReady(true);
  await flush();
  reads.shift()?.(JSON.stringify([{ seq: 1, at: 1, event: { type: "user_message", text: "Hi" } }]));
  await flush();
  const [live] = subscribes(sent);
  expect(live?.path).toBe("/v1/conversations/c1/live?after=1");
  follow.stop();
  expect(sent.at(-1)).toEqual({ type: "spade.live.unsubscribe", requestId: live?.requestId });
});

/** A follow with its history read and its live stream open. */
async function following() {
  const fake = fakeClient();
  const follow = new ConversationFollow(fake.client, "c1", deps);
  follow.start();
  follow.setReady(true);
  await flush();
  fake.reads.shift()?.("[]");
  await flush();
  return { ...fake, follow };
}

test("a message whose send got no answer counts as sent once Spade's copy arrives", async () => {
  const { follow, frame } = await following();
  follow.apply({ kind: "sent", key: "local-1", text: "Hi" });
  const reached = follow.reached("local-1");
  frame("stored", { seq: 1, at: 1, event: { type: "user_message", text: "Hi" } });
  expect(await reached).toBe(true);
  follow.stop();
});

test("a message Spade never stored doesn't count once the stream has caught up", async () => {
  const { follow, frame } = await following();
  follow.apply({ kind: "sent", key: "local-1", text: "Hi" });
  const reached = follow.reached("local-1");
  frame("caught_up", { seq: 0 });
  expect(await reached).toBe(false);
  follow.stop();
});
