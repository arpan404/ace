import { afterEach, expect, test } from "vitest";
import { CommandId, ThreadId } from "@ace/protocol";
import {
  browserPairing,
  closePools,
  fingerprint,
  lan,
  relayKey,
  until,
  world,
} from "./machine-merge.fixture.ts";

afterEach(closePools);

test("an account machine whose relay is out of reach takes the direct route once the app pairs it, listed once", async () => {
  const f = world();
  await f.pool.start();
  f.pool.openAccountMachine({ hostId: relayKey, name: "Office Mac" });
  await until(() => f.pool.machine(relayKey)?.status !== "connecting");
  expect(f.pool.machine(relayKey)?.status).not.toBe("online");

  await f.pool.add({
    ...browserPairing,
    target: { kind: "direct", url: "wss://192.168.1.4:7443/", fingerprint },
  });
  // The pairing said over its connection that ace's relay knows it by `relayKey`: one machine.
  await until(() => f.pool.machine(relayKey)?.status === "online");
  expect(f.pool.ids).toEqual([relayKey]);
  expect(f.pool.machine(relayKey)?.path).toBe("lan");
  expect(f.directDialed).toContain(lan);
});

test("a machine paired in a browser and opened through the account keeps the LAN route it was paired at", async () => {
  const f = world();
  await f.pool.start();
  await f.pool.add(browserPairing);
  await until(() => f.pool.machine("host")?.status === "online");
  await until(() => (f.directory.machines[0]?.paths?.length ?? 0) > 0);

  f.pool.openAccountMachine({ hostId: relayKey, name: "Office Mac" });
  expect(f.pool.ids).toEqual([relayKey]);
  // The paired connection stepped aside; the account entry reaches the same daemon on the LAN.
  await until(() => f.pool.machine(relayKey)?.status === "online");
  expect(f.pool.machine(relayKey)?.path).toBe("lan");
});

test("a send queued on the pairing is kept and sent once by the account entry that takes its place", async () => {
  const f = world();
  f.daemon.createThread({ id: "t1", workspaceId: "w", title: "Thread", provider: "codex" });
  const sent: string[] = [];
  const command = f.daemon.command.bind(f.daemon);
  f.daemon.command = (input) => {
    sent.push(input.id);
    return command(input);
  };
  await f.pool.start();
  await f.pool.add({
    ...browserPairing,
    target: { kind: "direct", url: "wss://192.168.1.4:7443/", fingerprint },
  });
  await until(() => (f.directory.machines[0]?.paths?.length ?? 0) > 0);
  await until(() => f.pool.machine("host")?.status === "online");
  // The machine stops answering; the send waits in the pairing's outbox.
  f.daemon.refuseConnections(true);
  await until(() => f.pool.machine("host")?.status !== "online");
  await f.pool.enqueue(
    { hostId: "host", threadId: "t1" },
    { type: "thread.archive", threadId: ThreadId.parse("t1") },
    "queued-on-lan",
  );
  const pairing = f.outboxes.get(`paired:host:${browserPairing.deviceId}`);
  expect([...(pairing?.keys() ?? [])]).toEqual(["queued-on-lan"]);

  // Signed in: the account entry takes the pairing's place, and its send with it.
  f.pool.openAccountMachine({ hostId: relayKey, name: "Office Mac" });
  await until(
    () => f.outboxes.get(`account:${relayKey}`)?.get("value")?.includes("queued-on-lan") ?? false,
  );
  expect(pairing?.size).toBe(0);
  f.daemon.refuseConnections(false);
  await until(() => f.pool.machine(relayKey)?.status === "online");
  const intent = f.pool.client(relayKey).intent("queued-on-lan");
  await until(() => intent.getSnapshot()?.state === "acked");
  expect(intent.getSnapshot()?.result).toMatchObject({ commandId: "queued-on-lan", ok: true });
  expect(sent).toEqual(["queued-on-lan"]);
});

test("an account machine already open takes over a pairing's send once the pairing's paths say they are one machine", async () => {
  const f = world();
  f.daemon.createThread({ id: "t1", workspaceId: "w", title: "Thread", provider: "codex" });
  // The pairing's first connection doesn't say how else the machine is reached.
  const paths = f.daemon.paths;
  f.daemon.paths = [];
  const sent: string[] = [];
  let unanswered = false;
  const command = f.daemon.command.bind(f.daemon);
  f.daemon.command = (input) => {
    // While unanswered, a send reaches the daemon and is neither run nor acknowledged.
    if (unanswered) return { commandId: CommandId.parse("never-asked"), ok: true };
    sent.push(input.id);
    return command(input);
  };
  await f.pool.start();
  f.pool.openAccountMachine({ hostId: relayKey, name: "Office Mac" });
  await f.pool.add({
    ...browserPairing,
    target: { kind: "direct", url: "wss://192.168.1.4:7443/", fingerprint },
  });
  await until(() => f.pool.machine("host")?.status === "online");
  expect(f.pool.ids).toEqual([relayKey, "host"]);
  unanswered = true;
  await f.pool.enqueue(
    { hostId: "host", threadId: "t1" },
    { type: "thread.archive", threadId: ThreadId.parse("t1") },
    "queued-on-lan",
  );
  expect([...(f.outboxes.get(`paired:host:${browserPairing.deviceId}`)?.keys() ?? [])]).toEqual([
    "queued-on-lan",
  ]);

  // The pairing reconnects and now says ace's relay knows it by `relayKey`: one machine.
  f.daemon.paths = paths;
  f.daemon.disconnectAll();
  await until(() => f.pool.ids.length === 1);
  expect(f.pool.ids).toEqual([relayKey]);
  // The machine answers again; whatever reached it unanswered is sent again on reconnecting.
  unanswered = false;
  f.daemon.disconnectAll();
  await until(() => f.pool.machine(relayKey)?.status !== "online");
  await until(() => f.pool.machine(relayKey)?.status === "online");
  const intent = f.pool.client(relayKey).intent("queued-on-lan");
  expect(intent.getSnapshot()).toBeDefined();
  await until(() => intent.getSnapshot()?.state === "acked");
  expect(intent.getSnapshot()?.result).toMatchObject({ commandId: "queued-on-lan", ok: true });
  expect(sent).toEqual(["queued-on-lan"]);
  expect(f.outboxes.get(`paired:host:${browserPairing.deviceId}`)?.size).toBe(0);
});
