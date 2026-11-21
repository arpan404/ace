import { host } from "./test-host.ts";
import { ClientError } from "@ace/client";
import {
  mediaRetryCooldownMs,
  mediaRetryDelaysMs,
  mediaSubscribeDeadlineMs,
  type DeliveryState,
  type MediaRoute,
} from "@ace/browser/live-view";
import { ThreadId, type MediaStreamClientMessage } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import {
  closeBrowserFixtures,
  liveBrowser as live,
  unservedReason,
  viewport,
} from "./browser-fixture.ts";
import { until } from "./sheet-fixture.ts";

/*
 * The phone's live browser view and its media connection (ADR 0147 §4): its subscribe names the
 * open connection, a new connection subscribes it again with a fresh decoder, and the acks of
 * pictures that came by the connection go on it. Only ace-media delivers (ADR 0201): without a
 * connection, or one it can't serve, the view gets no pictures and says why.
 */

afterEach(closeBrowserFixtures);

function connection() {
  let bound: string | undefined;
  const watchers = new Set<() => void>();
  const carried: MediaStreamClientMessage[] = [];
  const route: MediaRoute = {
    binding: () => (bound ? { connection: bound } : undefined),
    codecs: () => [],
    watch: (listener) => {
      watchers.add(listener);
      return () => void watchers.delete(listener);
    },
    onStream: () => () => {},
    ack: (message) => {
      if (!bound) return false;
      carried.push(message);
      return true;
    },
  };
  return {
    route,
    carried,
    bind(next: string | undefined) {
      bound = next;
      for (const listener of Array.from(watchers)) listener();
    },
  };
}

type Subscribe = { type: string; media?: { connection: string } };
const subscribes = (requested: unknown[]) =>
  (requested as Subscribe[]).filter((value) => value.type === "browser.subscribe");

async function opened(
  bound: string | undefined,
  daemon: "binds" | "refuses" | "unserved" = "binds",
) {
  const media = connection();
  media.bind(bound);
  const browser = await live({ media: daemon });
  // What `media.delivery` tells Swift; Swift stamps each ack with the latest generation.
  const deliveries: DeliveryState[] = [];
  browser.view.useMedia(media.route, (_view, state) => deliveries.push(state));
  const delivered = () => deliveries.at(-1)?.generation;
  browser.view.action({ kind: "open", threadId: "web", viewport });
  // A refused subscribe brings no state until the view asks again.
  if (daemon !== "refuses")
    await until(() => browser.sink.read("browser:view")?.state != null, "browser state");
  await until(() => subscribes(browser.requested).length >= 1, "subscribe");
  // The subscribe's reply has landed.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { ...browser, media, deliveries, delivered };
}

test("the view subscribes on the open media connection and acknowledges its pictures there", async () => {
  const { requested, sent, view, media, delivered } = await opened("mc_aaaaaaaa");
  expect(subscribes(requested)[0]?.media).toEqual({ connection: "mc_aaaaaaaa" });

  view.action({ kind: "ack", sequence: 7, keyframe: true, generation: delivered() });
  expect(media.carried).toEqual([
    { type: "browser.ack", threadId: "web", sequence: 7, video: true, keyframe: true },
  ]);
  expect(sent).toEqual([]);
});

test("a new media connection subscribes the view again on it and starts a fresh decoder", async () => {
  const { requested, sink, view, media, delivered } = await opened("mc_aaaaaaaa");
  const before = sink.read("browser:view")?.generation as number;

  media.bind("mc_bbbbbbbb");
  await until(() => subscribes(requested).length === 2, "resubscribe");
  expect(subscribes(requested)[1]?.media).toEqual({ connection: "mc_bbbbbbbb" });
  await until(
    () => (sink.read("browser:view")?.generation as number) > before,
    "a new decoder generation",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.action({ kind: "ack", sequence: 1, generation: delivered() });
  expect(media.carried.at(-1)).toMatchObject({ sequence: 1 });
});

test("losing the media connection leaves the view without pictures, saying why, and its acks go nowhere", async () => {
  const { requested, sent, view, media, deliveries, delivered } = await opened("mc_aaaaaaaa");
  media.bind(undefined);
  await until(() => subscribes(requested).length === 2, "resubscribe");
  expect(subscribes(requested)[1]?.media).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(deliveries.at(-1)).toMatchObject({
    path: "none",
    undelivered: { code: "connecting" },
  });

  view.action({ kind: "ack", sequence: 3, generation: delivered() });
  expect(media.carried).toEqual([]);
  expect(sent).toEqual([]);
});

test("every subscribe says the phone takes pictures only from its media connection", async () => {
  for (const bound of ["mc_aaaaaaaa", undefined]) {
    const { requested } = await opened(bound);
    expect(subscribes(requested)[0]).toMatchObject({ mediaClient: true, deliveryStatus: true });
    await closeBrowserFixtures();
  }
});

test("a daemon that can't serve the view yet says why, and the view asks again on the unserved ladder", async () => {
  const { requested, sent, view, media, deliveries, delivered, elapse } = await opened(
    "mc_aaaaaaaa",
    "unserved",
  );
  expect(subscribes(requested)[0]?.media).toEqual({ connection: "mc_aaaaaaaa" });
  expect(deliveries.at(-1)).toMatchObject({ path: "none", undelivered: unservedReason });
  view.action({ kind: "ack", sequence: 6, generation: delivered() });
  expect(media.carried).toEqual([]);
  expect(sent).toEqual([]);
  // The view's own 5 s poll doesn't cancel the wait; the ladder's first step asks again.
  elapse(5_000);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(subscribes(requested)).toHaveLength(1);
  elapse(mediaRetryDelaysMs[0]);
  await until(() => subscribes(requested).length === 2, "asked again");
  expect(subscribes(requested)[1]?.media).toEqual({ connection: "mc_aaaaaaaa" });
});

test("the machine's word that a bound view's source isn't streaming reaches Swift", async () => {
  const { deliveries, announce } = await opened("mc_aaaaaaaa");
  expect(deliveries.at(-1)).toMatchObject({ path: "mc_aaaaaaaa" });
  expect(deliveries.at(-1)?.undelivered).toBeUndefined();
  announce({
    type: "browser.delivery",
    threadId: ThreadId.parse("web"),
    undelivered: unservedReason,
  });
  expect(deliveries.at(-1)).toMatchObject({ path: "mc_aaaaaaaa", undelivered: unservedReason });
  // Another thread's word is not this view's.
  const count = deliveries.length;
  announce({
    type: "browser.delivery",
    threadId: ThreadId.parse("other"),
    undelivered: unservedReason,
  });
  expect(deliveries).toHaveLength(count);
});

test("a refused media connection is named no more, and the view asks again on the ladder", async () => {
  const { requested, sent, view, media, delivered, elapse } = await opened(
    "mc_aaaaaaaa",
    "refuses",
  );
  elapse(mediaRetryDelaysMs[0]);
  await until(() => subscribes(requested).length === 2, "subscribe without the connection");
  expect(subscribes(requested)[1]?.media).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.action({ kind: "ack", sequence: 8, generation: delivered() });
  expect(media.carried).toEqual([]);
  expect(sent).toEqual([]);
});

test("after a rebind, an ack stamped with the old delivery goes nowhere", async () => {
  const { requested, sent, view, media, delivered } = await opened("mc_aaaaaaaa");
  const before = delivered();
  media.bind("mc_bbbbbbbb");
  await until(() => subscribes(requested).length === 2, "resubscribe");
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.action({ kind: "ack", sequence: 40, generation: before });
  expect(media.carried).toEqual([]);
  expect(sent).toEqual([]);
  view.action({ kind: "ack", sequence: 1, generation: delivered() });
  expect(media.carried).toEqual([expect.objectContaining({ sequence: 1 })]);
});

test("a subscribe that fails after the view's retry fired is settled and asked again", async () => {
  const media = connection();
  media.bind("mc_aaaaaaaa");
  const browser = await live({ media: "hangs" });
  const deliveries: DeliveryState[] = [];
  browser.view.useMedia(media.route, (_view, state) => deliveries.push(state));
  browser.view.action({ kind: "open", threadId: "web", viewport });
  await until(() => browser.hanging.length === 1, "a subscribe left waiting");
  // The view's retry (every 5 s) fires while that subscribe is still out: it sends nothing more.
  browser.elapse(5_000);
  expect(subscribes(browser.requested)).toHaveLength(1);
  expect(deliveries.at(-1)?.path).toBeUndefined();

  browser.hanging[0]?.(new ClientError("offline"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Swift stops holding pictures for it, and the view asks again.
  expect(deliveries.at(-1)).toMatchObject({ path: "none", undelivered: { code: "failed" } });
  // On the shared ladder: its first wait is a second.
  browser.elapse(1_000);
  await until(() => subscribes(browser.requested).length === 2, "the subscribe asked again");
});

test("a decoder failure from before a resubscribe doesn't drop the view to H.264", async () => {
  Object.assign(host, { video: { decoders: () => ["hvc1.1.6.L153.B0", "avc1.42E033"] } });
  try {
    const { requested, view, media, delivered } = await opened("mc_aaaaaaaa");
    const before = delivered();
    media.bind("mc_bbbbbbbb");
    await until(() => subscribes(requested).length === 2, "resubscribe");
    await new Promise((resolve) => setTimeout(resolve, 0));
    // HEVC failed in the decoder of the earlier subscribe; its report arrives late.
    view.action({ kind: "ack", sequence: 9, keyframe: true, fallback: true, generation: before });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(subscribes(requested)).toHaveLength(2);
    // The current subscribe's decoder failing still falls back.
    view.action({
      kind: "ack",
      sequence: 1,
      keyframe: true,
      fallback: true,
      generation: delivered(),
    });
    await until(() => subscribes(requested).length === 3, "H.264 subscribe");
    expect(requested.at(-1)).toMatchObject({ video: { codecs: ["avc1.42E033"] } });
  } finally {
    Reflect.deleteProperty(host, "video");
  }
});

/** A view whose subscribes naming the media connection never get an answer until failed. */
async function hanging() {
  const media = connection();
  media.bind("mc_aaaaaaaa");
  const browser = await live({ media: "hangs" });
  const deliveries: DeliveryState[] = [];
  browser.view.useMedia(media.route, (_view, state) => deliveries.push(state));
  browser.view.action({ kind: "open", threadId: "web", viewport });
  await until(() => browser.hanging.length === 1, "a subscribe left waiting");
  const named = () =>
    subscribes(browser.requested).filter((subscribe) => subscribe.media !== undefined).length;
  /** The deadline passes for the subscribe out now, then it fails. */
  const timeOut = async () => {
    browser.elapse(mediaSubscribeDeadlineMs);
    browser.hanging.shift()?.(new ClientError("timeout"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { ...browser, media, deliveries, named, timeOut };
}

test("subscribes that time out before failing climb the shared ladder, then name no connection", async () => {
  const view = await hanging();
  for (const wait of mediaRetryDelaysMs) {
    await view.timeOut();
    // Waiting on the ladder: the view's own poll (every 5 s) asks nothing meanwhile.
    const before = view.named();
    if (wait !== 5_000) {
      view.elapse(5_000);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(view.named()).toBe(before);
    }
    view.elapse(wait);
    await until(() => view.named() === before + 1, `the retry after ${wait} ms`);
  }
  await view.timeOut();
  // The ladder is spent: after the cooldown the view subscribes naming nothing.
  const asked = subscribes(view.requested).length;
  view.elapse(mediaRetryCooldownMs);
  await until(() => subscribes(view.requested).length === asked + 1, "the unnamed subscribe");
  expect(subscribes(view.requested).at(-1)?.media).toBeUndefined();
  expect(view.named()).toBe(mediaRetryDelaysMs.length + 1);
});

test("events during the cooldown send nothing until it ends", async () => {
  const view = await hanging();
  for (const wait of mediaRetryDelaysMs) {
    await view.timeOut();
    view.elapse(wait);
    await until(() => view.hanging.length === 1, "the next try");
  }
  await view.timeOut();
  const asked = subscribes(view.requested).length;
  // The main session drops and comes back, twice (each a ready connection the view subscribes
  // on), and the binding moves: none of it skips the cooldown.
  for (let round = 0; round < 2; round++) {
    view.daemon.disconnectAll();
    await until(() => view.client.state !== "ready", "the session dropped");
    await until(() => view.client.state === "ready", "the session back");
  }
  view.media.bind("mc_bbbbbbbb");
  await new Promise((resolve) => setTimeout(resolve, 20));
  view.elapse(5_000);
  expect(subscribes(view.requested)).toHaveLength(asked);
  view.elapse(mediaRetryCooldownMs);
  await until(() => subscribes(view.requested).length > asked, "the subscribe after the cooldown");
});

test("subscribes that fail at once, each restoring the delivery before, still climb the ladder to the cooldown", async () => {
  const media = connection();
  const browser = await live({ media: "fails" });
  browser.view.useMedia(media.route, () => {});
  browser.view.action({ kind: "open", threadId: "web", viewport });
  // Subscribed without a connection first.
  await until(() => subscribes(browser.requested).length === 1, "the first subscribe");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const named = () =>
    subscribes(browser.requested).filter((subscribe) => subscribe.media !== undefined).length;
  // The connection binds: the view names it, and that subscribe fails at once.
  media.bind("mc_aaaaaaaa");
  await until(() => named() === 1, "the first subscribe naming it");
  for (const wait of mediaRetryDelaysMs) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = named();
    // Its wait is the ladder's: the view's own 5 s poll asks nothing meanwhile.
    if (wait !== 5_000) {
      browser.elapse(5_000);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(named()).toBe(before);
    }
    browser.elapse(wait);
    await until(() => named() === before + 1, `the retry after ${wait} ms`);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Spent: nothing until the cooldown ends, then a subscribe that names no connection.
  const asked = subscribes(browser.requested).length;
  browser.elapse(5_000);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(subscribes(browser.requested)).toHaveLength(asked);
  browser.elapse(mediaRetryCooldownMs);
  await until(() => subscribes(browser.requested).length === asked + 1, "after the cooldown");
  expect(subscribes(browser.requested).at(-1)?.media).toBeUndefined();
});
