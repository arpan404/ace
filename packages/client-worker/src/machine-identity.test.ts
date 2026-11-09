import { afterEach, expect, test } from "vitest";
import { ClientError, type Transport } from "@ace/client";
import { pairingLinkProof } from "@ace/client/link-proof";
import { DeviceId, ThreadId } from "@ace/protocol";
import {
  accountToken,
  browserPairing,
  closePools,
  fingerprint,
  relayKey,
  token,
  until,
  world,
} from "./machine-merge.fixture.ts";

afterEach(closePools);

/** The pairing as a desktop saves it: its address pinned, so the account can use it too. */
const pinnedPairing = {
  ...browserPairing,
  target: { kind: "direct" as const, url: "wss://192.168.1.4:7443/", fingerprint },
};
const accountDeviceId = "01936d1e-3f8a-7c2b-9d4e-5f6a7b8c9d0e";
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

/** A daemon that wants this machine's code before it lets an account device in. */
const asksForCode = (): Transport => ({
  open(events) {
    setTimeout(() => events.close(4011, "machine_code_required"), 0);
  },
  send() {},
  close() {},
});

/** Pair the machine and wait until its connection has told the app its paths. */
async function pairAndLearnPaths(f: ReturnType<typeof world>) {
  await f.pool.add(pinnedPairing);
  await until(() => (f.directory.machines[0]?.paths?.length ?? 0) > 0);
  await settle();
}

test("a machine this install paired again elsewhere reconnects with the new token, in one worker", async () => {
  const fresh = "f".repeat(64);
  const f = world();
  await f.pool.start();
  await f.pool.add(browserPairing);
  await until(() => f.pool.machine("host")?.status === "online");

  f.pairAgainElsewhere(fresh);
  await until(() => f.workers.length === 2 && f.pool.machine("host")?.status === "online");
  expect(f.workers).toEqual([
    { token, terminated: true },
    { token: fresh, terminated: false },
  ]);
  expect(f.pool.ids).toEqual(["host"]);
});

test("a paired machine refusing the token it holds now stays refused, without restarting", async () => {
  const f = world();
  await f.pool.start();
  await f.pool.add(browserPairing);
  await until(() => f.pool.machine("host")?.status === "online");

  f.daemon.accepts = () => false;
  f.daemon.disconnectAll(4001);
  await until(() => f.pool.machine("host")?.status === "auth_failed");
  await settle();
  expect(f.workers).toHaveLength(1);
});

test("an account entry refused its authorization doesn't take a working pairing aside", async () => {
  const f = world({
    grant: () => Promise.reject(new ClientError("auth", "Sign in to ace again.")),
  });
  await f.pool.start();
  f.pool.openAccountMachine({ hostId: relayKey, name: "Office Mac" });
  await until(() => f.pool.machine(relayKey)?.status === "auth_failed");

  await pairAndLearnPaths(f);
  expect(f.pool.ids).toContain("host");
  expect(f.pool.machine("host")?.status).toBe("online");
});

test("an account entry waiting for its machine code doesn't take a working pairing aside", async () => {
  const f = world({ accountTransport: asksForCode });
  await f.pool.start();
  f.pool.openAccountMachine({ hostId: relayKey, name: "Office Mac" });
  await until(() => f.pool.machine(relayKey)?.status === "machine_code");

  await pairAndLearnPaths(f);
  expect(f.pool.ids).toContain("host");
  expect(f.pool.machine("host")?.status).toBe("online");
});

test("an account machine reads as the same state until it changes, so a page watching it settles", async () => {
  const f = world({ accountTransport: asksForCode });
  await f.pool.start();
  const opened = f.pool.openAccountMachine({ hostId: relayKey, name: "Office Mac" });
  await until(() => opened.get().kind === "asking");

  const asking = opened.get();
  expect(opened.get()).toBe(asking);
  opened.gate.enter("1234");
  expect(opened.get()).not.toBe(asking);
  expect(opened.get()).toBe(opened.get());
});

test("an account machine turned off before its daemon was known stays off as its pairing after sign-out", async () => {
  let stored: readonly string[] = [];
  const f = world({ off: { load: () => stored, save: (ids) => void (stored = ids) } });
  await f.pool.start();
  f.pool.openAccountMachine({ hostId: relayKey, name: "Office Mac" });
  f.pool.turnOff(relayKey);

  await pairAndLearnPaths(f);
  f.pool.closeAccountMachines();
  await settle();
  expect(f.pool.machine("host")?.status).toBe("off");
  // Nothing connects: the pairing's only worker is the one that ran before it was known.
  expect(f.workers).toHaveLength(1);
  expect(f.workers.every((worker) => worker.terminated)).toBe(true);
  expect(stored.toSorted()).toEqual(["host", relayKey].toSorted());
});

test("the link proof is the HMAC the daemon recomputes from the paired token's hash", async () => {
  const link = await pairingLinkProof(
    "ace-test-token",
    DeviceId.parse("dev-paired-1"),
    DeviceId.parse(accountDeviceId),
    crypto.subtle,
  );
  expect(link).toEqual({
    deviceId: "dev-paired-1",
    proof: "p_YxW23xNBoRAG2ha65bdxvF7ZXb9gcI9lWzyv68q-M",
  });
});

test("an account machine that adopted this app's pairing proves it in its hellos; once forgotten it doesn't", async () => {
  const f = world({ accountDeviceId });
  await f.pool.start();
  await pairAndLearnPaths(f);
  f.pool.openAccountMachine({ hostId: relayKey, name: "Office Mac" });
  await until(() => f.accountCredentials.length > 0);
  const credential = f.accountCredentials[0];
  if (!credential) throw new Error("no account route");

  const hello = await credential();
  expect(hello).toEqual({
    grant: "grant",
    link: await pairingLinkProof(
      token,
      DeviceId.parse(browserPairing.deviceId),
      DeviceId.parse(accountDeviceId),
      crypto.subtle,
    ),
  });
  // Only the proof goes on the account connection, never the paired token.
  expect(JSON.stringify(hello)).not.toContain(token);

  await f.pool.remove("host");
  expect(await credential()).toEqual({ grant: "grant" });
});

test("an account entry that turns out to be an Off pairing's daemon is stopped as soon as its identity says so", async () => {
  let stored: readonly string[] = ["host"];
  const f = world({
    off: { load: () => stored, save: (ids) => void (stored = ids) },
    accountOverRelay: true,
  });
  await f.pool.start();
  // Paired and turned off before it ever connected: no saved paths name its account entry.
  await f.pool.add(browserPairing);
  expect(f.pool.machine("host")?.status).toBe("off");

  f.pool.openAccountMachine({ hostId: relayKey, name: "Office Mac" });
  await until(() => stored.includes(relayKey));
  await settle();
  expect(f.pool.machine(relayKey)?.status).toBe("off");
  expect(f.accountSockets.length).toBeGreaterThan(0);
  expect(f.accountSockets.every((socket) => socket.closed)).toBe(true);
  expect(f.pool.threads.ids).toEqual([]);
  // One machine, listed once, and nothing connects to it.
  expect(f.pool.ids).toEqual([relayKey]);
  expect(f.workers).toEqual([]);
});

test("forgetting a pairing that is off forgets it under its account id too, so pairing it again starts on", async () => {
  let stored: readonly string[] = [];
  const off = { load: () => stored, save: (ids: readonly string[]) => void (stored = ids) };
  const f = world({ off });
  await f.pool.start();
  f.pool.openAccountMachine({ hostId: relayKey, name: "Office Mac" });
  f.pool.turnOff(relayKey);
  await pairAndLearnPaths(f);
  f.pool.closeAccountMachines();
  expect(stored.toSorted()).toEqual(["host", relayKey].toSorted());

  await f.pool.remove("host");
  expect(stored).toEqual([]);
  // Paired again and found through the account again: one machine, on.
  await pairAndLearnPaths(f);
  f.pool.openAccountMachine({ hostId: relayKey, name: "Office Mac" });
  await until(() => f.pool.machine(relayKey)?.status === "online");
  expect(stored).toEqual([]);
});

test("forgetting a pairing while its account entry is still listed and off turns the machine on, so pairing it again isn't off", async () => {
  let stored: readonly string[] = [];
  const off = { load: () => stored, save: (ids: readonly string[]) => void (stored = ids) };
  const f = world({ off, accountOverRelay: true });
  await f.pool.start();
  f.pool.openAccountMachine({ hostId: relayKey, name: "Office Mac" });
  await until(() => f.pool.machine(relayKey)?.status === "online");
  await f.pool.add(browserPairing);
  expect(f.pool.ids).toEqual([relayKey]);
  f.pool.turnOff(relayKey);
  expect(stored.toSorted()).toEqual(["host", relayKey].toSorted());

  // Forgotten on purpose while the account still lists the machine.
  await f.pool.remove("host");
  expect(stored).toEqual([]);
  await until(() => f.pool.machine(relayKey)?.status === "online");
  // Paired again: one machine, and on.
  await f.pool.add(browserPairing);
  await settle();
  expect(f.pool.ids).toEqual([relayKey]);
  expect(f.pool.machine(relayKey)?.status).toBe("online");
  expect(f.pool.isOff("host")).toBe(false);
  expect(stored).toEqual([]);
});

test("a send queued on the pairing moves to the account entry whose identity shows it is the same daemon, and is sent once", async () => {
  const f = world({ accountOverRelay: true });
  // The pairing's connection never says the machine's paths: only the account entry can tell.
  f.daemon.paths = [];
  f.daemon.createThread({ id: "t1", workspaceId: "w", title: "Thread", provider: "codex" });
  const sent: string[] = [];
  const command = f.daemon.command.bind(f.daemon);
  f.daemon.command = (input) => {
    sent.push(input.id);
    return command(input);
  };
  await f.pool.start();
  await f.pool.add(browserPairing);
  await until(() => f.pool.machine("host")?.status === "online");
  f.daemon.refuseConnections(true);
  await until(() => f.pool.machine("host")?.status !== "online");
  await f.pool.enqueue(
    { hostId: "host", threadId: "t1" },
    { type: "thread.archive", threadId: ThreadId.parse("t1") },
    "queued-on-lan",
  );
  // The pairing can't get back in; the account entry can.
  f.daemon.accepts = (credential) => credential.token === accountToken;
  f.pool.openAccountMachine({ hostId: relayKey, name: "Office Mac" });
  f.daemon.refuseConnections(false);

  await until(() => f.pool.machine(relayKey)?.status === "online");
  expect(f.pool.ids).toEqual([relayKey]);
  const intent = f.pool.client(relayKey).intent("queued-on-lan");
  await until(() => intent.getSnapshot()?.state === "acked");
  expect(intent.getSnapshot()?.result).toMatchObject({ ok: true });
  expect(f.outboxes.get(`paired:host:${browserPairing.deviceId}`)?.size).toBe(0);
  expect(sent).toEqual(["queued-on-lan"]);
});
