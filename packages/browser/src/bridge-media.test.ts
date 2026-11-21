import { fakeDelivery, phoneOwner } from "@ace/media/testing/fake-delivery";
import { expect, test } from "vitest";
import { BrowserServerMessage } from "@ace/protocol";
import { updateReason } from "@ace/media/media-viewers";
import { connectBrowser } from "./index.ts";
import { idleThread } from "./idle-test-support.ts";

const delivery = fakeDelivery;
const owner = phoneOwner;

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
  const failing = { state: false };
  const b = connectBrowser(t.service, {
    connectionId: "viewer",
    authorize: () => true,
    send: (message) => {
      if (failing.state && message.type === "browser.state") throw new Error("socket gone");
      results.push(message);
      return true;
    },
    sendStream: () => true,
    media: { owner: () => owner, delivery: () => d.port },
  });
  return { ...d, bridge: b, results, failing, service: t.service };
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

test("a subscribe that fails partway leaves the thread's subscription as it was", async () => {
  const { bridge: client, views, failing } = await bridge();
  await client.handle(subscribe(a, "mc_aaaaaaaaaaaa"));
  expect(views.size).toBe(1);
  // `b` names another connection, and its setup fails after its view was granted.
  failing.state = true;
  await client.handle(subscribe(b, "mc_bbbbbbbbbbbb"));
  failing.state = false;
  expect(views.size).toBe(1);
  // A later subscriber on that connection gets a live view, never the failed one's dead id.
  await client.handle(subscribe("c", "mc_bbbbbbbbbbbb"));
  expect(views.size).toBe(2);
  // `b` was never added: once `a` and `c` leave, nothing is left.
  await client.handle(unsubscribe(a));
  await client.handle(unsubscribe("c"));
  expect(views.size).toBe(0);
});

test("a resubscribe on the same connection that fails keeps delivering on the view it had", async () => {
  const { bridge: client, views, live, failing } = await bridge();
  await client.handle(subscribe(a, "mc_aaaaaaaaaaaa"));
  const [first] = live;
  // Its new view replaced the old one in ace-media before the setup failed.
  failing.state = true;
  await client.handle(subscribe(a, "mc_aaaaaaaaaaaa"));
  failing.state = false;
  expect([...live]).toEqual([first]);
  expect(views.size).toBe(1);
  // The subscription still holds that view: leaving closes it.
  await client.handle(unsubscribe(a));
  expect(live.size).toBe(0);
  expect(views.size).toBe(0);
});

test("an older client is told to update in the browser state fields it already shows", async () => {
  const { bridge: client, results, views } = await bridge();
  // A pre-X3 client: no `mediaClient`, no media connection.
  await client.handle(subscribe(a));
  const states = results.flatMap((message) => {
    const parsed = BrowserServerMessage.safeParse(message);
    return parsed.success && parsed.data.type === "browser.state" ? [parsed.data.state] : [];
  });
  // `status`, `pageStateLost` and `reason` are what an older client renders as a lost page.
  expect(states.at(-1)).toMatchObject({
    status: "paused",
    pageStateLost: true,
    reason: updateReason,
  });
  expect(views.size).toBe(0);
});

test("a current client without a media connection yet isn't told to update", async () => {
  const { bridge: client, results } = await bridge();
  await client.handle({ ...subscribe(a), mediaClient: true });
  expect(results).not.toContainEqual(
    expect.objectContaining({
      type: "browser.state",
      state: expect.objectContaining({ reason: updateReason }),
    }),
  );
});

test("a thread whose own source ace-media can't serve gets no view and says why, though other kinds are served", async () => {
  const t = await idleThread();
  const d = fakeDelivery();
  const results: unknown[] = [];
  const reason = "This computer can't stream this live view yet.";
  const client = connectBrowser(t.service, {
    connectionId: "viewer",
    authorize: () => true,
    send: (message) => {
      results.push(message);
      return true;
    },
    media: {
      owner: () => owner,
      // The thread's tab is a `tab`: ace-media serves the desktop's views, but not that.
      delivery: () => ({
        ...d.port,
        serves: (kind) => kind !== "tab",
        unserved: (kind) => (kind === "tab" ? reason : undefined),
      }),
    },
  });
  await client.handle({ ...subscribe(a, "mc_aaaaaaaaaaaa"), mediaClient: true });
  expect(results).toContainEqual(
    expect.objectContaining({
      type: "browser.result",
      ok: true,
      undelivered: { code: "unavailable", reason },
    }),
  );
  expect(d.views.size).toBe(0);
  client.close();
});

test("a subscribe ace-media can't serve now gets no pictures and says why", async () => {
  const t = await idleThread();
  const d = fakeDelivery();
  const results: unknown[] = [];
  const reason = "Live video is starting. It shows in a moment.";
  const client = connectBrowser(t.service, {
    connectionId: "viewer",
    authorize: () => true,
    send: (message) => {
      results.push(message);
      return true;
    },
    media: {
      owner: () => owner,
      delivery: () => ({ ...d.port, serves: () => false, unserved: () => reason }),
    },
  });
  await client.handle(subscribe(a, "mc_aaaaaaaaaaaa"));
  expect(results).toContainEqual(
    expect.objectContaining({
      type: "browser.result",
      ok: true,
      undelivered: { code: "unavailable", reason },
    }),
  );
  expect(d.views.size).toBe(0);
  client.close();
});

test("a bound view whose tab isn't streaming yet is told so, and told again when its grant comes", async () => {
  const t = await idleThread();
  const d = fakeDelivery();
  const results: unknown[] = [];
  const client = connectBrowser(t.service, {
    connectionId: "viewer",
    authorize: () => true,
    send: (message) => {
      results.push(message);
      return true;
    },
    media: {
      owner: () => owner,
      // The view is held, but no producer streams the tab into ace-media yet.
      delivery: () => ({ ...d.port, granted: () => false, sourceState: () => "pending" }),
    },
  });
  const deliveries = () =>
    results.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "browser.delivery",
    );
  await client.handle({
    ...subscribe(a, "mc_aaaaaaaaaaaa"),
    mediaClient: true,
    deliveryStatus: true,
  });
  expect(results).toContainEqual(
    expect.objectContaining({ type: "browser.result", media: { connection: "mc_aaaaaaaaaaaa" } }),
  );
  expect(deliveries().at(-1)).toMatchObject({ undelivered: { code: "starting" } });
  // The tab starts streaming and the view is granted: the subscriber hears it, reason gone.
  const [intent] = d.views.values();
  intent?.onGrant?.(true);
  expect(deliveries().at(-1)).toEqual({ type: "browser.delivery", threadId: "thread" });
  // It stops again (its ingest refused): told why once more.
  intent?.onGrant?.(false);
  expect(deliveries().at(-1)).toMatchObject({ undelivered: { code: "starting" } });
  client.close();
});

test("a subscriber that didn't ask for delivery status never gets one: an older decoder would close", async () => {
  const t = await idleThread();
  const d = fakeDelivery();
  const results: unknown[] = [];
  const client = connectBrowser(t.service, {
    connectionId: "viewer",
    authorize: () => true,
    send: (message) => {
      results.push(message);
      return true;
    },
    media: {
      owner: () => owner,
      delivery: () => ({ ...d.port, granted: () => false, sourceState: () => "pending" }),
    },
  });
  // A client of before this change: it names a media connection, but not `deliveryStatus`.
  await client.handle({ ...subscribe(a, "mc_aaaaaaaaaaaa"), mediaClient: true });
  const [intent] = d.views.values();
  intent?.onGrant?.(true);
  intent?.onGrant?.(false);
  const types = results.map((message) =>
    typeof message === "object" && message !== null && "type" in message ? message.type : "",
  );
  expect(types).toContain("browser.result");
  expect(types).not.toContain("browser.delivery");
  client.close();
});
