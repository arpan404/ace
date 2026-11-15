import type { MediaDeliveryPort, ViewIntent } from "@ace/media/media-viewers";
import { expect, test } from "vitest";
import { connectBrowser } from "./index.ts";
import { idleThread } from "./idle-test-support.ts";

/** A delivery that serves every kind and records each view it holds. */
function delivery() {
  const views = new Map<string, ViewIntent>();
  const port: MediaDeliveryPort = {
    serves: () => true,
    bind: (intent) => {
      views.set(intent.viewer, intent);
      return true;
    },
    granted: () => true,
    poster: () => Promise.resolve(undefined),
    configure: () => {},
    pause: () => {},
    unbind: (viewer) => void views.delete(viewer),
  };
  return { port, views };
}

const owner = {
  session: "main",
  device: "phone",
  admission: { kind: "pairing", generation: "3f9a1c0e7b2d4a6c8e1f0b2d4c6e8a1f" },
} as const;

const subscribe = (subscriberId: string, connection?: string) => ({
  type: "browser.subscribe",
  threadId: "thread",
  requestId: `subscribe-${subscriberId}`,
  subscriberId,
  binaryFrames: true,
  viewport: { width: 640, height: 400, devicePixelRatio: 1 },
  video: { codecs: ["vp8"] },
  ...(connection ? { media: { connection } } : {}),
});

test("each subscriber holds its own view, and a resubscribe or unsubscribe retires exactly it", async () => {
  const t = await idleThread();
  const { port, views } = delivery();
  const bridge = connectBrowser(t.service, {
    connectionId: "viewer",
    authorize: () => true,
    send: () => true,
    sendStream: () => true,
    media: { owner: () => owner, delivery: () => port },
  });
  await bridge.handle(subscribe("a", "mc_aaaaaaaaaaaa"));
  await bridge.handle(subscribe("b", "mc_aaaaaaaaaaaa"));
  expect(views.size).toBe(2);
  // `a` resubscribes without a media connection: its view goes, `b`'s stays.
  await bridge.handle(subscribe("a"));
  expect([...views.keys()].every((viewer) => viewer.endsWith("/b"))).toBe(true);
  expect(views.size).toBe(1);
  // `a` comes back on media, then leaves: only its own view goes.
  await bridge.handle(subscribe("a", "mc_aaaaaaaaaaaa"));
  expect(views.size).toBe(2);
  await bridge.handle({
    type: "browser.unsubscribe",
    threadId: "thread",
    requestId: "unsubscribe-a",
    subscriberId: "a",
  });
  expect([...views.keys()].every((viewer) => viewer.endsWith("/b"))).toBe(true);
  expect(views.size).toBe(1);
  bridge.close();
  expect(views.size).toBe(0);
});
