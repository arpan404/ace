import { afterEach, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "@ace/relay";
import { keyPair } from "@ace/secure-channel";
import { Client, ClientError, machineCodeAdmin, machineCodeGate, relayRoute } from "@ace/client";
import { browserDeviceSocket } from "@ace/client/devices";
import { aceAccountClient } from "@ace/client/ace-account";
import { DeviceId, HostId } from "@ace/protocol";
import { MachineDirectory } from "@ace/client/machines";
import { MachinePool } from "@ace/client-worker/machines";
import { fixture, token } from "./socket-test-support.ts";
import { accessRequest } from "./client-access.ts";
import { machineAccount } from "./account-access/machine-account.ts";
import { startFakeAccountBackend } from "./account-backend-test-support.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

const scheduler = {
  set(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

/** A daemon signed in to an ace account, reachable only through a relay. */
async function accountMachine() {
  const backend = await startFakeAccountBackend(Date.now);
  cleanup.push(() => backend.close());
  const root = await mkdtemp(join(tmpdir(), "ace-relay-account-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  let account: ReturnType<typeof machineAccount> | undefined;
  const f = await fixture({ relay: { url: relay.url, keys: keyPair() } }, (store) => {
    account = machineAccount({
      dataDir: root,
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
  });
  cleanup.push(() => f.close());
  if (!account) throw new Error("Machine account missing");
  cleanup.push(() => account?.close());
  await account.handover(backend.origin, backend.token);
  const hostId = f.server.relayHostId;
  if (!hostId) throw new Error("Relay host missing");
  const accounts = aceAccountClient({ origin: backend.origin, fetch: globalThis.fetch });

  /** An app signed in to the same account, connecting with a fresh device grant per attempt. */
  function device(deviceId: string) {
    const id = DeviceId.parse(deviceId);
    const gate = machineCodeGate(
      async () =>
        (
          await accounts.grant(
            backend.token,
            { kind: "device", subject: id },
            AbortSignal.timeout(5000),
          )
        ).token,
    );
    const route = relayRoute({
      relayUrl: relay.url,
      hostId: hostId ?? "",
      credential: () => gate.credential(),
      socket: browserDeviceSocket,
      schedule: (callback, delayMs) => scheduler.set(delayMs, callback),
      refused: (reason) => gate.refused(reason),
      welcomed: () => gate.welcomed(),
    });
    let sequence = 0;
    const connect = async () => {
      const client = new Client({
        deviceId: id,
        transport: route.transport,
        credential: route.credential,
        storage: { load: async () => null, save: async () => {} },
        scheduler,
        random: () => 0.5,
        id: () => `${deviceId}-${++sequence}`,
      });
      cleanup.push(() => client.close());
      await client.start();
      await expect.poll(() => client.state, { timeout: 10_000 }).toMatch(/^(ready|fatal)$/);
      return client;
    };
    return { gate, connect };
  }
  /** This app's machine pool, opening account machines with grants from the backend. */
  function pool(deviceId: string) {
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
        relayUrl: relay.url,
        deviceId: id,
        grant: async () =>
          (
            await accounts.grant(
              backend.token,
              { kind: "device", subject: id },
              AbortSignal.timeout(5000),
            )
          ).token,
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
  return { f, backend, device, pool, hostId };
}

it("an account device connects through the relay with a fresh grant per attempt", async () => {
  const machine = await accountMachine();
  const phone = machine.device("phone");
  const before = machine.backend.grantRequests.length;
  const first = await phone.connect();
  expect(first.state).toBe("ready");
  await first.close();
  const second = await phone.connect();
  expect(second.state).toBe("ready");
  expect(machine.backend.grantRequests.slice(before)).toEqual([
    { kind: "device", subject: "phone" },
    { kind: "device", subject: "phone" },
  ]);
});

it("an account device is asked for the machine code an admin set over the wire, and gets in with it", async () => {
  const machine = await accountMachine();
  const laptop = machine.device("laptop");
  const admin = await laptop.connect();
  expect(admin.state).toBe("ready");
  const set = await admin.request({ type: "machine.code.set", code: "2468" });
  expect(set.result).toMatchObject({ ok: true, status: { machineCode: { set: true } } });
  // The device that set the code keeps its own access.
  expect((await admin.request({ type: "machine.code.status" })).result).toMatchObject({
    ok: true,
  });

  const phone = machine.device("phone");
  const refused = await phone.connect();
  expect(refused.state).toBe("fatal");
  expect(refused.error).toEqual(new ClientError("machine_code", "machine_code_required"));
  expect(phone.gate.asking).toBe("machine_code_required");

  phone.gate.enter("1111");
  const wrong = await phone.connect();
  expect(wrong.error?.message).toBe("machine_code_wrong");

  phone.gate.enter("2468");
  const admitted = await phone.connect();
  expect(admitted.state).toBe("ready");
  expect(phone.gate.asking).toBeUndefined();

  const cleared = await admin.request({ type: "machine.code.clear" });
  expect(cleared.result).toMatchObject({ ok: true, status: { machineCode: { set: false } } });
});

it("the machine pool opens an account machine, asks for its code, and lists it once entered", async () => {
  const machine = await accountMachine();
  const admin = await machine.device("laptop").connect();
  expect((await admin.request({ type: "machine.code.set", code: "8642" })).result.ok).toBe(true);

  const machines = machine.pool("tablet");
  const opened = machines.openAccountMachine({ hostId: machine.hostId, name: "Office Mac" });
  await expect
    .poll(() => opened.get(), { timeout: 10_000 })
    .toEqual({ kind: "asking", reason: "machine_code_required" });
  expect(machines.machine(machine.hostId)?.status).toBe("machine_code");

  opened.enter("8642");
  await expect.poll(() => opened.get(), { timeout: 10_000 }).toEqual({ kind: "open" });
  expect(machines.ids).toEqual([machine.hostId]);
  expect(machines.machine(machine.hostId)?.identity?.hostId).toBe("host");
  // The admin call works on the pooled machine's own connection too.
  expect(await machineCodeAdmin(machines.client(machine.hostId)).status()).toMatchObject({
    ok: true,
    status: { machineCode: { set: true } },
  });

  await opened.close();
  expect(machines.ids).toEqual([]);
});

it("a machine also paired from this device steps aside while its account entry is open", async () => {
  const machine = await accountMachine();
  const machines = machine.pool("tablet");
  // Paired earlier, by the daemon's own id ("host"), with whatever scopes pairing gave.
  await machines.add({
    identity: { hostId: HostId.parse("host"), displayName: "Office Mac", version: "1" },
    target: { kind: "direct", url: "wss://192.168.1.4:7443/" },
    deviceId: "tablet-paired",
    token: "e".repeat(64),
  });
  expect(machines.ids).toEqual(["host"]);

  const opened = machines.openAccountMachine({ hostId: machine.hostId, name: "Office Mac" });
  await expect.poll(() => opened.get(), { timeout: 10_000 }).toEqual({ kind: "open" });
  // Signing in wins over pairing: the same machine is listed once, as the account's (admin).
  expect(machines.ids).toEqual([machine.hostId]);
  expect(machines.machine("host")).toBeUndefined();

  await opened.close();
  expect(machines.ids).toEqual(["host"]);
});

it("a paired entry stays aside even when added later, and comes back while the account entry asks for its code", async () => {
  const machine = await accountMachine();
  const admin = await machine.device("laptop").connect();
  const machines = machine.pool("tablet");
  const opened = machines.openAccountMachine({ hostId: machine.hostId, name: "Office Mac" });
  await expect.poll(() => opened.get(), { timeout: 10_000 }).toEqual({ kind: "open" });

  // Paired after the account entry proved the daemon: it never shows beside it.
  await machines.add({
    identity: { hostId: HostId.parse("host"), displayName: "Office Mac", version: "1" },
    target: { kind: "direct", url: "wss://192.168.1.4:7443/" },
    deviceId: "tablet-paired",
    token: "e".repeat(64),
  });
  expect(machines.ids).toEqual([machine.hostId]);

  // The machine code changes while connected: the account entry reconnects and asks for it
  // (not a revocation), and meanwhile the paired entry is back.
  expect((await admin.request({ type: "machine.code.set", code: "8642" })).result.ok).toBe(true);
  await expect
    .poll(() => opened.get(), { timeout: 10_000 })
    .toEqual({ kind: "asking", reason: "machine_code_required" });
  expect(machines.ids).toContain("host");

  // The code entered: the account entry opens again and the paired one steps aside again.
  opened.enter("8642");
  await expect.poll(() => opened.get(), { timeout: 10_000 }).toEqual({ kind: "open" });
  expect(machines.ids).toEqual([machine.hostId]);
});

it("an account device reads the machine's remote access and account status and its devices through the hosted relay", async () => {
  const machine = await accountMachine();
  const laptop = await machine.device("laptop").connect();
  expect(laptop.state).toBe("ready");

  const status = await laptop.request({
    type: "fleet.request",
    operation: { op: "remoteStatus" },
  });
  expect(status.result).toMatchObject({
    kind: "remoteStatus",
    status: { transport: "relay", account: { signedIn: true } },
  });
  const devices = await laptop.request({ type: "fleet.request", operation: { op: "devices" } });
  expect(devices.result).toEqual({
    kind: "devices",
    devices: await accessRequest(machine.f.server.httpUrl, "/v1/devices", { token }),
  });
});

it("the window's account leaving closes its account machines, and they open again on demand", async () => {
  const machine = await accountMachine();
  const machines = machine.pool("tablet");
  const opened = machines.openAccountMachine({ hostId: machine.hostId, name: "Office Mac" });
  await expect.poll(() => opened.get(), { timeout: 10_000 }).toEqual({ kind: "open" });
  const client = machines.client(machine.hostId);

  machines.closeAccountMachines();
  expect(machines.ids).toEqual([]);
  expect(opened.get()).toEqual({ kind: "failed", message: "This machine is closed." });
  expect(() => machines.client(machine.hostId)).toThrow(ClientError);
  await expect.poll(() => client.state, { timeout: 10_000 }).not.toBe("ready");

  const again = machines.openAccountMachine({ hostId: machine.hostId, name: "Office Mac" });
  await expect.poll(() => again.get(), { timeout: 10_000 }).toEqual({ kind: "open" });
  expect(machines.ids).toEqual([machine.hostId]);
});
