import { host } from "./test-host.ts";
import { ClientError } from "@ace/client";
import type { DeliveryState, MediaRoute } from "@ace/browser/live-view";
import type { MediaStreamClientMessage } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { closeBrowserFixtures, liveBrowser as live, viewport } from "./browser-fixture.ts";
import { until } from "./sheet-fixture.ts";

/*
 * The phone's live browser view and its media connection (ADR 0147 §4): its subscribe names the
 * open connection, a new connection subscribes it again with a fresh decoder, and the acks of
 * pictures that came by the connection go on it. Without one, the main socket carries all of it.
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
  /** `serves`: the daemon answers without `media`, keeping the view on the main socket. */
  daemon: "binds" | "refuses" | "serves" = "binds",
) {
  const media = connection();
  media.bind(bound);
  const browser = await live(daemon === "serves" ? {} : { media: daemon });
  // What `media.delivery` tells Swift; Swift stamps each ack with the latest generation.
  const deliveries: DeliveryState[] = [];
  browser.view.useMedia(media.route, (_view, state) => deliveries.push(state));
  const delivered = () => deliveries.at(-1)?.generation;
  browser.view.action({ kind: "open", threadId: "web", viewport });
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

test("losing the media connection moves the view and its acks back to the main socket", async () => {
  const { requested, sent, view, media, delivered } = await opened("mc_aaaaaaaa");
  media.bind(undefined);
  await until(() => subscribes(requested).length === 2, "resubscribe");
  expect(subscribes(requested)[1]?.media).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 0));

  view.action({ kind: "ack", sequence: 3, generation: delivered() });
  expect(media.carried).toEqual([]);
  expect(sent).toEqual([
    expect.objectContaining({ type: "browser.ack", threadId: "web", sequence: 3, video: true }),
  ]);
});

test("without a media connection the view is delivered and acknowledged on the main socket", async () => {
  const { requested, sent, view, media, delivered } = await opened(undefined);
  expect(subscribes(requested)[0]?.media).toBeUndefined();
  view.action({ kind: "ack", sequence: 2, generation: delivered() });
  expect(media.carried).toEqual([]);
  expect(sent).toEqual([expect.objectContaining({ type: "browser.ack", sequence: 2 })]);
});

test("a daemon that serves the view on its main socket keeps its acks there", async () => {
  const { requested, sent, view, media, delivered } = await opened("mc_aaaaaaaa", "serves");
  expect(subscribes(requested)[0]?.media).toEqual({ connection: "mc_aaaaaaaa" });
  view.action({ kind: "ack", sequence: 6, generation: delivered() });
  expect(media.carried).toEqual([]);
  expect(sent).toEqual([expect.objectContaining({ type: "browser.ack", sequence: 6 })]);
});

test("a refused media connection subscribes the view again on the main socket", async () => {
  const { requested, sent, view, media, delivered } = await opened("mc_aaaaaaaa", "refuses");
  await until(() => subscribes(requested).length === 2, "subscribe without the connection");
  expect(subscribes(requested)[1]?.media).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.action({ kind: "ack", sequence: 8, generation: delivered() });
  expect(media.carried).toEqual([]);
  expect(sent).toEqual([expect.objectContaining({ type: "browser.ack", sequence: 8 })]);
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
  expect(deliveries.at(-1)?.path).toBe("channel");
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
