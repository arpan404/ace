import type { MediaDeliveryPort, ViewIntent } from "@ace/media/media-viewers";
import { expect, test } from "vitest";
import { connectBrowser } from "./index.ts";
import { idleThread } from "./idle-test-support.ts";

/** A delivery that serves every kind and holds the views it granted, by the id it gave. */
function delivery() {
  const views = new Map<string, Omit<ViewIntent, "viewer">>();
  let ids = 0;
  const port: MediaDeliveryPort = {
    serves: () => true,
    bind: (intent) => {
      const viewer = `view-${++ids}`;
      views.set(viewer, intent);
      return viewer;
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
  session: "main-0d8c7a3e-4b1f-4e2a-9c5d-6f7a8b9c0d1e",
  device: "phone",
  admission: { kind: "pairing", generation: "3f9a1c0e7b2d4a6c8e1f0b2d4c6e8a1f" },
} as const;

const subscribe = (subscriberId: string, connection?: string, threadId = "thread") => ({
  type: "browser.subscribe",
  threadId,
  requestId: `subscribe-${subscriberId}`,
  subscriberId,
  binaryFrames: true,
  viewport: { width: 640, height: 400, devicePixelRatio: 1 },
  video: { codecs: ["vp8"] },
  ...(connection ? { media: { connection } } : {}),
});
const unsubscribe = (subscriberId: string) => ({
  type: "browser.unsubscribe",
  threadId: "thread",
  requestId: `unsubscribe-${subscriberId}`,
  subscriberId,
});

async function bridge() {
  const t = await idleThread();
  const d = delivery();
  const results: unknown[] = [];
  const b = connectBrowser(t.service, {
    connectionId: "viewer",
    authorize: () => true,
    send: (message) => {
      results.push(message);
      return true;
    },
    sendStream: () => true,
    media: { owner: () => owner, delivery: () => d.port },
  });
  return { ...d, bridge: b, results, service: t.service };
}

// UUID-sized subscriber ids, as clients make them: any id built by slicing names would collide.
const a = "subscriber-1b4e28ba-2fa1-11d2-883f-0016d3cca427";
const b = "subscriber-6fa459ea-ee8a-3ca4-894e-db77e160355e";

test("subscribers of one thread on one connection share its one view, which the last one closes", async () => {
  const { bridge: client, views } = await bridge();
  await client.handle(subscribe(a, "mc_aaaaaaaaaaaa"));
  await client.handle(subscribe(b, "mc_aaaaaaaaaaaa"));
  expect(views.size).toBe(1);
  await client.handle(unsubscribe(a));
  expect(views.size).toBe(1);
  await client.handle(unsubscribe(b));
  expect(views.size).toBe(0);
});

test("a resubscribe on the main socket leaves the media view to whoever still holds it", async () => {
  const { bridge: client, views } = await bridge();
  await client.handle(subscribe(a, "mc_aaaaaaaaaaaa"));
  await client.handle(subscribe(b, "mc_aaaaaaaaaaaa"));
  await client.handle(subscribe(a));
  expect(views.size).toBe(1);
  await client.handle(subscribe(b));
  expect(views.size).toBe(0);
  client.close();
});

test("a subscribe refused at a limit, or failing after its grant, leaves no grant behind", async () => {
  const { bridge: client, views, service } = await bridge();
  for (let n = 1; n <= 8; n++)
    await service.open({ threadId: `thread-${n}`, workspaceId: "workspace" });
  for (let n = 0; n < 64; n++) await client.handle(subscribe(`s${n}`, "mc_aaaaaaaaaaaa"));
  expect(views.size).toBe(1);
  // The 65th subscriber of the thread is refused before anything is granted for it.
  await client.handle(subscribe("s64", "mc_bbbbbbbbbbbb"));
  expect(views.size).toBe(1);
  // Eight threads at most: the ninth is refused, and granted nothing.
  for (let n = 1; n < 8; n++)
    await client.handle(subscribe(`t${n}`, "mc_aaaaaaaaaaaa", `thread-${n}`));
  expect(views.size).toBe(8);
  await client.handle(subscribe("t8", "mc_aaaaaaaaaaaa", "thread-8"));
  expect(views.size).toBe(8);
  // A thread the service doesn't have fails after its grant was made: that grant is undone.
  await client.handle({ ...unsubscribe("t7"), threadId: "thread-7" });
  expect(views.size).toBe(7);
  await client.handle(subscribe("x", "mc_aaaaaaaaaaaa", "no-such-thread"));
  expect(views.size).toBe(7);
  client.close();
  expect(views.size).toBe(0);
});
