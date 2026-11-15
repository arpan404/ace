import type { MediaRoute } from "@ace/browser/live-view";
import type { MediaStreamClientMessage } from "@ace/protocol";
import { expect, test } from "vitest";
import { MediaViews } from "./media-views.ts";

/** A media connection whose binding the test moves, recording what it carried. */
function connection() {
  let bound: string | undefined;
  const watchers = new Set<() => void>();
  const carried: MediaStreamClientMessage[] = [];
  const route: MediaRoute = {
    binding: () => (bound ? { connection: bound } : undefined),
    codecs: () => ["hvc1.1.6.L153.B0", "avc1.42E033"],
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

const ack = (sessionId: string, sequence: number): MediaStreamClientMessage => ({
  type: "screen.ack",
  sessionId,
  streamId: "st",
  sequence,
});

function phone() {
  const media = connection();
  const resubscribed: string[] = [];
  const views = new MediaViews((source) => resubscribed.push(source));
  views.use(media.route);
  return { media, views, resubscribed };
}

test("a subscribe names the open media connection, and nothing while there is none", () => {
  const { media, views } = phone();
  expect(views.subscribe("s-1")).toEqual({});
  media.bind("mc_aaaaaaaa");
  expect(views.subscribe("s-1")).toEqual({ media: { connection: "mc_aaaaaaaa" } });
});

test("acks of a view subscribed on the media connection go on it; others go by the channel", () => {
  const { media, views } = phone();
  views.subscribe("legacy");
  media.bind("mc_aaaaaaaa");
  views.subscribe("bound");

  expect(views.ack("bound", ack("bound", 1))).toBe(true);
  expect(views.ack("legacy", ack("legacy", 1))).toBe(false);
  expect(views.ack("never-subscribed", ack("never-subscribed", 1))).toBe(false);
  expect(media.carried).toEqual([ack("bound", 1)]);
});

test("a new connection resubscribes every watched view, and acks wait for that subscribe", () => {
  const { media, views, resubscribed } = phone();
  media.bind("mc_aaaaaaaa");
  views.subscribe("s-1");
  views.subscribe("s-2");
  views.subscribe("gone");
  views.forget("gone");

  media.bind("mc_bbbbbbbb");
  expect(resubscribed.sort()).toEqual(["s-1", "s-2"]);
  // Still bound to the old connection until its subscribe goes out again: never on the new one.
  expect(views.ack("s-1", ack("s-1", 2))).toBe(false);
  views.subscribe("s-1");
  expect(views.ack("s-1", ack("s-1", 3))).toBe(true);
  expect(media.carried).toEqual([ack("s-1", 3)]);
});

test("losing the media connection moves every view back to the channel", () => {
  const { media, views, resubscribed } = phone();
  media.bind("mc_aaaaaaaa");
  views.subscribe("s-1");
  media.bind(undefined);

  expect(resubscribed).toEqual(["s-1"]);
  expect(views.subscribe("s-1")).toEqual({});
  expect(views.ack("s-1", ack("s-1", 4))).toBe(false);
});

test("a closed channel's views are not subscribed again when the binding changes", () => {
  const { media, views, resubscribed } = phone();
  media.bind("mc_aaaaaaaa");
  views.subscribe("s-1");
  views.reset();
  media.bind("mc_bbbbbbbb");
  expect(resubscribed).toEqual([]);
});

test("without a route every view stays on the channel", () => {
  const views = new MediaViews(() => {
    throw new Error("nothing to resubscribe for");
  });
  views.use(undefined);
  expect(views.subscribe("s-1")).toEqual({});
  expect(views.ack("s-1", ack("s-1", 1))).toBe(false);
});
