import type { KeptValue } from "./kept-value.ts";
import { afterEach, expect, it, vi } from "vitest";
import { alert, closePhones, phone } from "./notifications-fixture.ts";

afterEach(closePhones);
const categories = (failures: boolean) => ({
  needsYou: true,
  failures,
  finished: true,
  agentSays: true,
});

const finishedRun = (id: string, finishedAt: number) => ({
  id,
  automationId: "nightly",
  title: "Nightly audit",
  eventKey: id,
  trigger: "schedule" as const,
  status: "succeeded" as const,
  startedAt: 100,
  finishedAt,
  threadId: `t-${id}`,
  result: "all green",
});
const runCategories = (automations: boolean) => ({ ...categories(true), automations });

const lastFeed = (of: (type: string) => Record<string, unknown>[]) =>
  of("notifications.feed").at(-1);

it("turning a machine's notifications off unregisters at once, and turning them on registers again", async () => {
  const { daemon, sync, settle, of } = await phone();
  sync(true);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(1));
  sync(false);
  await settle();
  // The daemon keeps nothing for a muted phone, so unmuting doesn't post what happened meanwhile.
  daemon.notify(alert("n:muted"));
  sync(true);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(2));
  expect(lastFeed(of)).toMatchObject({ entries: [] });
  daemon.notify(alert("n:on"));
  sync(true);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(3));
  expect(lastFeed(of)).toMatchObject({ entries: [{ id: "n:on" }] });
});

it("a mute that couldn't reach the daemon is sent on reconnect, and the phone doesn't register while muted", async () => {
  const { daemon, sync, settle, of } = await phone();
  sync(true);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(1));
  daemon.failRequests("notification.unregister");
  sync(false);
  await settle();
  daemon.restoreRequests();
  daemon.disconnectAll();
  // The new connection unregisters from what the runtime already knows, before Swift re-syncs.
  await vi.waitFor(() => expect(of("notifications.connected")).toHaveLength(2));
  await settle();
  daemon.notify(alert("n:muted"));
  sync(true);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(2));
  expect(lastFeed(of)).toMatchObject({ entries: [] });
});

it("posts the daemon's live alerts only while notifications are on", async () => {
  const { daemon, sync, barrier, of } = await phone();
  sync(false);
  daemon.notify(alert("n:1"));
  await barrier();
  sync(true);
  daemon.notify(alert("n:2"));
  await vi.waitFor(() => expect(of("notifications.alert")).toHaveLength(1));
  expect(of("notifications.alert")[0]).toMatchObject({ notification: { id: "n:2" } });
});

it("each alert says how this phone shows it, by the categories and quiet hours Swift sends", async () => {
  const { daemon, act, of } = await phone();
  const sync = (appState: "foreground" | "background", prefs: unknown) =>
    act({ type: "notifications.sync", enabled: true, appState, cursor: 0, phone: prefs });
  // Open, with failure banners off but failures still on for the system: a quiet list entry.
  sync("foreground", { inApp: categories(false), system: categories(true), quietHours: null });
  daemon.notify({ ...alert("n:1"), status: "failed" });
  await vi.waitFor(() => expect(of("notifications.alert")).toHaveLength(1));
  expect(of("notifications.alert")[0]).toMatchObject({
    notification: { id: "n:1", delivery: { post: true, interrupt: false, banner: false } },
  });
  // In the background at 23:00, inside 22:00–07:00 quiet hours: posted without interrupting.
  sync("background", {
    inApp: categories(true),
    system: categories(true),
    quietHours: { start: 1320, end: 420 },
  });
  daemon.notify({ ...alert("n:2"), status: "needs_you" });
  await vi.waitFor(() => expect(of("notifications.alert")).toHaveLength(2));
  expect(of("notifications.alert")[1]).toMatchObject({
    notification: { id: "n:2", delivery: { post: true, interrupt: false, banner: false } },
  });
  // Failures off for the system: not posted at all.
  sync("background", { inApp: categories(true), system: categories(false), quietHours: null });
  daemon.notify({ ...alert("n:3"), status: "failed" });
  await vi.waitFor(() => expect(of("notifications.alert")).toHaveLength(3));
  expect(of("notifications.alert")[2]).toMatchObject({
    notification: { delivery: { post: false } },
  });
});

it("a finished automation run is posted once, when run alerts are on, by the phone's choice", async () => {
  // The phone started watching at 500; the machine's inbox holds one run from before and one after.
  const { daemon, act, settle, of } = await phone(() => 500);
  daemon.seedServices({
    settings: { "automations.enabled": true },
    runs: [finishedRun("old", 400), finishedRun("new", 700)],
  });
  const sync = (automations: boolean) =>
    act({
      type: "notifications.sync",
      enabled: true,
      appState: "background",
      cursor: 0,
      phone: {
        inApp: runCategories(automations),
        system: runCategories(automations),
        quietHours: null,
      },
    });
  sync(false);
  await settle();
  expect(of("notifications.run")).toEqual([]);
  sync(true);
  await vi.waitFor(() => expect(of("notifications.run")).toHaveLength(1));
  expect(of("notifications.run")[0]).toEqual({
    type: "notifications.run",
    key: "new",
    title: "Nightly audit finished",
    body: "The automation run finished",
    threadId: "t-new",
    automationId: "nightly",
    delivery: { post: true, interrupt: true, banner: false },
  });
});

it("a run that finished while ace was closed is posted once the phone says run alerts are on", async () => {
  // The last launch had said this machine's runs up to 400; one finished at 450, while closed.
  let kept: unknown = { since: 400 };
  const progress: KeptValue = {
    load: async () => kept,
    save: async (value) => {
      kept = value;
    },
  };
  const { daemon, act, of } = await phone(() => 500, progress);
  daemon.seedServices({
    settings: { "automations.enabled": true },
    runs: [finishedRun("closed", 450)],
  });
  act({
    type: "notifications.sync",
    enabled: true,
    appState: "background",
    cursor: 0,
    phone: { inApp: runCategories(true), system: runCategories(true), quietHours: null },
  });
  await vi.waitFor(() => expect(of("notifications.run")).toHaveLength(1));
  expect(of("notifications.run")[0]).toMatchObject({ key: "closed" });
});

it("catches up on what the daemon sent while the app wasn't listening, once per cursor", async () => {
  const { daemon, sync, of } = await phone();
  daemon.notify(alert("n:1"));
  sync(true);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(1));
  expect(of("notifications.feed")[0]).toMatchObject({
    cursor: 1,
    // Each entry keeps its feed position, which Swift compares with live alerts' cursors.
    entries: [{ id: "n:1", cursor: 1 }],
    retracted: [],
  });
  daemon.retractNotification("n:1");
  sync(true, 1);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(2));
  expect(of("notifications.feed")[1]).toMatchObject({ entries: [], retracted: ["n:1"] });
});

it("an approval action answers the exact pending option once, through the durable command path", async () => {
  const { resolve, of, interactions } = await phone();
  resolve("tap-1", "allow");
  // The receipt may beat the admission callback; either way the last word is the daemon's.
  await vi.waitFor(() =>
    expect(of("notifications.action").at(-1)).toMatchObject({ id: "tap-1", outcome: "confirmed" }),
  );
  await new Promise((done) => setTimeout(done, 20));
  expect(of("notifications.action").at(-1)).toMatchObject({ outcome: "confirmed" });
  expect(interactions()[0]).toMatchObject({
    state: "resolved",
    resolution: { kind: "approval", optionId: "allow" },
  });
  // The same alert tapped again finds nothing pending and sends nothing.
  resolve("tap-2", "allow");
  const before = of("notifications.action").length;
  await vi.waitFor(() => expect(of("notifications.action")).toHaveLength(before + 1));
  expect(of("notifications.action").at(-1)).toEqual({
    type: "notifications.action",
    id: "tap-2",
    outcome: "stale",
  });
});

it("an action for an option the approval doesn't offer sends nothing", async () => {
  const { resolve, of, interactions } = await phone();
  resolve("tap", "always");
  await vi.waitFor(() => expect(of("notifications.action")).toHaveLength(1));
  expect(of("notifications.action")[0]).toMatchObject({ outcome: "stale" });
  expect(interactions()[0]?.state).toBe("pending");
});
