import { createECDH, randomBytes } from "node:crypto";
import { DeviceId, HostId, ThreadId, WorkspaceId, type Notification } from "@ace/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { setup } from "./notify.test-helper.ts";
import { createNotificationRouter } from "./index.ts";

const fixtures: ReturnType<typeof setup>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
function fixture(
  outcome: Parameters<typeof setup>[0] = "accepted",
  send?: Parameters<typeof setup>[1],
) {
  const f = setup(outcome, send);
  fixtures.push(f);
  return f;
}
/** The fixture's thread, as a child an agent on a paired machine delegated here. */
const delegatedHere = (f: ReturnType<typeof setup>) =>
  f.append([
    {
      type: "thread.updated",
      delegatedFrom: { hostId: HostId.parse("host-a"), threadId: ThreadId.parse("parent-on-a") },
    },
  ]);
const askApproval = (f: ReturnType<typeof setup>) =>
  f.fact({
    type: "interaction.opened",
    agent: "root",
    interaction: "approval",
    blocking: true,
    request: {
      kind: "approval",
      title: "Run the tests",
      options: [
        { id: "yes", label: "Allow", kind: "allow_once" },
        { id: "no", label: "Deny", kind: "deny" },
      ],
    },
  });

it("a paired machine's child asking for approval alerts no device here; a local thread does", async () => {
  const local = fixture();
  local.start();
  askApproval(local);
  await local.flush();
  expect(local.deliveries.map((d) => d.notification.status)).toEqual(["needs_you", "needs_you"]);

  const delegated = fixture();
  delegatedHere(delegated);
  delegated.start();
  askApproval(delegated);
  delegated.end();
  await delegated.flush();
  delegated.service.notify({
    id: "agent-says",
    threadId: delegated.threadId,
    title: "Child says",
    status: "agent_says",
    backgroundCount: 0,
    actions: [],
  });
  await delegated.flush();
  expect(delegated.deliveries).toEqual([]);
  expect(delegated.service.feed(delegated.phone, 0).entries).toEqual([]);
});

it("alerts already queued for a thread are dropped once it is known as a paired machine's child", async () => {
  const local = fixture("retry");
  local.start();
  local.end();
  await local.flush();
  local.setOutcome("accepted");
  local.setTime(7000);
  await local.service.drain();
  expect(local.deliveries).toHaveLength(4);

  const delegated = fixture("retry");
  delegated.start();
  delegated.end();
  await delegated.flush();
  expect(delegated.deliveries).toHaveLength(2);
  delegatedHere(delegated);
  delegated.setOutcome("accepted");
  delegated.setTime(7000);
  await delegated.service.drain();
  expect(delegated.deliveries).toHaveLength(2);
});

/**
 * A phone with a push address whose app is suspended: the live frame is never acknowledged, so
 * once the wait is let go the router falls back to a push, unless the send was stopped.
 */
function suspendedPhone() {
  const pushes: Notification[] = [];
  let letGo: ((acknowledged: boolean) => void) | undefined;
  const router = createNotificationRouter({
    websocket: () => false,
    acknowledged: () =>
      new Promise<boolean>((resolve) => {
        letGo = resolve;
      }),
    push: {
      async send(_device, notification) {
        pushes.push(notification);
        return "accepted";
      },
    },
  });
  const f = fixture("accepted", (device, notification, signal) =>
    router.send(device, notification, signal),
  );
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  f.service.register(DeviceId.parse("pushed-phone"), {
    channel: "push",
    platform: "phone",
    token: "cd".repeat(32),
    environment: "sandbox",
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  });
  return {
    f,
    pushes,
    /** Starts delivering the approval alert and returns once it waits for the phone's ack. */
    async waiting() {
      f.start();
      askApproval(f);
      f.setTime(7000);
      const sending = f.service.drain();
      await vi.waitFor(() => expect(letGo).toBeDefined());
      // Wrapped: an async function returning the drain itself would wait for it to finish.
      return { sent: sending };
    },
    ackTimesOut: () => letGo?.(false),
  };
}

it("an alert waiting on a phone's acknowledgement never falls back to a push once its thread is known as a paired machine's", async () => {
  const local = suspendedPhone();
  const localSend = await local.waiting();
  local.ackTimesOut();
  await localSend.sent;
  expect(local.pushes.map((alert) => alert.status)).toEqual(["needs_you"]);

  const delegated = suspendedPhone();
  const send = await delegated.waiting();
  delegatedHere(delegated.f);
  delegated.ackTimesOut();
  await send.sent;
  delegated.f.setTime(600_000);
  await delegated.f.service.drain();
  expect(delegated.pushes).toEqual([]);
});

it("a catch-up filed under a thread found to be a paired machine's still tells the device about the others", async () => {
  const f = fixture("failed");
  const thread = (id: string) => {
    const threadId = ThreadId.parse(id);
    f.append(
      [
        {
          type: "thread.created",
          thread: {
            id: threadId,
            workspaceId: WorkspaceId.parse("workspace"),
            title: `Thread ${id}`,
            provider: "codex",
            status: { state: "new" },
            createdAt: 1000,
            updatedAt: 1000,
          },
        },
      ],
      threadId,
    );
    return threadId;
  };
  const delegated = thread("delegated"),
    local = thread("local");
  // The delegated thread waits first, so the catch-up naming both is filed under it.
  for (const waiting of [delegated, local])
    f.append(
      [{ type: "thread.updated", status: { state: "needs_you", interactions: 1 } }],
      waiting,
    );
  await f.flush();
  f.deliveries.length = 0;

  // The desktop comes back; its catch-up's first send fails, so it is queued for a retry.
  f.setOutcome("retry");
  f.service.connectDevice(f.desktop);
  await f.flush();
  expect(f.deliveries.map((d) => d.notification.status)).toEqual(["catch_up"]);
  f.append(
    [
      {
        type: "thread.updated",
        delegatedFrom: { hostId: HostId.parse("host-a"), threadId: ThreadId.parse("parent-on-a") },
      },
    ],
    delegated,
  );

  f.setOutcome("accepted");
  f.setTime(600_000);
  await f.service.drain();
  expect(f.deliveries.at(-1)?.notification).toMatchObject({
    status: "catch_up",
    threadId: local,
    threadIds: [local],
  });
});
