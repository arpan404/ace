import type { ClientApi } from "@ace/client";
import { expect, test } from "vitest";
import { ConversationFollow } from "./conversation-follow.ts";
import type { DesktopSpade, DirectAnswer, DirectLiveEvent } from "./desktop-spade.ts";
import { SpadeTransport } from "./spade-transport.ts";

const selection = <T>(value: T) => ({ getSnapshot: () => value, subscribe: () => () => {} });

/**
 * A connection whose `spade.http` history reads wait until the test answers them, and which
 * records every one-way message the follow sends. `drop` and `welcome` move it out of and back
 * into ready.
 */
function fakeClient() {
  const sent: { type: string; requestId?: string; path?: string }[] = [];
  const reads: ((body: string) => void)[] = [];
  const listeners = new Set<(message: unknown) => void>();
  const watchers = new Set<() => void>();
  let state = "ready";
  const client = {
    get state() {
      return state;
    },
    connectionState: () => ({
      getSnapshot: () => state,
      subscribe: (watcher: () => void) => {
        watchers.add(watcher);
        return () => watchers.delete(watcher);
      },
    }),
    connectionGeneration: () => selection(1),
    onMessage: (listener: (message: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: (message: { type: string; requestId?: string; path?: string }) => void sent.push(message),
    request: (input: { type: string }, options?: { requestId?: string }) =>
      new Promise((resolve) => {
        if (input.type === "host.identity")
          return resolve({ type: "host.identity.result", identity: { hostId: "host-a" } });
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
  const move = (next: string) => {
    state = next;
    for (const watcher of watchers) watcher();
  };
  return {
    client: client as unknown as ClientApi,
    sent,
    reads,
    frame,
    drop: () => move("connecting"),
    welcome: () => move("ready"),
  };
}

/**
 * The desktop app's `window.ace.spade` with a Spade the test plays: requests are answered by
 * `answer`, and the test sends live events with `live`.
 */
function fakeDesktop(answer: (path: string) => DirectAnswer) {
  const opened: { streamId: string; path: string }[] = [];
  const closed: string[] = [];
  const asked: string[] = [];
  const liveListeners = new Set<(event: DirectLiveEvent) => void>();
  const desktop: DesktopSpade = {
    localHost: async () => "host-a",
    health: async () => ({ version: "0.4.0" }),
    request: async ({ path }) => {
      asked.push(path);
      return answer(path);
    },
    openLive: async (streamId, path) => void opened.push({ streamId, path }),
    closeLive: async (streamId) => void closed.push(streamId),
    onLive: (listener) => {
      liveListeners.add(listener);
      return () => liveListeners.delete(listener);
    },
    onEndpointChanged: () => () => {},
  };
  const live = (event: DirectLiveEvent) => {
    for (const listener of liveListeners) listener(event);
  };
  return { desktop, opened, closed, asked, live };
}

const ids = (() => {
  let next = 0;
  return () => `id-${++next}`;
})();
const transport = (client: ClientApi, desktop?: DesktopSpade) =>
  new SpadeTransport(client, desktop, { id: ids, now: () => 0 });
const deps = {
  frame: (callback: () => void) => callback(),
  later: () => () => {},
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
const subscribes = (sent: { type: string; requestId?: string; path?: string }[]) =>
  sent.filter((message) => message.type === "spade.live.subscribe");

test("a conversation closed while its history loads never opens a live stream", async () => {
  const { client, sent, reads } = fakeClient();
  const follow = new ConversationFollow(transport(client), "c1", deps);
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
  const follow = new ConversationFollow(transport(client), "c1", deps);
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
  const follow = new ConversationFollow(transport(fake.client), "c1", deps);
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

const stored = (seq: number) => ({
  seq,
  at: seq,
  event: { type: "user_message", text: `m${seq}` },
});
const text = (body: unknown): DirectAnswer => ({
  kind: "text",
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

test("after the daemon socket drops, the stream resumes after the last message once it is back", async () => {
  const { follow, frame, sent, drop, welcome } = await following();
  frame("stored", stored(1));
  frame("stored", stored(2));
  drop();
  expect(subscribes(sent)).toHaveLength(1);
  welcome();
  expect(subscribes(sent).at(-1)?.path).toBe("/v1/conversations/c1/live?after=2");
  follow.stop();
});

test("in the desktop app the conversation is read and followed straight from Spade", async () => {
  const fake = fakeClient();
  const spade = fakeDesktop(() => text([stored(1)]));
  const follow = new ConversationFollow(transport(fake.client, spade.desktop), "c1", deps);
  follow.start();
  follow.setReady(true);
  await flush();
  expect(spade.asked).toEqual(["/v1/conversations/c1/events?after=0&limit=200"]);
  expect(spade.opened.map((stream) => stream.path)).toEqual(["/v1/conversations/c1/live?after=1"]);
  expect(fake.sent).toEqual([]);
  const [stream] = spade.opened;
  spade.live({
    streamId: stream?.streamId ?? "",
    kind: "frame",
    event: "stored",
    data: JSON.stringify(stored(2)),
  });
  await flush();
  expect(follow.lastSeq).toBe(2);
  follow.stop();
  expect(spade.closed).toEqual([stream?.streamId]);
});

test("when Spade isn't at its address, the stream falls back to the daemon where it left off", async () => {
  const fake = fakeClient();
  const spade = fakeDesktop(() => text([]));
  const follow = new ConversationFollow(transport(fake.client, spade.desktop), "c1", deps);
  follow.start();
  follow.setReady(true);
  await flush();
  const [stream] = spade.opened;
  const streamId = stream?.streamId ?? "";
  spade.live({ streamId, kind: "frame", event: "stored", data: JSON.stringify(stored(3)) });
  spade.live({ streamId, kind: "ended", reason: "unreachable", status: undefined });
  await flush();
  expect(subscribes(fake.sent).map((message) => message.path)).toEqual([
    "/v1/conversations/c1/live?after=3",
  ]);
  follow.stop();
});

test("a request Spade can't be reached for directly goes through the daemon", async () => {
  const fake = fakeClient();
  const spade = fakeDesktop(() => ({ kind: "unreachable" }));
  const follow = new ConversationFollow(transport(fake.client, spade.desktop), "c1", deps);
  follow.start();
  follow.setReady(true);
  await flush();
  expect(spade.asked).toHaveLength(1);
  // The history read went the daemon's way and waits there for its answer.
  fake.reads.shift()?.(JSON.stringify([stored(1)]));
  await flush();
  expect(subscribes(fake.sent).map((message) => message.path)).toEqual([
    "/v1/conversations/c1/live?after=1",
  ]);
  follow.stop();
});
