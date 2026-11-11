import type { ClientApi } from "@ace/client";
import { expect, test } from "vitest";
import { ConversationFollow } from "./conversation-follow.ts";

/**
 * A ready connection whose `spade.http` history reads wait until the test answers them, and
 * which records every one-way message the follow sends.
 */
function fakeClient() {
  const sent: { type: string; requestId?: string; path?: string }[] = [];
  const reads: ((body: string) => void)[] = [];
  const selection = <T>(value: T) => ({ getSnapshot: () => value, subscribe: () => () => {} });
  const client = {
    state: "ready",
    connectionState: () => selection("ready"),
    connectionGeneration: () => selection(1),
    onMessage: () => () => {},
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
  return { client: client as unknown as ClientApi, sent, reads };
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
const subscribes = (sent: { type: string }[]) =>
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
