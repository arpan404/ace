import { expect, test } from "vitest";
import { commands, connected, receipt, settle, threadId } from "./path-switch.fixture.ts";

test("a newer command never overtakes one the old path still owes a receipt for", async () => {
  const { clock, client, multipath, path, route } = await connected("relay", ["relay", "lan"]);
  const relay = path("relay").last;
  // The old path never answers the archive.
  void client.command({ type: "thread.archive", threadId });
  await settle();
  expect(commands(relay)).toEqual(["thread.archive"]);

  expect(await multipath.switchTo(route("lan"))).toBe(true);
  const lan = path("lan").sockets[0];
  if (!lan) throw new Error("No LAN socket");
  void client.command({ type: "thread.unarchive", threadId });
  await settle();
  // The unarchive waits while the old path drains, so the archive can't land after it.
  expect(commands(lan)).toEqual([]);

  clock.advance(2_000);
  await settle();
  expect(commands(lan)).toEqual(["thread.archive", "thread.unarchive"]);
  expect(client.state).toBe("ready");
});

test("a command answered on the old path while it drains lets newer ones go at once", async () => {
  const { client, multipath, path, route } = await connected("relay", ["relay", "lan"]);
  const relay = path("relay").last;
  void client.command({ type: "thread.archive", threadId });
  await settle();
  expect(await multipath.switchTo(route("lan"))).toBe(true);
  const lan = path("lan").sockets[0];
  if (!lan) throw new Error("No LAN socket");
  void client.command({ type: "thread.unarchive", threadId });
  await settle();
  expect(commands(lan)).toEqual([]);

  receipt(relay, "thread.archive");
  await settle();
  // Answered where it was sent: it isn't asked again, and the newer one goes right away.
  expect(commands(lan)).toEqual(["thread.unarchive"]);
});

test("a reconnect that reaches another daemon drops that path and connects over the others", async () => {
  const { clock, client, multipath, path, mismatched } = await connected("relay", ["relay", "lan"]);
  path("lan").up = false;
  path("relay").welcomes = "6b1d2f9e-0d3a-4c51-9a8e-2b7f4c1e0a99";
  const states: string[] = [];
  client.connectionState().subscribe(() => states.push(client.state));

  path("relay").last.drop();
  for (let round = 0; round < 4; round++) {
    clock.advance(1_000);
    await settle();
  }
  expect(mismatched).toEqual(["relay"]);
  expect(states).not.toContain("ready");

  // The other path comes back: the connection uses it, never the one that named another daemon.
  path("lan").up = true;
  const relaySockets = path("relay").sockets.length;
  for (let round = 0; round < 8 && client.state !== "ready"; round++) {
    clock.advance(30_000);
    await settle();
  }
  expect(client.state).toBe("ready");
  expect(multipath.active?.kind).toBe("lan");
  expect(path("relay").sockets.length).toBe(relaySockets);
});

test("an alert the warm standby heard before a failover is shown once", async () => {
  const { client, multipath, path } = await connected("lan", ["lan", "relay"]);
  await settle();
  const standby = path("relay").last;
  expect(standby.sent.map((message) => message.type)).toEqual(["hello", "presence.update"]);
  expect(standby.sent[1]).toMatchObject({ appState: "background" });

  const alerts: string[] = [];
  client.onMessage((message) => {
    if (message.type === "notification") alerts.push(message.notification.id);
  });
  const alert = {
    type: "notification",
    notification: {
      id: "alert-1",
      threadId: "thread",
      title: "Done",
      status: "agent_says",
      backgroundCount: 0,
      actions: [],
    },
  };
  // Both sockets of this device get the alert; the active one shows it.
  path("lan").last.deliver(alert);
  standby.deliver(alert);
  path("lan").last.drop();
  await settle();
  expect(multipath.active?.kind).toBe("relay");
  expect(client.state).toBe("ready");
  // The promoted standby says the app is in the foreground again.
  expect(standby.sent.at(-1)).toMatchObject({ type: "presence.update", appState: "foreground" });
  // The same alert again on the new path, as the old one may have carried it too.
  standby.deliver(alert);
  await settle();
  expect(alerts).toEqual(["alert-1"]);
});

test("a warm standby that fails comes back once its relay recovers", async () => {
  const { clock, multipath, path } = await connected("lan", ["lan", "relay"]);
  await settle();
  const relay = path("relay");
  expect(relay.sockets).toHaveLength(1);

  relay.up = false;
  relay.last.drop();
  await settle();
  // It rests, then tries again; while the relay stays down every try fails.
  clock.advance(1_000);
  await settle();
  expect(relay.sockets.length).toBeGreaterThan(1);
  expect(relay.last.closed).toBe(true);

  relay.up = true;
  for (let round = 0; round < 8 && relay.last.closed; round++) {
    clock.advance(4_000);
    await settle();
  }
  const standby = relay.last;
  expect(standby.closed).toBe(false);
  expect(standby.sent[0]).toMatchObject({ type: "hello" });

  // And it is a real standby: the LAN dropping fails over onto it.
  path("lan").last.drop();
  await settle();
  expect(multipath.active?.kind).toBe("relay");
});
