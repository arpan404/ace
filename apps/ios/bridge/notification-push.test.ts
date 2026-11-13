import { afterEach, expect, it, vi } from "vitest";
import { alert, closePhones, phone } from "./notifications-fixture.ts";

afterEach(closePhones);

/** The fixture client's device id, as the daemon knows it. */
const device = "phone";

it("a live alert is acknowledged only once Swift says it handled it", async () => {
  const { daemon, act, sync, settle, of, interactions } = await phone();
  sync(true);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(1));
  // A needs-you alert reads its request from the thread before Swift sees it.
  daemon.notify({ ...alert("n:asks"), status: "needs_you", interactionId: interactions()[0]?.id });
  await vi.waitFor(() => expect(of("notifications.alert")).toHaveLength(1));
  await settle();
  // Handed over is not shown: the app may be suspended before it posts.
  expect(daemon.notifications.acknowledged(device)).toEqual([]);
  act({ type: "notifications.delivered", id: "n:asks" });
  await vi.waitFor(() => expect(daemon.notifications.acknowledged(device)).toEqual(["n:asks"]));
});

it("an alert Swift never says it handled is never acknowledged, so the daemon pushes it", async () => {
  const { daemon, act, sync, settle, of } = await phone();
  sync(true);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(1));
  daemon.notify(alert("n:lost"));
  await vi.waitFor(() => expect(of("notifications.alert")).toHaveLength(1));
  await settle();
  expect(daemon.notifications.acknowledged(device)).toEqual([]);
  // Swift naming an alert the bridge never handed it over this connection acks nothing either.
  act({ type: "notifications.delivered", id: "n:other" });
  await settle();
  expect(daemon.notifications.acknowledged(device)).toEqual([]);
});

it("an alert that arrives before Swift's first sync isn't acknowledged, and catch-up brings it", async () => {
  const { daemon, sync, settle, of } = await phone();
  daemon.notify(alert("n:early"));
  await settle();
  expect(daemon.notifications.acknowledged(device)).toEqual([]);
  expect(of("notifications.alert")).toEqual([]);
  sync(true);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(1));
  expect(of("notifications.feed")[0]?.entries).toMatchObject([{ id: "n:early" }]);
});

it("a live alert is acknowledged while this machine's alerts are muted, and Swift isn't told", async () => {
  const { daemon, sync, settle, of } = await phone();
  sync(false);
  await settle();
  // Swift said off: that is the phone's own choice, and acking stops a push to a muted phone.
  daemon.notify(alert("n:muted"));
  await vi.waitFor(() => expect(daemon.notifications.acknowledged(device)).toEqual(["n:muted"]));
  await settle();
  expect(of("notifications.alert")).toEqual([]);
});

/** What Swift sends once iOS gives the app a token: hex token, P-256 key and auth secret. */
const pushKey = (token: string) => ({
  token,
  environment: "production" as const,
  p256dh: `B${"a".repeat(86)}`,
  auth: "c".repeat(22),
});

it("a phone with a push key registers a push address, and unregisters when muted", async () => {
  const { daemon, act, sync, settle, of } = await phone();
  const push = pushKey("ab".repeat(32));
  act({ type: "notifications.sync", enabled: true, appState: "foreground", cursor: 0, push });
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(1));
  expect(daemon.notifications.address(device)).toEqual({
    channel: "push",
    platform: "phone",
    ...push,
  });
  sync(false);
  await settle();
  expect(daemon.notifications.address(device)).toBeUndefined();
});

it("a new token re-registers on the same connection, and no token goes back to the socket", async () => {
  const { daemon, act, settle } = await phone();
  const sync = (push: unknown) =>
    act({ type: "notifications.sync", enabled: true, appState: "foreground", cursor: 0, push });
  sync(pushKey("ab".repeat(32)));
  await vi.waitFor(() =>
    expect(daemon.notifications.address(device)).toMatchObject({ token: "ab".repeat(32) }),
  );
  sync(pushKey("cd".repeat(32)));
  await vi.waitFor(() =>
    expect(daemon.notifications.address(device)).toMatchObject({ token: "cd".repeat(32) }),
  );
  sync(null);
  await settle();
  expect(daemon.notifications.address(device)).toEqual({ channel: "websocket", platform: "phone" });
});

it("an older daemon that refuses the push address still gets the websocket address", async () => {
  const { daemon, act, settle, of } = await phone();
  daemon.notifications.refusePush();
  act({
    type: "notifications.sync",
    enabled: true,
    appState: "foreground",
    cursor: 0,
    push: pushKey("ab".repeat(32)),
  });
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(1));
  expect(daemon.notifications.address(device)).toEqual({ channel: "websocket", platform: "phone" });
  // It can't read acks either, so it isn't sent any; alerts still reach Swift.
  daemon.notify(alert("n:old"));
  await vi.waitFor(() => expect(of("notifications.alert")).toHaveLength(1));
  act({ type: "notifications.delivered", id: "n:old" });
  await settle();
  expect(daemon.notifications.acknowledged(device)).toEqual([]);
});
