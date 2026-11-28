import { ClientCore } from "@ace/client";
import { FakeDaemon, facts, fakeTransport } from "@ace/fake-daemon";
import {
  DeviceId,
  ThreadId,
  Notification as DaemonNotification,
  NotificationPreferences,
} from "@ace/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { ledgerScope, type LedgerPersistence } from "./notification-ledger.ts";
import { createNotificationSync, type NotificationSink } from "./notification-sync.ts";

/*
 * Android notification sync: the real SDK against the in-process fake daemon.
 * No fake production connection — register/unregister, presence, catch-up and
 * the durable Allow/Deny path all run over the same client the app ships.
 * One bridge per client: every paired machine gets its own client and bridge.
 */

type Closer = { dead: boolean; close: () => Promise<void> };
const closers: Closer[] = [];
afterEach(async () => {
  for (const closer of closers.splice(0)) {
    if (!closer.dead) await closer.close();
  }
});

const threadId = ThreadId.parse("approval");

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

type Put = (key: string, read: () => NotificationSink | undefined) => void;

async function stack(
  opts: {
    hostId?: string | undefined;
    deviceId?: string | undefined;
    persistence?: LedgerPersistence | undefined;
    daemon?: FakeDaemon | undefined;
    put?: Put | undefined;
    onKey?: ((key: string) => void) | undefined;
  } = {},
) {
  const daemon = opts.daemon ?? new FakeDaemon({ clock: () => 1000 });
  if (opts.daemon === undefined) {
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
  }
  const interactions = (): { id: string; state?: string }[] => {
    const view = daemon.snapshot({ kind: "thread", threadId });
    return view?.kind === "thread" ? Object.values(view.interactions) : [];
  };
  const interactionId = interactions()[0]?.id ?? "";
  const hostId = opts.hostId ?? "host-a";
  const deviceId = opts.deviceId ?? "phone";
  let saved: string | null = null;
  let sequence = 0;
  const client = new ClientCore({
    deviceId: DeviceId.parse(deviceId),
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
  const put: Put =
    opts.put ??
    ((_key, read) => {
      const sink = read();
      if (sink) sinks.push(sink);
    });
  const keyedPut: Put = (key, read) => {
    opts.onKey?.(key);
    put(key, read);
  };
  const sync = createNotificationSync(client, keyedPut, {
    schedule,
    detailsMs: 200,
    receiptMs: 500,
    hostId,
    deviceId,
    persistence: opts.persistence,
  });
  const entry: Closer = { dead: false, close: async () => {} };
  entry.close = async () => {
    sync.close();
    await client.close();
  };
  closers.push(entry);
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
  const dispose = async (): Promise<void> => {
    entry.dead = true;
    await entry.close();
  };
  return {
    daemon,
    client,
    sync,
    enable,
    barrier,
    settle,
    of,
    sinks,
    interactions,
    interactionId,
    approvalAlert,
    dispose,
  };
}

async function phone() {
  return stack();
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
  const { daemon, enable, barrier, of } = await phone();
  daemon.notify(daemonAlert("n:1"));
  // Let the live frame land while disabled (dropped, not admitted) so the
  // catch-up below is the first sighting.
  await barrier();
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

it("a live alert is not reposted by the catch-up feed", async () => {
  const { daemon, enable, of } = await phone();
  enable(true);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(1));
  daemon.notify(daemonAlert("n:live"));
  await vi.waitFor(() => expect(of("notifications.alert")).toHaveLength(1));
  // The next catch-up replays the same id; the ledger admits it only once.
  enable(true);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(2));
  expect(of("notifications.feed")[1]).toMatchObject({ entries: [] });
  expect(of("notifications.alert")).toHaveLength(1);
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
  // The live frame posts at once; the later catch-up must not repost it.
  await vi.waitFor(() => expect(of("notifications.alert")).toHaveLength(1));
  enable(true);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(3));
  expect(lastFeed(of)).toMatchObject({ entries: [] });
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

it("concurrent duplicate taps enqueue once and keep the exact live option", async () => {
  const { client, sync, of, interactions, interactionId, approvalAlert } = await phone();
  const enqueue = vi.spyOn(client, "enqueue");
  const alert = approvalAlert("n:1", ["allow", "deny"]);
  const [first, second] = await Promise.all([
    sync.resolve({
      requestId: "tap-first",
      threadId,
      interactionId,
      optionId: "allow",
      alert,
      canOperate: true,
    }),
    sync.resolve({
      requestId: "tap-second",
      threadId,
      interactionId,
      optionId: "allow",
      alert,
      canOperate: true,
    }),
  ]);
  expect(first).toBe("confirmed");
  expect(second).toBe("confirmed");
  // One outbox command for both taps; the live option is what the daemon got.
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(interactions()[0]).toMatchObject({
    state: "resolved",
    resolution: { kind: "approval", optionId: "allow" },
  });
  expect(of("notifications.action")).toContainEqual({
    type: "notifications.action",
    id: "tap-first",
    outcome: "confirmed",
  });
  expect(of("notifications.action")).toContainEqual({
    type: "notifications.action",
    id: "tap-second",
    outcome: "confirmed",
  });
});

it("concurrent taps with different options serialize: winner confirms, loser goes stale", async () => {
  const { client, sync, of, interactions, interactionId, approvalAlert } = await phone();
  const enqueue = vi.spyOn(client, "enqueue");
  const alert = approvalAlert("n:1", ["allow", "deny"]);
  const [winner, loser] = await Promise.all([
    sync.resolve({
      requestId: "tap-allow",
      threadId,
      interactionId,
      optionId: "allow",
      alert,
      canOperate: true,
    }),
    sync.resolve({
      requestId: "tap-deny",
      threadId,
      interactionId,
      optionId: "deny",
      alert,
      canOperate: true,
    }),
  ]);
  // The first tap owns the tail; the different-option waiter chains behind it
  // and revalidates after the interaction resolves.
  expect(winner).toBe("confirmed");
  expect(loser).toBe("stale");
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(interactions()[0]).toMatchObject({
    state: "resolved",
    resolution: { kind: "approval", optionId: "allow" },
  });
  expect(of("notifications.action")).toContainEqual({
    type: "notifications.action",
    id: "tap-allow",
    outcome: "confirmed",
  });
  expect(of("notifications.action")).toContainEqual({
    type: "notifications.action",
    id: "tap-deny",
    outcome: "stale",
  });
});

it("a rejected first tap still gives every waiter its own outcome", async () => {
  const { client, sync, of, interactions, interactionId, approvalAlert } = await phone();
  // The first `thread()` lease throws, so the owner's task rejects instead of
  // resolving to an outcome. Same-option waiters must still patch `unsaved`
  // (no unhandled rejection, no missing patch); the different-option waiter
  // chains behind and retries from live state.
  const thread = vi.spyOn(client, "thread").mockImplementationOnce(() => {
    throw new Error("lease boom");
  });
  const enqueue = vi.spyOn(client, "enqueue");
  const alert = approvalAlert("n:1", ["allow", "deny"]);
  const [owner, same, different] = await Promise.all([
    sync.resolve({
      requestId: "tap-owner",
      threadId,
      interactionId,
      optionId: "allow",
      alert,
      canOperate: true,
    }),
    sync.resolve({
      requestId: "tap-same",
      threadId,
      interactionId,
      optionId: "allow",
      alert,
      canOperate: true,
    }),
    sync.resolve({
      requestId: "tap-different",
      threadId,
      interactionId,
      optionId: "deny",
      alert,
      canOperate: true,
    }),
  ]);
  expect(owner).toBe("unsaved");
  expect(same).toBe("unsaved");
  expect(different).toBe("confirmed");
  // Only the chained retry enqueues; the rejected owner never reached it.
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(interactions()[0]).toMatchObject({
    state: "resolved",
    resolution: { kind: "approval", optionId: "deny" },
  });
  for (const [id, outcome] of [
    ["tap-owner", "unsaved"],
    ["tap-same", "unsaved"],
    ["tap-different", "confirmed"],
  ] as const) {
    expect(of("notifications.action")).toContainEqual({
      type: "notifications.action",
      id,
      outcome,
    });
  }
  thread.mockRestore();
});

it("multiple different-option waiters waking after failures never enqueue concurrently", async () => {
  const { daemon, client, sync, of, interactions, interactionId } = await phone();
  // A second pending approval offering three options, so three concurrent
  // taps can each name a different option.
  daemon.apply(threadId, [
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "push-3",
      blocking: true,
      request: {
        kind: "approval",
        title: "Codex wants a third command",
        options: [
          { id: "ox", label: "X", kind: "allow_once" },
          { id: "oy", label: "Y", kind: "allow_once" },
          { id: "oz", label: "Z", kind: "allow_once" },
        ],
      },
    },
  ]);
  await vi.waitFor(() => expect(interactions()).toHaveLength(2));
  const target = interactions().find((entry) => entry.id !== interactionId)?.id ?? "";
  expect(target).not.toBe("");
  const alert = DaemonNotification.parse({
    id: "n:3opt",
    threadId,
    title: "Codex wants a third command",
    status: "needs_you",
    interactionId: target,
    backgroundCount: 0,
    actions: [
      { action: "approve", optionId: "ox" },
      { action: "deny", optionId: "oy" },
    ],
  });
  // Fail the first two outbox saves (`unsaved` leaves the interaction
  // pending) while tracking overlap across every attempt; the third
  // succeeds. A serial chain gives exactly three saves, one at a time, and
  // every request its patch. Every attempt occupies the overlap window
  // (including the failing ones): tracking only the successful enqueue
  // would still show maxInFlight==1 under a concurrent implementation.
  const realEnqueue = client.enqueue.bind(client);
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const enqueue = vi.spyOn(client, "enqueue").mockImplementation(async (payload, id) => {
    calls += 1;
    const attempt = calls;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((done) => setTimeout(done, 20));
      if (attempt <= 2) throw new Error("outbox full");
      return await realEnqueue(payload, id as string);
    } finally {
      inFlight -= 1;
    }
  });
  // Guard the whole settle window (confirmed read + enqueue), not just the
  // outbox call: overlapping settleActions would hold overlapping thread
  // leases even if their enqueues happened to serialize by timing.
  const realThread = client.thread.bind(client);
  let leases = 0;
  let maxLeases = 0;
  vi.spyOn(client, "thread").mockImplementation(((...args: Parameters<typeof client.thread>) => {
    const lease = (
      realThread as (...a: Parameters<typeof client.thread>) => { release: () => void }
    )(...args);
    leases += 1;
    maxLeases = Math.max(maxLeases, leases);
    const release = lease.release.bind(lease);
    return {
      ...lease,
      release: () => {
        leases -= 1;
        release();
      },
    };
  }) as typeof client.thread);
  const [first, second, third] = await Promise.all([
    sync.resolve({
      requestId: "tap-ox",
      threadId,
      interactionId: target,
      optionId: "ox",
      alert,
      canOperate: true,
    }),
    sync.resolve({
      requestId: "tap-oy",
      threadId,
      interactionId: target,
      optionId: "oy",
      alert,
      canOperate: true,
    }),
    sync.resolve({
      requestId: "tap-oz",
      threadId,
      interactionId: target,
      optionId: "oz",
      alert,
      canOperate: true,
    }),
  ]);
  expect(first).toBe("unsaved");
  expect(second).toBe("unsaved");
  expect(third).toBe("confirmed");
  expect(calls).toBe(3);
  expect(enqueue).toHaveBeenCalledTimes(3);
  expect(maxInFlight).toBe(1);
  expect(maxLeases).toBe(1);
  expect(interactions().find((entry) => entry.id === target)).toMatchObject({
    state: "resolved",
    resolution: { kind: "approval", optionId: "oz" },
  });
  for (const [id, outcome] of [
    ["tap-ox", "unsaved"],
    ["tap-oy", "unsaved"],
    ["tap-oz", "confirmed"],
  ] as const) {
    expect(of("notifications.action")).toContainEqual({
      type: "notifications.action",
      id,
      outcome,
    });
  }
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

it("one bridge per client: two machines sharing a patch store never collide", async () => {
  const keys: string[] = [];
  const seen = new Map<string, NotificationSink | undefined>();
  const put: Put = (key, read) => {
    keys.push(key);
    const sink = read();
    if (sink) seen.set(key, sink);
  };
  // Two paired machines means two daemons, two clients, two bridges — the
  // patch store is the only thing they share.
  const left = await stack({ hostId: "host-a", deviceId: "phone", put });
  const right = await stack({ hostId: "host-b", deviceId: "phone", put });
  left.enable(true);
  right.enable(true);
  await left.barrier();
  await right.barrier();
  left.daemon.notify(daemonAlert("n:same"));
  right.daemon.notify(daemonAlert("n:same"));
  // Alert ids are encoded in keys (`:` -> `%3A`); the raw id never appears.
  await vi.waitFor(() => expect(keys.filter((key) => key.includes("n%3Asame"))).toHaveLength(2));
  const alertKeys = keys.filter((key) => key.includes("n%3Asame"));
  expect(new Set(alertKeys).size).toBe(2);
  expect(alertKeys.some((key) => key.includes("host-a"))).toBe(true);
  expect(alertKeys.some((key) => key.includes("host-b"))).toBe(true);
  // The same daemon id on two machines is two notifications: both posted.
  // (Both stacks share one `put`, so count the shared patches, not per-stack sinks.)
  const alerts = [...seen.values()].filter((sink) => sink?.type === "notifications.alert");
  expect(alerts).toHaveLength(2);
  const feeds = keys.filter((key) => key.endsWith(":feed"));
  expect(new Set(feeds).size).toBe(2);
});

it("hosts and ids with separators never share a bridge key", async () => {
  const keys: string[] = [];
  const put: Put = (key, read) => {
    keys.push(key);
    read();
  };
  // Raw `host|id` joins would alias ("a|b", "c") with ("a", "b|c").
  const left = await stack({ hostId: "a|b", deviceId: "phone", put });
  const right = await stack({ hostId: "a", deviceId: "phone", put });
  left.enable(true);
  right.enable(true);
  await left.barrier();
  await right.barrier();
  left.daemon.notify(daemonAlert("c"));
  right.daemon.notify(daemonAlert("b|c"));
  await vi.waitFor(() => expect(keys.filter((key) => key.includes("alert"))).toHaveLength(2));
  const alertKeys = keys.filter((key) => key.includes("alert"));
  expect(new Set(alertKeys).size).toBe(2);
  for (const key of alertKeys) expect(key).not.toContain("\0");
});

it("a restart restores the ledger: catch-up never reposts shown ids", async () => {
  const saved = new Map<string, { cursor: number; shown: readonly string[] }>();
  const persistence: LedgerPersistence = {
    load: (scope) => saved.get(scope) ?? null,
    save: (scope, snapshot) => {
      saved.set(scope, snapshot);
    },
  };
  const first = await stack({ hostId: "host-a", deviceId: "phone", persistence });
  first.daemon.notify(daemonAlert("n:1"));
  // Let the live frame land while disabled (dropped, not admitted) so the
  // catch-up below is the first sighting.
  await first.barrier();
  first.enable(true);
  await vi.waitFor(() => expect(first.of("notifications.feed")).toHaveLength(1));
  expect(first.of("notifications.feed")[0]).toMatchObject({
    cursor: 1,
    entries: [{ id: "n:1" }],
  });
  expect(first.sync.cursor()).toBe(1);
  // Simulate a process restart: a fresh client and bridge over the same
  // daemon and the same persisted ledger.
  await first.dispose();
  const second = await stack({
    hostId: "host-a",
    deviceId: "phone",
    persistence,
    daemon: first.daemon,
  });
  expect(second.sync.cursor()).toBe(1);
  second.enable(true);
  await vi.waitFor(() => expect(second.of("notifications.feed")).toHaveLength(1));
  expect(second.of("notifications.feed")[0]).toMatchObject({ cursor: 1, entries: [] });
  // What arrives after the restart still posts, exactly once.
  second.daemon.notify(daemonAlert("n:2"));
  await vi.waitFor(() => expect(second.of("notifications.alert")).toHaveLength(1));
  expect(second.of("notifications.alert")[0]).toMatchObject({ notification: { id: "n:2" } });
  second.enable(true);
  await vi.waitFor(() => expect(second.of("notifications.feed")).toHaveLength(2));
  expect(second.of("notifications.feed")[1]).toMatchObject({ entries: [] });
});

it("a rebuilt database rewinds to the head without reposting shown ids", async () => {
  const saved = new Map<string, { cursor: number; shown: readonly string[] }>();
  const persistence: LedgerPersistence = {
    load: (scope) => saved.get(scope) ?? null,
    save: (scope, snapshot) => {
      saved.set(scope, snapshot);
    },
  };
  // The ledger was persisted past the rebuilt head; n:1 was already shown.
  saved.set(ledgerScope("host-a", "phone"), { cursor: 10, shown: ["n:1"] });
  const { daemon, enable, of, sync } = await stack({
    hostId: "host-a",
    deviceId: "phone",
    persistence,
  });
  daemon.notify(daemonAlert("n:1"));
  enable(true);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(1));
  // The cursor follows the daemon head backwards; the reissued id stays
  // deduped instead of posting again.
  expect(of("notifications.feed")[0]).toMatchObject({ cursor: 1, entries: [] });
  expect(sync.cursor()).toBe(1);
});

it("a cursor beyond the daemon head restarts from the head on rebuilt database", async () => {
  const { daemon, enable, barrier, of } = await phone();
  daemon.notify(daemonAlert("n:1"));
  // Let the live frame land while disabled (dropped, not admitted).
  await barrier();
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
