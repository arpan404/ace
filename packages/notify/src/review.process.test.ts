import { afterEach, expect, it } from "vitest";
import { DeviceId, Event, type Notification } from "@ace/protocol";
import { NotificationService, attachNotifications } from "./index.ts";
import { setup } from "./notify.test-helper.ts";

const fixtures: ReturnType<typeof setup>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
function fixture(outcome: "accepted" | "retry" = "accepted") {
  const f = setup(outcome);
  fixtures.push(f);
  return f;
}
function approval(f: ReturnType<typeof setup>, key: string) {
  const opened = f
    .fact({
      type: "interaction.opened",
      agent: "root",
      interaction: key,
      blocking: true,
      request: {
        kind: "approval",
        title: "private",
        options: [
          { id: `yes-${key}`, label: "Allow", kind: "allow_once" },
          { id: `no-${key}`, label: "Deny", kind: "deny" },
        ],
      },
    })
    .find((event) => event.payload.type === "interaction.opened");
  if (opened?.payload.type !== "interaction.opened") throw new Error("Missing approval");
  return opened.payload.interaction.id;
}
it("startup beyond pending capacity catches up before delivering and never sends stale completion", async () => {
  const deliveries: Notification[] = [];
  const service = new NotificationService({
    path: ":memory:",
    now: () => 1000,
    jitter: () => 0,
    windowMs: 0,
    transport: {
      async send(_device, notification) {
        deliveries.push(notification);
        return "accepted";
      },
    },
  });
  let seq = 0;
  const history: Event[] = [];
  for (let i = 0; i < 1001; i++) {
    const threadId = `t${i}`;
    for (const payload of [
      {
        type: "thread.created",
        thread: {
          id: threadId,
          workspaceId: "w",
          provider: "codex",
          title: "Safe",
          status: { state: "new" },
          createdAt: 1000,
          updatedAt: 1000,
        },
      },
      { type: "thread.updated", status: { state: "done" } },
    ])
      history.push(Event.parse({ seq: ++seq, id: `e${seq}`, threadId, at: 1000, payload }));
  }
  history.push(
    Event.parse({
      seq: ++seq,
      id: `e${seq}`,
      threadId: "t0",
      at: 1000,
      payload: { type: "thread.updated", status: { state: "working", agents: 1 } },
    }),
  );
  const errors: unknown[] = [];
  const attached = attachNotifications(
    service,
    {
      readEvents: ({ afterSeq, limit }) => history.slice(afterSeq, afterSeq + limit),
      subscribe: () => () => {},
    },
    (error) => errors.push(error),
  );
  try {
    service.register(DeviceId.parse("desktop"), { channel: "websocket", platform: "desktop" });
    for (let i = 0; i < 66; i++) await attached.tick();
    expect(service.cursor()).toBe(seq);
    expect(deliveries).toHaveLength(1000);
    expect(new Set(deliveries.map((notification) => notification.threadId)).size).toBe(1000);
    expect(deliveries.some((notification) => notification.threadId === "t0")).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    attached.close();
    await service.close();
  }
});
it("closing the approval on a retry relinks delivery to the remaining approval", async () => {
  const f = fixture("retry");
  f.start();
  const first = approval(f, "first"),
    second = approval(f, "second");
  await f.flush();
  expect(f.deliveries[0]?.notification.interactionId).toBe(first);
  f.fact({ type: "interaction.closed", interaction: "first", state: "resolved" });
  f.setOutcome("accepted");
  await f.flush();
  expect(f.deliveries.slice(2).map((d) => d.notification.interactionId)).toEqual([second, second]);
  expect(f.deliveries[2]?.notification.actions).toEqual([
    { action: "approve", optionId: "yes-second" },
    { action: "deny", optionId: "no-second" },
  ]);
});
it("a child question becomes the needs-you link only after its owner stops working", async () => {
  const f = fixture();
  f.start();
  f.fact({
    type: "agent.seen",
    agent: "child",
    parent: "root",
    origin: "provider_subagent",
    fidelity: "full",
    native: { provider: "codex", nativeId: "child" },
    cwd: "/repo",
  });
  f.start("user", "child");
  const childEvents = f.fact({
    type: "interaction.opened",
    agent: "child",
    interaction: "child-question",
    blocking: false,
    request: { kind: "question", questions: [] },
  });
  const expected = approval(f, "root");
  await f.flush();
  expect(f.deliveries.map((d) => d.notification.interactionId)).toEqual([expected, expected]);
  expect(f.deliveries[0]?.notification.actions).toEqual([
    { action: "approve", optionId: "yes-root" },
    { action: "deny", optionId: "no-root" },
  ]);
  const child = childEvents.find((event) => event.payload.type === "interaction.opened");
  if (child?.payload.type !== "interaction.opened") throw new Error("Missing child question");
  f.end("completed", "child");
  await f.flush();
  expect(f.deliveries.slice(2).map((d) => d.notification)).toEqual([
    expect.objectContaining({
      status: "needs_you",
      interactionId: child.payload.interaction.id,
      actions: [],
    }),
    expect.objectContaining({
      status: "needs_you",
      interactionId: child.payload.interaction.id,
      actions: [],
    }),
  ]);
});
it("resumed work clears completion while retaining a later background completion", async () => {
  const f = fixture();
  f.start();
  f.end();
  f.start();
  f.fact({
    type: "background.started",
    agent: "root",
    task: "later",
    kind: "shell",
    title: "private",
    stoppable: true,
  });
  f.fact({ type: "background.ended", task: "later", status: "completed" });
  await f.flush();
  expect(f.deliveries.map((d) => d.notification.status)).toEqual([
    "background_done",
    "background_done",
  ]);
});
it("unarchiving before the deadline never resurrects a cancelled completion", async () => {
  const f = fixture();
  f.start();
  f.end();
  f.append([
    { type: "thread.updated", archivedAt: 1000 },
    { type: "thread.updated", archivedAt: null },
  ]);
  await f.flush();
  expect(f.deliveries).toEqual([]);
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries).toHaveLength(2);
});
it("failed background work does not emit a successful background completion", async () => {
  const f = fixture();
  f.start();
  f.fact({
    type: "background.started",
    agent: "root",
    task: "failed",
    kind: "shell",
    title: "private",
    stoppable: true,
  });
  f.fact({ type: "background.ended", task: "failed", status: "failed" });
  await f.flush();
  expect(f.deliveries).toEqual([]);
});
it("expired pending intents do not occupy the delivery batch ahead of a fresh alert", async () => {
  let now = 1000,
    seq = 0;
  const delivered: Notification[] = [];
  const service = new NotificationService({
    path: ":memory:",
    windowMs: 0,
    now: () => now,
    jitter: () => 0,
    transport: {
      async send(_device, notification) {
        delivered.push(notification);
        return "accepted";
      },
    },
  });
  const completion = (threadId: string) =>
    service.ingest([
      Event.parse({
        seq: ++seq,
        id: `e${seq}`,
        threadId,
        at: now,
        payload: {
          type: "thread.created",
          thread: {
            id: threadId,
            workspaceId: "w",
            provider: "codex",
            title: "Safe",
            status: { state: "new" },
            createdAt: now,
            updatedAt: now,
          },
        },
      }),
      Event.parse({
        seq: ++seq,
        id: `e${seq}`,
        threadId,
        at: now,
        payload: { type: "thread.updated", status: { state: "done" } },
      }),
    ]);
  try {
    service.register(DeviceId.parse("desktop"), { channel: "websocket", platform: "desktop" });
    for (let i = 0; i < 64; i++) completion(`expired-${i}`);
    now += 86_400_000;
    completion("fresh");
    await service.drain();
    await service.drain();
    expect(delivered.map((n) => n.threadId)).toEqual(["fresh"]);
  } finally {
    await service.close();
  }
});
it("a full disk spool evicts the oldest alert and catches up without sending historical state", async () => {
  const delivered: Notification[] = [],
    history: Event[] = [],
    errors: unknown[] = [];
  const service = new NotificationService({
    path: ":memory:",
    windowMs: 0,
    now: () => 1000,
    jitter: () => 0,
    transport: {
      async send(_device, notification) {
        delivered.push(notification);
        return "accepted";
      },
    },
  });
  let seq = 0;
  for (let i = 0; i < 10_001; i++) {
    const threadId = `overflow-${i}`;
    history.push(
      Event.parse({
        seq: ++seq,
        id: `e${seq}`,
        threadId,
        at: 1000,
        payload: {
          type: "thread.created",
          thread: {
            id: threadId,
            workspaceId: "w",
            provider: "codex",
            title: "Safe",
            status: { state: "new" },
            createdAt: 1000,
            updatedAt: 1000,
          },
        },
      }),
      Event.parse({
        seq: ++seq,
        id: `e${seq}`,
        threadId,
        at: 1000,
        payload: { type: "thread.updated", status: { state: "done" } },
      }),
    );
  }
  const attached = attachNotifications(
    service,
    {
      readEvents: ({ afterSeq, limit }) => history.slice(afterSeq, afterSeq + limit),
      subscribe: () => () => {},
    },
    (error) => errors.push(error),
  );
  try {
    service.register(DeviceId.parse("desktop"), { channel: "websocket", platform: "desktop" });
    await attached.tick();
    expect(delivered).toEqual([]);
    for (let i = 0; i < 632; i++) await attached.tick();
    expect(service.cursor()).toBe(seq);
    expect(errors).toEqual([]);
    expect(delivered).toHaveLength(10_000);
    expect(new Set(delivered.map((n) => n.threadId)).size).toBe(10_000);
    expect(delivered.some((n) => n.threadId === "overflow-0")).toBe(false);
    expect(delivered.some((n) => n.threadId === "overflow-10000")).toBe(true);
  } finally {
    attached.close();
    await service.close();
  }
});
