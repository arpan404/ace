import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectClientViaRelay } from "@ace/relay";
import { Client } from "@ace/client";
import { browserDeviceSocket } from "@ace/client/devices";
import { aceAccountClient } from "@ace/client/ace-account";
import { MachineDirectory } from "@ace/client/machines";
import { MachinePool } from "@ace/client-worker/machines";
import { DeviceCredential, DeviceId, PairingResponse } from "@ace/protocol";
import { SettingsService } from "@ace/settings";
import {
  fakeWorkos,
  signInThroughWorker,
  relayUpgrade,
  startRelayWorker,
  type WorkosUser,
} from "@ace/relay-cloudflare/testing";
import { fixture, token } from "./socket-test-support.ts";
import { accessRequest } from "./client-access.ts";
import { loadIdentity } from "./tls-identity.ts";
import { tlsFixtureHome } from "./process-test-support.ts";
import { readConfig } from "./config.ts";
import { message } from "./payload-test-support.ts";
import type { CommandHandler } from "./commands.ts";
import { machineAccount, type MachineAccount } from "./account-access/machine-account.ts";

// ace's hosted relay end to end: a real daemon and real clients through the Cloudflare Worker
// under Miniflare (local D1, its admission rules and Durable Object), signing in through the
// Worker's account API against a fake WorkOS. No provider is spawned.

let workos: Awaited<ReturnType<typeof fakeWorkos>>;
let worker: Awaited<ReturnType<typeof startRelayWorker>>;
beforeAll(async () => {
  workos = await fakeWorkos();
  worker = await startRelayWorker({ workosUrl: workos.url });
});
afterAll(async () => {
  await worker?.close();
  await workos?.close();
});
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

const owner: WorkosUser = {
  id: "user_a",
  email: "a@example.com",
  first_name: "Ace",
  last_name: null,
};
const stranger: WorkosUser = {
  id: "user_b",
  email: "b@example.com",
  first_name: "Bea",
  last_name: null,
};
const signal = () => AbortSignal.timeout(10_000);
const scheduler = {
  set(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

/** A provider at the boundary: every `thread.send` produces one answer in the thread. */
const answering: CommandHandler = {
  handle(command, store) {
    const payload = command.payload;
    if (payload.type !== "thread.send")
      return { commandId: command.id, ok: false, error: "not_implemented" };
    store.appendEvents(payload.threadId, [
      { type: "item.created", item: message(`answer-${command.id}`, "Done") },
    ]);
    return { commandId: command.id, ok: true };
  },
};

/**
 * A daemon not yet signed in. By default remote access is on ace's relay (the Worker) only;
 * `direct` serves the LAN and Tailscale instead and names no relay at all.
 */
async function hostedDaemon(direct = false) {
  const home = await mkdtemp(join(tmpdir(), "ace-relay-e2e-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const settings = new SettingsService({ dataDir: home });
  cleanup.push(() => settings.close());
  await settings.set("remote.enabled", true, { kind: "global" });
  if (direct) {
    await settings.set("remote.lan", true, { kind: "global" });
    await settings.set("remote.tailscale", true, { kind: "global" });
  } else {
    await settings.set("remote.transport", "relay", { kind: "global" });
    await settings.set("remote.relayUrl", worker.relayUrl, { kind: "global" });
  }
  let account: MachineAccount | undefined;
  const identity = direct ? loadIdentity(tlsFixtureHome()) : undefined;
  const f = await fixture(
    {
      settings,
      handler: answering,
      remoteConfig: readConfig({
        ACE_HOME: home,
        ACE_PORT: "0",
        ...(direct ? { ACE_ADVERTISE_HOST: "127.0.0.1" } : { ACE_LISTEN: "local" }),
        ACE_HOSTED_RELAY_URL: worker.relayUrl,
      }),
      ...(identity
        ? {
            network: {
              identity: () => identity,
              interfaces: () => ({}),
              status: async () =>
                JSON.stringify({ BackendState: "Running", TailscaleIPs: ["127.0.0.1"] }),
              certificate: async () => {
                throw new Error("HTTPS certificates are off for this tailnet");
              },
            },
          }
        : {}),
      hostName: "Build box",
      platform: "linux",
    },
    (store) => {
      account = machineAccount({
        dataDir: home,
        codes: store.machineCodes,
        fetch: globalThis.fetch,
        now: Date.now,
        randomBytes,
        delay: (run, milliseconds) => {
          const timer = setTimeout(run, milliseconds);
          return () => clearTimeout(timer);
        },
      });
      return { machineAccount: account };
    },
  );
  cleanup.push(() => f.close());
  if (!account) throw new Error("Machine account missing");
  const machine = account;
  cleanup.push(() => machine.close());
  return { f, account: machine, fingerprint: identity?.fingerprint };
}

const accounts = () => aceAccountClient({ origin: worker.http, fetch: globalThis.fetch });

/** An app's machine pool on `session`'s account, with a fresh device grant per attempt. */
function pool(session: string, deviceId: string) {
  const id = DeviceId.parse(deviceId);
  const memory = new Map<string, string>();
  let sequence = 0;
  const machines = new MachinePool({
    directory: new MachineDirectory(
      { load: async () => null, save: async () => {} },
      {
        get: async (key) => memory.get(key) ?? null,
        set: async (key, value) => void memory.set(key, value),
        delete: async (key) => void memory.delete(key),
      },
    ),
    spawn: () => {
      throw new Error("Account machines need no worker");
    },
    remote: { scheduler },
    account: {
      relayUrl: worker.relayUrl,
      deviceId: id,
      grant: async () =>
        (await accounts().grant(session, { kind: "device", subject: id }, signal())).token,
      socket: browserDeviceSocket,
      client: (route) =>
        new Client({
          deviceId: id,
          transport: route.transport,
          credential: route.credential,
          storage: { load: async () => null, save: async () => {} },
          scheduler,
          random: () => 0.5,
          id: () => `${deviceId}-${++sequence}`,
        }),
    },
  });
  cleanup.push(() => machines.close());
  return machines;
}

it("a daemon signed in through the Worker registers, and an app on its account runs a turn after entering the machine code", async () => {
  const { f, account } = await hostedDaemon();
  // The desktop app signs in through the Worker and hands the daemon its session.
  const session = await signInThroughWorker(worker.http, workos, owner);
  await account.handover(worker.http, session.token);
  await expect.poll(() => f.server.relayHostId, { timeout: 10_000 }).toBeDefined();
  const hostId = f.server.relayHostId ?? "";
  await expect
    .poll(() => accounts().machines(session.token, signal()), { timeout: 10_000 })
    .toContainEqual({
      hostId,
      name: "Build box",
      platform: "linux",
      lastSeenAt: expect.any(Number),
    });
  await account.setMachineCode("2468");

  const machines = pool(session.token, "phone");
  const opened = machines.openAccountMachine({ hostId, name: "Build box" });
  await expect
    .poll(() => opened.get(), { timeout: 10_000 })
    .toEqual({ kind: "asking", reason: "machine_code_required" });
  opened.enter("2468");
  await expect.poll(() => opened.get(), { timeout: 10_000 }).toEqual({ kind: "open" });

  const client = machines.client(hostId);
  const lease = client.thread(f.thread.id);
  cleanup.push(() => lease.release());
  const result = await client.command({
    type: "thread.send",
    threadId: f.thread.id,
    input: [{ type: "text", text: "Hello through ace's relay" }],
    delivery: "queue",
  });
  expect(result).toMatchObject({ ok: true });
  await expect
    .poll(() => lease.store.item(`answer-${result.commandId}`)?.id, { timeout: 10_000 })
    .toBe(`answer-${result.commandId}`);
});

it("a device on another account cannot reach the machine, and signing the machine out ends its registration", async () => {
  const { f, account } = await hostedDaemon();
  const session = await signInThroughWorker(worker.http, workos, owner);
  await account.handover(worker.http, session.token);
  await expect.poll(() => f.server.relayHostId, { timeout: 10_000 }).toBeDefined();
  const hostId = f.server.relayHostId ?? "";
  await expect
    .poll(async () => (await accounts().machines(session.token, signal())).map((m) => m.hostId), {
      timeout: 10_000,
    })
    .toContain(hostId);

  const other = await signInThroughWorker(worker.http, workos, stranger);
  expect(await accounts().machines(other.token, signal())).toEqual([]);
  const deviceGrant = async (token: string, subject: string) =>
    (await accounts().grant(token, { kind: "device", subject }, signal())).token;
  const clientUrl = `${worker.relayUrl}/client?hostId=${hostId}`;
  expect(await relayUpgrade(clientUrl, await deviceGrant(other.token, "intruder"))).toMatchObject({
    code: 4403,
    reason: "Not your machine",
  });
  // A stranger's app stops with the reason instead of retrying.
  const intruder = pool(other.token, "intruder").openAccountMachine({ hostId, name: "Build box" });
  await expect
    .poll(() => intruder.get(), { timeout: 10_000 })
    .toEqual({ kind: "failed", message: "This machine isn't on your ace account." });

  // The owner's own device gets through while the machine is signed in.
  const reached = await connectClientViaRelay({
    relayUrl: worker.relayUrl,
    hostId,
    pinnedFingerprint: hostId,
    grant: await deviceGrant(session.token, "phone"),
  });
  reached.close();

  await account.signOut();
  await expect.poll(() => f.server.relayHostId, { timeout: 10_000 }).toBeUndefined();
  expect(await relayUpgrade(clientUrl, await deviceGrant(session.token, "phone"))).toMatchObject({
    code: 1008,
    reason: "Host unavailable",
  });
});

it("a signed-in machine on the LAN and Tailscale is also on ace's relay; signing out leaves the LAN serving", async () => {
  const { f, account, fingerprint } = await hostedDaemon(true);
  const session = await signInThroughWorker(worker.http, workos, owner);
  await account.handover(worker.http, session.token);
  // Signing in is all it takes: the phone's account lists the machine and opens it.
  await expect.poll(() => f.server.relayHostId, { timeout: 10_000 }).toBeDefined();
  const hostId = f.server.relayHostId ?? "";
  await expect
    .poll(async () => (await accounts().machines(session.token, signal())).map((m) => m.hostId), {
      timeout: 10_000,
    })
    .toContain(hostId);
  const opened = pool(session.token, "phone").openAccountMachine({ hostId, name: "Build box" });
  await expect.poll(() => opened.get(), { timeout: 10_000 }).toEqual({ kind: "open" });

  await account.signOut();
  await expect.poll(() => f.server.relayHostId, { timeout: 10_000 }).toBeUndefined();
  // The LAN still serves, and pairing links name it.
  const pairing = PairingResponse.parse(
    await accessRequest(f.server.httpUrl, "/v1/pairings", { token, method: "POST", body: {} }),
  );
  const link = new URL(pairing.url);
  expect(link.protocol).toBe("https:");
  const paired = DeviceCredential.parse(
    await accessRequest(link.origin, "/v1/pair", {
      ...(fingerprint ? { fingerprint } : {}),
      method: "POST",
      body: {
        code: new URLSearchParams(link.hash.slice(1)).get("code"),
        name: "Laptop on the LAN",
      },
    }),
  );
  expect(paired.device.name).toBe("Laptop on the LAN");
});
