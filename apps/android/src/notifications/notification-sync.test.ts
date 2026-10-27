import { ClientCore } from "@ace/client";
import { FakeDaemon, facts, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, ThreadId, Notification as DaemonNotification } from "@ace/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { createNotificationSync, type NotificationSink } from "./notification-sync.ts";

/*
 * Android notification sync: the real SDK against the in-process fake daemon.
 * No fake production connection — register/unregister, presence, catch-up and
 * the durable Allow/Deny path all run over the same client the app ships.
 */

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const threadId = ThreadId.parse("approval");
const interactionSelection = (): { id: string } => ({ id: "" });

function schedule(delay: number, run: () => void): () => void {
  const timer = setTimeout(run, delay);
  return () => clearTimeout(timer);
}

const daemonAlert = (id: string): DaemonNotification =>
  DaemonNotification.parse({
    id,
    threadId,
    title: "Fix the flaky queue test",
    status: "done",
    backgroundCount: 0,
    actions: [],
  });

async function phone() {
  void interactionSelection;
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.createThread({
    id: threadId,
    workspaceId: "ace",
    title: "Fix the flaky queue test",
    provider: "codex",
    access: "ask",
  });
  daemon.apply(threadId, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "push",
      blocking: true,
      request: {
        kind: "approval",
        title: "Codex wants to run a command",
        options: [
          { id: "deny", label: "Deny", kind: "deny" },
          { id: "allow", label: "Allow", kind: "allow_once" },
        ],
      },
    },
  ]);
  const interactions = (): { id: string; state?: string }[] => {
    const view = daemon.snapshot({ kind: "thread", threadId });
    return view?.kind === "thread" ? Object.values(view.interactions) : [];
  };
  const interactionId = interactions()[0]?.id ?? "";
  let saved: string | null = null;
  let sequence = 0;
  const client = new ClientCore({
    deviceId: DeviceId.parse("phone"),
    transport: () => fakeTransport(daemon),
    storage: {
      load: async () => saved,
      save: async (value) => {
        saved = value;
      },
    },
    credential: async () => daemon.token,
    scheduler: { set: schedule },
    random: () => 0,
    id: () => `id-${++sequence}`,
  });
  const sinks: NotificationSink[] = [];
  const sync = createNotificationSync(
    client,
    (_key, read) => {
      const sink = read();
      if (sink) sinks.push(sink);
    },
    { schedule, detailsMs: 200, receiptMs: 500 },
  );
  closers.push(async () => {
    sync.close();
    await client.close();
  });
  await client.start();
  await vi.waitFor(() => expect(client.state).toBe("ready"));
  const enable = (enabled: boolean, cursor = 0): void =>
    sync.sync({ enabled, appState: "foreground", cursor });
  const barrier = (): Promise<unknown> => client.request({ type: "notification.config" });
  const of = (type: NotificationSink["type"]): NotificationSink[] =>
    sinks.filter((sink) => sink.type === type);
  const settle = async (): Promise<void> => {
    await new Promise((done) => setTimeout(done, 10));
    await barrier();
  };
  const approvalAlert = (id: string, optionIds = ["approve", "deny"]): DaemonNotification =>
    DaemonNotification.parse({
      id,
      threadId,
      title: "Codex wants to run a command",
      status: "needs_you",
      interactionId,
      backgroundCount: 0,
      actions: optionIds.map((optionId) => ({
        action: optionId === "allow" ? "approve" : "deny",
        optionId,
      })),
    });
  return {
    daemon,
    client,
    sync,
    enable,
    barrier,
    settle,
    of,
    interactions,
    interactionId,
    approvalAlert,
  };
}

const lastFeed = (of: (type: NotificationSink["type"]) => NotificationSink[]) =>
  of("notifications.feed").at(-1);

it("posts the daemon's live alerts only while notifications are on", async () => {
  const { daemon, enable, barrier, of } = await phone();
  enable(false);
  daemon.notify(daemonAlert("n:1"));
  await barrier();
  enable(true);
  daemon.notify(daemonAlert("n:2"));
  await vi.waitFor(() => expect(of("notifications.alert")).toHaveLength(1));
  expect(of("notifications.alert")[0]).toMatchObject({ notification: { id: "n:2" } });
});

it("catches up on what the daemon sent while the app was not listening, once per cursor", async () => {
  const { daemon, enable, of } = await phone();
  daemon.notify(daemonAlert("n:1"));
  enable(true);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(1));
  expect(of("notifications.feed")[0]).toMatchObject({
    cursor: 1,
    entries: [{ id: "n:1" }],
    retracted: [],
  });
  daemon.retractNotification("n:1");
  enable(true, 1);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(2));
  expect(of("notifications.feed")[1]).toMatchObject({ entries: [], retracted: ["n:1"] });
});

it("turning notifications off unregisters at once, and on again registers", async () => {
  const { daemon, enable, settle, of } = await phone();
  enable(true);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(1));
  enable(false);
  await settle();
  daemon.notify(daemonAlert("n:muted"));
  enable(true);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(2));
  expect(lastFeed(of)).toMatchObject({ entries: [] });
  daemon.notify(daemonAlert("n:on"));
  enable(true);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(3));
  expect(lastFeed(of)).toMatchObject({ entries: [{ id: "n:on" }] });
});

it("a mute that could not reach the daemon is applied on reconnect", async () => {
  const { daemon, enable, settle, of } = await phone();
  enable(true);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(1));
  daemon.failRequests("notification.unregister");
  enable(false);
  await settle();
  daemon.restoreRequests();
  daemon.disconnectAll();
  await vi.waitFor(() => expect(of("notifications.connected")).toHaveLength(2));
  await settle();
  daemon.notify(daemonAlert("n:muted"));
  enable(true);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(2));
  expect(lastFeed(of)).toMatchObject({ entries: [] });
});

it("an approval action answers the exact pending option once, through the durable path", async () => {
  const { sync, of, interactions, interactionId, approvalAlert } = await phone();
  const outcome = await sync.resolve({
    requestId: "tap-1",
    threadId,
    interactionId,
    optionId: "allow",
    alert: approvalAlert("n:1", ["allow", "deny"]),
    canOperate: true,
  });
  expect(outcome).toBe("confirmed");
  await vi.waitFor(() =>
    expect(of("notifications.action").at(-1)).toMatchObject({ id: "tap-1", outcome: "confirmed" }),
  );
  expect(interactions()[0]).toMatchObject({
    state: "resolved",
    resolution: { kind: "approval", optionId: "allow" },
  });
  // The same alert tapped again finds nothing pending and sends nothing.
  const second = await sync.resolve({
    requestId: "tap-2",
    threadId,
    interactionId,
    optionId: "allow",
    alert: approvalAlert("n:1", ["allow", "deny"]),
    canOperate: true,
  });
  expect(second).toBe("stale");
  expect(of("notifications.action").at(-1)).toEqual({
    type: "notifications.action",
    id: "tap-2",
    outcome: "stale",
  });
});

it("an action for an option the approval does not offer sends nothing", async () => {
  const { sync, of, interactions, interactionId, approvalAlert } = await phone();
  const outcome = await sync.resolve({
    requestId: "tap",
    threadId,
    interactionId,
    optionId: "always",
    alert: approvalAlert("n:1", ["allow", "deny"]),
    canOperate: true,
  });
  expect(outcome).toBe("stale");
  await vi.waitFor(() => expect(of("notifications.action")).toHaveLength(1));
  expect(of("notifications.action")[0]).toMatchObject({ outcome: "stale" });
  // The FakeDaemon stores `state` on the interaction record; it stays pending.
  expect(interactions()[0]?.state ?? "pending").toBe("pending");
});

it("a view-only pairing answers nothing", async () => {
  const { sync, of, interactionId, approvalAlert } = await phone();
  const outcome = await sync.resolve({
    requestId: "tap-view",
    threadId,
    interactionId,
    optionId: "allow",
    alert: approvalAlert("n:1", ["allow", "deny"]),
    canOperate: false,
  });
  expect(outcome).toBe("refused");
  expect(of("notifications.action").at(-1)).toMatchObject({ id: "tap-view", outcome: "refused" });
});
