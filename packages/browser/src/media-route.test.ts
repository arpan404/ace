import { expect, test } from "vitest";
import {
  MediaSubscriptions,
  mediaRetryCooldownMs,
  mediaRetryDelaysMs,
  type MediaRoute,
} from "./media-route.ts";
import { SubscribeRetry } from "./subscribe-retry.ts";

/** A media connection that stays healthy on `connection`, and records each refresh asked. */
function healthy(connection = "mc_aaaaaaaaaa") {
  const refreshed: string[] = [];
  const route: MediaRoute = {
    binding: () => ({ connection }),
    codecs: () => ["avc1.42E033"],
    watch: () => () => {},
    onStream: () => () => {},
    ack: () => true,
    refresh: (asked) => void refreshed.push(asked),
  };
  const media = new MediaSubscriptions();
  media.use(route);
  return { media, refreshed };
}

const refusal = new Error("media-connection-gone: that media connection is gone");
const foreign = new Error("media-connection: that media connection isn't this session's");

test("a source whose subscribes keep failing still names the healthy connection once its ladder is spent", () => {
  const { media } = healthy();
  const waits: (() => void)[] = [];
  const retry = new SubscribeRetry(media, "thread", (run) => {
    waits.push(run);
    return () => {};
  });
  const named: (string | undefined)[] = [];
  const subscribe = () => {
    const begun = media.begin("thread");
    named.push(begun.fields.media?.connection);
    media.failed("thread", begun.generation, new Error("offline"));
    retry.failed(subscribe);
  };
  subscribe();
  // Every step of the ladder, then two cooldowns.
  for (let step = 0; step < mediaRetryDelaysMs.length + 2; step++) waits.shift()?.();
  expect(named).toEqual(Array(mediaRetryDelaysMs.length + 3).fill("mc_aaaaaaaaaa"));
});

test("a connection the daemon refused is refreshed, and a reply without video meanwhile keeps the view asking", () => {
  const { media, refreshed } = healthy();
  const first = media.begin("thread");
  media.failed("thread", first.generation, refusal);
  expect(refreshed).toEqual(["mc_aaaaaaaaaa"]);
  // The next subscribe names no connection, so its state still comes...
  const metadata = media.begin("thread");
  expect(metadata.fields.media).toBeUndefined();
  media.subscribed("thread", metadata.generation, undefined);
  // ...but that answer never ends video: the view asks again, naming the connection.
  expect(media.unserved("thread")).toBe(true);
  expect(media.begin("thread").fields.media?.connection).toBe("mc_aaaaaaaaaa");
});

test("a view with no media connection to name waits for one instead of asking again", () => {
  const media = new MediaSubscriptions();
  media.use({
    binding: () => undefined,
    codecs: () => [],
    watch: () => () => {},
    onStream: () => () => {},
    ack: () => false,
  });
  const begun = media.begin("thread");
  media.subscribed("thread", begun.generation, undefined);
  expect(media.unserved("thread")).toBe(false);
});

test("a connection refused as another session's is never replaced, since other views may still use it", () => {
  const { media, refreshed } = healthy();
  const begun = media.begin("thread");
  media.failed("thread", begun.generation, foreign);
  expect(refreshed).toEqual([]);
  // The view still gets its state, and asks for video again after.
  const metadata = media.begin("thread");
  expect(metadata.fields.media).toBeUndefined();
  media.subscribed("thread", metadata.generation, undefined);
  expect(media.unserved("thread")).toBe(true);
});

test("a refusal that comes after the view stopped waiting still replaces a gone connection", () => {
  const { media, refreshed } = healthy();
  const begun = media.begin("thread");
  media.abandon("thread", begun.generation);
  media.failed("thread", begun.generation, refusal);
  expect(refreshed).toEqual(["mc_aaaaaaaaaa"]);
  // The next subscribe still gets the source's state, and asks for video after.
  expect(media.begin("thread").fields.media).toBeUndefined();
});

test("a late refusal of a superseded subscribe changes nothing", () => {
  const { media, refreshed } = healthy();
  const old = media.begin("thread");
  media.abandon("thread", old.generation);
  media.begin("thread");
  media.failed("thread", old.generation, refusal);
  expect(refreshed).toEqual([]);
});

test("sources that lost video together come back spread out, each within its cooldown's bounds", () => {
  const { media } = healthy();
  const sources = Array.from({ length: 24 }, (_, index) => `thread-${index}`);
  const waits = sources.map((source) => media.cooldown(source));
  expect(new Set(waits).size).toBeGreaterThan(12);
  for (const wait of waits) {
    expect(wait).toBeGreaterThanOrEqual(mediaRetryCooldownMs);
    expect(wait).toBeLessThan(mediaRetryCooldownMs * 1.5);
  }
  // A source's own wait stays the same, so it never drifts into the others.
  expect(media.cooldown("thread-3")).toBe(waits[3]);
});
