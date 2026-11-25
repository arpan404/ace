import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { NotificationWorker, attachNotifications, createNotificationRouter } from "@ace/notify";
import { type DeviceId, type Notification } from "@ace/protocol";
import { expect, it } from "vitest";
import { deviceKey, useAccountBackend } from "./machine-standing-test-support.ts";
import { helloWith, orgTeamHost, provesMember } from "./org-host-test-support.ts";

// Why a process test: the member's socket, the org host's standing proof and the notification
// worker's inbox are real; the empty answer must not depend on any of their internals.
const backend = useAccountBackend();
const noSender = (): boolean => false;

it("an organization member's feed reads and receipts stay identical while another device's inbox advances", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ace-org-feed-"));
  let sender: (device: DeviceId, notification: Notification) => boolean = noSender;
  const service = new NotificationWorker({
    path: join(dir, "notify.sqlite"),
    windowMs: 0,
    transport: createNotificationRouter({ websocket: (id, value) => sender(id, value) }),
  });
  const team = await orgTeamHost(backend, { server: { notifications: service } });
  const { f } = team.home;
  sender = f.server.notify;
  const attached = attachNotifications(service, f.store, () => {});
  await attached.tick();

  const key = await deviceKey();
  const grant = await team.memberGrant(team.home.session.token, key.raw);
  const admitted = await helloWith(team.home, grant.token);
  expect(
    (await provesMember(admitted.client, team.home.host, admitted.nonce, grant.token, key)).ok,
  ).toBe(true);
  const member = admitted.client;
  const feed = async (message: Record<string, unknown>) => {
    member.send({ type: "notification.feed", requestId: "feed", ...message } as never);
    const reply = await member.next();
    if (reply.type !== "notification.feed.result")
      throw new Error(`Unexpected ${JSON.stringify(reply)}`);
    const { requestId: _, ...rest } = reply;
    return rest;
  };
  const before = [
    await feed({ afterCursor: 120 }),
    await feed({ afterCursor: 121 }),
    await feed({ afterCursor: 5, checkpoint: true }),
  ];

  // The host's own paired phone gets alerts: the global inbox head moves.
  const other = await f.connect();
  expect(await other.next()).toMatchObject({ type: "welcome" });
  other.send({
    type: "notification.register",
    requestId: "register",
    device: { channel: "websocket", platform: "phone" },
  });
  await other.next();
  other.send({ type: "presence.update", threadId: null, inputAgeMs: 0, appState: "background" });
  for (let n = 0; n < 3; n++) {
    f.store.appendEvents(f.thread.id, [
      { type: "thread.updated", status: { state: "working", agents: 1 } },
      { type: "thread.updated", status: { state: "done" } },
    ]);
    await attached.tick();
  }

  const after = [
    await feed({ afterCursor: 120 }),
    await feed({ afterCursor: 121 }),
    await feed({ afterCursor: 5, checkpoint: true }),
  ];
  expect(after).toEqual(before);
  expect(before[0]).toEqual({
    type: "notification.feed.result",
    cursor: 0,
    entries: [],
    retracted: [],
  });
  await attached.close();
  await team.home.f.close();
  await service.close();
  rmSync(dir, { recursive: true, force: true });
}, 60_000);
