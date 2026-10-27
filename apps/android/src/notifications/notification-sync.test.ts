import { ClientCore } from "@ace/client";
import { FakeDaemon, facts, fakeTransport } from "@ace/fake-daemon";
import {
  DeviceId,
  ThreadId,
  Notification as DaemonNotification,
  NotificationPreferences,
} from "@ace/protocol";
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

it("sends the confirmed live option id, never the stale alert's option", async () => {
  const { sync, of, interactions, interactionId, approvalAlert } = await phone();
  // Live offers allow/deny; the displayed alert is stale with different ids.
  const stale = approvalAlert("n:stale", ["approve", "deny"]);
  const outcome = await sync.resolve({
    requestId: "tap-live",
    threadId,
    interactionId,
    optionId: "allow",
    alert: stale,
    canOperate: true,
  });
  expect(outcome).toBe("confirmed");
  await vi.waitFor(() =>
    expect(of("notifications.action").at(-1)).toMatchObject({
      id: "tap-live",
      outcome: "confirmed",
    }),
  );
  // The daemon received the live id, not the stale alert's approve id.
  expect(interactions()[0]).toMatchObject({
    state: "resolved",
    resolution: { kind: "approval", optionId: "allow" },
  });
});

it("a stale option id the live approval does not offer sends nothing", async () => {
  const { sync, of, interactions, interactionId, approvalAlert } = await phone();
  const stale = approvalAlert("n:stale", ["approve", "deny"]);
  const outcome = await sync.resolve({
    requestId: "tap-stale-option",
    threadId,
    interactionId,
    optionId: "approve",
    alert: stale,
    canOperate: true,
  });
  expect(outcome).toBe("stale");
  await vi.waitFor(() => expect(of("notifications.action")).toHaveLength(1));
  expect(interactions()[0]?.state ?? "pending").toBe("pending");
});

it("a reissued interaction answers only the new pending option", async () => {
  const { daemon, sync, of, interactions, interactionId, approvalAlert } = await phone();
  const stale = approvalAlert("n:old", ["allow", "deny"]);
  expect(
    await sync.resolve({
      requestId: "tap-old",
      threadId,
      interactionId,
      optionId: "allow",
      alert: stale,
      canOperate: true,
    }),
  ).toBe("confirmed");
  await vi.waitFor(() =>
    expect(of("notifications.action").at(-1)).toMatchObject({ outcome: "confirmed" }),
  );
  // The daemon reissues: a new pending approval with a new id and options.
  daemon.apply(threadId, [
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "push-2",
      blocking: true,
      request: {
        kind: "approval",
        title: "Codex wants to run another command",
        options: [
          { id: "deny", label: "Deny", kind: "deny" },
          { id: "allow_always", label: "Always allow", kind: "allow_once" },
        ],
      },
    },
  ]);
  await vi.waitFor(() => expect(interactions()).toHaveLength(2));
  const next = interactions().find((entry) => entry.id !== interactionId);
  expect(next?.state ?? "pending").toBe("pending");
  const nextId = next?.id ?? "";
  const nextAlert = DaemonNotification.parse({
    id: "n:new",
    threadId,
    title: "Codex wants to run another command",
    status: "needs_you",
    interactionId: nextId,
    backgroundCount: 0,
    actions: [
      { action: "deny", optionId: "deny" },
      { action: "approve", optionId: "allow_always" },
    ],
  });
  // The old alert tapped again finds nothing pending and sends nothing.
  expect(
    await sync.resolve({
      requestId: "tap-old-again",
      threadId,
      interactionId,
      optionId: "allow",
      alert: stale,
      canOperate: true,
    }),
  ).toBe("stale");
  // The reissued alert answers the new exact option.
  expect(
    await sync.resolve({
      requestId: "tap-new",
      threadId,
      interactionId: nextId,
      optionId: "allow_always",
      alert: nextAlert,
      canOperate: true,
    }),
  ).toBe("confirmed");
  await vi.waitFor(() =>
    expect(of("notifications.action").at(-1)).toMatchObject({
      id: "tap-new",
      outcome: "confirmed",
    }),
  );
  expect(interactions().find((entry) => entry.id === nextId)).toMatchObject({
    state: "resolved",
    resolution: { kind: "approval", optionId: "allow_always" },
  });
});

it("two machines sharing one patch store never collide on bridge keys", async () => {
  const { daemon, client, barrier } = await phone();
  const seen = new Map<string, NotificationSink | undefined>();
  const keys: string[] = [];
  const put = (key: string, read: () => NotificationSink | undefined): void => {
    keys.push(key);
    const sink = read();
    if (sink) seen.set(key, sink);
  };
  const left = createNotificationSync(client, put, {
    schedule,
    detailsMs: 200,
    receiptMs: 500,
    hostId: "host-a",
  });
  const right = createNotificationSync(client, put, {
    schedule,
    detailsMs: 200,
    receiptMs: 500,
    hostId: "host-b",
  });
  closers.push(async () => {
    left.close();
    right.close();
  });
  left.sync({ enabled: true, appState: "foreground", cursor: 0 });
  right.sync({ enabled: true, appState: "foreground", cursor: 0 });
  await barrier();
  daemon.notify(daemonAlert("n:same"));
  await vi.waitFor(() => expect(keys.filter((key) => key.includes("n:same"))).toHaveLength(2));
  const alertKeys = keys.filter((key) => key.includes("n:same"));
  expect(new Set(alertKeys).size).toBe(2);
  expect(alertKeys.some((key) => key.includes("host-a"))).toBe(true);
  expect(alertKeys.some((key) => key.includes("host-b"))).toBe(true);
});

it("a cursor beyond the daemon head restarts from the head on rebuilt database", async () => {
  const { daemon, enable, of } = await phone();
  daemon.notify(daemonAlert("n:1"));
  // The ledger was restored past the rebuilt head; catch-up still returns all.
  enable(true, 10);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(1));
  expect(of("notifications.feed")[0]).toMatchObject({
    cursor: 1,
    entries: [{ id: "n:1" }],
  });
});

it("saving preferences preserves quiet hours and agent visibility", async () => {
  const sent: unknown[] = [];
  const stub = {
    connectionState: () => ({ subscribe: () => () => {}, getSnapshot: () => "ready" }),
    onMessage: () => () => {},
    send: (message: unknown) => {
      sent.push(message);
    },
    request: async () => ({ type: "notification.config.result" as const }),
  };
  const sync = createNotificationSync(
    stub as unknown as Parameters<typeof createNotificationSync>[0],
    () => {},
    { schedule, detailsMs: 200, receiptMs: 500, hostId: "host-a" },
  );
  sync.savePreferences(
    NotificationPreferences.parse({
      quietHours: { timeZone: "America/Chicago", startMinute: 1320, endMinute: 360 },
      includePreview: true,
      agentSays: true,
    }),
  );
  sync.close();
  const prefs = sent.find(
    (message): message is { type: string; preferences: Record<string, unknown> } =>
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === "notification.preferences",
  );
  expect(prefs?.preferences).toMatchObject({
    includePreview: true,
    agentSays: true,
    quietHours: { timeZone: "America/Chicago", startMinute: 1320, endMinute: 360 },
  });
});
