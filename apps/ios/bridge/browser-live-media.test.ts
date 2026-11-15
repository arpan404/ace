import "./test-host.ts";
import type { MediaRoute } from "@ace/browser/live-view";
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
      for (const listener of [...watchers]) listener();
    },
  };
}

type Subscribe = { type: string; media?: { connection: string } };
const subscribes = (requested: unknown[]) =>
  (requested as Subscribe[]).filter((value) => value.type === "browser.subscribe");

async function opened(bound: string | undefined) {
  const media = connection();
  media.bind(bound);
  const browser = await live();
  browser.view.useMedia(media.route);
  browser.view.action({ kind: "open", threadId: "web", viewport });
  await until(() => browser.sink.read("browser:view")?.state != null, "browser state");
  await until(() => subscribes(browser.requested).length === 1, "subscribe");
  // The subscribe's reply has landed.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { ...browser, media };
}

test("the view subscribes on the open media connection and acknowledges its pictures there", async () => {
  const { requested, sent, view, media } = await opened("mc_aaaaaaaa");
  expect(subscribes(requested)[0]?.media).toEqual({ connection: "mc_aaaaaaaa" });

  view.action({ kind: "ack", sequence: 7, keyframe: true });
  expect(media.carried).toEqual([
    { type: "browser.ack", threadId: "web", sequence: 7, video: true, keyframe: true },
  ]);
  expect(sent).toEqual([]);
});

test("a new media connection subscribes the view again on it and starts a fresh decoder", async () => {
  const { requested, sink, view, media } = await opened("mc_aaaaaaaa");
  const before = sink.read("browser:view")?.generation as number;

  media.bind("mc_bbbbbbbb");
  await until(() => subscribes(requested).length === 2, "resubscribe");
  expect(subscribes(requested)[1]?.media).toEqual({ connection: "mc_bbbbbbbb" });
  await until(
    () => (sink.read("browser:view")?.generation as number) > before,
    "a new decoder generation",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.action({ kind: "ack", sequence: 1 });
  expect(media.carried.at(-1)).toMatchObject({ sequence: 1 });
});

test("losing the media connection moves the view and its acks back to the main socket", async () => {
  const { requested, sent, view, media } = await opened("mc_aaaaaaaa");
  media.bind(undefined);
  await until(() => subscribes(requested).length === 2, "resubscribe");
  expect(subscribes(requested)[1]?.media).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 0));

  view.action({ kind: "ack", sequence: 3 });
  expect(media.carried).toEqual([]);
  expect(sent).toEqual([
    expect.objectContaining({ type: "browser.ack", threadId: "web", sequence: 3, video: true }),
  ]);
});

test("without a media connection the view is delivered and acknowledged on the main socket", async () => {
  const { requested, sent, view, media } = await opened(undefined);
  expect(subscribes(requested)[0]?.media).toBeUndefined();
  view.action({ kind: "ack", sequence: 2 });
  expect(media.carried).toEqual([]);
  expect(sent).toEqual([expect.objectContaining({ type: "browser.ack", sequence: 2 })]);
});
