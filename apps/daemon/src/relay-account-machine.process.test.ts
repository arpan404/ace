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
import {
  CommandId,
  Device,
  DeviceCredential,
  DeviceId,
  HostId,
  PairingResponse,
  type PairingLinkProof,
} from "@ace/protocol";
import { pairingLinkProof } from "@ace/client/link-proof";
import { parsePairingLink } from "@ace/client/access";
import { MachineDirectory } from "@ace/client/machines";
import {
  MachinePool,
  type AccountMachineOptions,
  type OffMachines,
} from "@ace/client-worker/machines";
import { webSocketTransport, type Transport } from "@ace/client";
import { ticketSocket } from "./client-access.ts";
import { loadIdentity } from "./tls-identity.ts";
import { tlsFixtureHome } from "./process-test-support.ts";
import { fixture, token } from "./socket-test-support.ts";
import { accessRequest } from "./client-access.ts";
import { machineAccount } from "./account-access/machine-account.ts";
import { startFakeAccountBackend } from "./account-backend-test-support.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

const identity = loadIdentity(tlsFixtureHome());
const scheduler = {
  set(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

/**
 * A daemon signed in to an ace account, reachable through a relay, and with `direct` also on
 * its pinned TLS listener.
 */
async function accountMachine(direct = false) {
  const backend = await startFakeAccountBackend(Date.now);
  cleanup.push(() => backend.close());
  const root = await mkdtemp(join(tmpdir(), "ace-relay-account-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  let account: ReturnType<typeof machineAccount> | undefined;
  const f = await fixture(
    {
      relay: { url: relay.url, keys: keyPair() },
      ...(direct
        ? { remote: { host: "127.0.0.1", advertisedHost: "127.0.0.1", port: 0, identity } }
        : {}),
    },
    (store) => {
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
    },
  );
  cleanup.push(() => f.close());
  if (!account) throw new Error("Machine account missing");
  cleanup.push(() => account?.close());
  await account.handover(backend.origin, backend.token);
  const hostId = f.server.relayHostId;
  if (!hostId) throw new Error("Relay host missing");
  const accounts = aceAccountClient({ origin: backend.origin, fetch: globalThis.fetch });

  /** An app signed in to the same account, connecting with a fresh device grant per attempt. */
  function device(deviceId: string, link?: () => Promise<PairingLinkProof>) {
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
      // With `link`, its hello also proves the same install's paired credential (ADR 0115).
      credential: async () => {
        const credential = await gate.credential();
        return link ? { ...credential, link: await link() } : credential;
      },
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
  function pool(deviceId: string, extra: PoolExtras = {}) {
    const id = DeviceId.parse(deviceId);
    const memory = new Map<string, string>();
    let sequence = 0;
    let saved: string | null = null;
    const directory =
      extra.directory ??
      new MachineDirectory(
        {
          load: async () => saved,
          save: async (value) => {
            saved = value;
          },
        },
        {
          get: async (key) => memory.get(key) ?? null,
          set: async (key, value) => void memory.set(key, value),
          delete: async (key) => void memory.delete(key),
        },
      );
    const machines = new MachinePool({
      directory,
      spawn: () => {
        throw new Error("Account machines need no worker");
      },
      remote: { scheduler, ...(extra.now ? { now: extra.now } : {}) },
      ...(extra.off ? { off: extra.off } : {}),
      account: {
        ...(extra.directRoute ? { directRoute: extra.directRoute } : {}),
        ...(extra.watchNetwork ? { watchNetwork: extra.watchNetwork } : {}),
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
    return Object.assign(machines, { directory });
  }
  return { f, backend, device, pool, hostId, relay };
}
type PoolExtras = Partial<
  Pick<AccountMachineOptions, "directRoute" | "watchNetwork"> & {
    now: () => number;
    off: OffMachines;
    /** Another pool's directory: the same app starting again. */
    directory: MachineDirectory;
  }
>;

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

it("the window's account leaving brings back the paired entry its account machine stood in for", async () => {
  const machine = await accountMachine();
  const machines = machine.pool("tablet");
  await machines.add({
    identity: { hostId: HostId.parse("host"), displayName: "Office Mac", version: "1" },
    target: { kind: "direct", url: "wss://192.168.1.4:7443/" },
    deviceId: "tablet-paired",
    token: "e".repeat(64),
  });
  const opened = machines.openAccountMachine({ hostId: machine.hostId, name: "Office Mac" });
  await expect.poll(() => opened.get(), { timeout: 10_000 }).toEqual({ kind: "open" });
  expect(machines.ids).toEqual([machine.hostId]);

  machines.closeAccountMachines();
  expect(machines.ids).toEqual(["host"]);
});

it("a phone reached over LAN and ace's relay is one device on the daemon", async () => {
  const machine = await accountMachine();
  const installId = "01936d1e-3f8a-7c2b-9d4e-5f6a7b8c9d0e";
  const pairing = PairingResponse.parse(
    await accessRequest(machine.f.server.httpUrl, "/v1/pairings", {
      method: "POST",
      token,
      body: { scopes: ["read"] },
    }),
  );
  const paired = DeviceCredential.parse(
    await accessRequest(machine.f.server.httpUrl, "/v1/pair", {
      method: "POST",
      body: { code: parsePairingLink(pairing.url).code, name: "Phone", installId },
    }),
  );
  // Its paired device id is the daemon's own: an install id is no secret to be named by.
  expect(paired.device.id).not.toBe(installId);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const relayed = await machine.device(installId).connect();
  expect(relayed.state).toBe("ready");
  const listed = Device.array().parse(
    await accessRequest(machine.f.server.httpUrl, "/v1/devices", { token }),
  );
  expect(listed.map((device) => device.id)).toEqual([paired.device.id]);
  // Reaching it through ace's relay is that device being seen.
  expect(listed[0]?.lastSeenAt).toBeGreaterThan(paired.device.lastSeenAt);
});

it("a machine paired directly and found through the account is one machine on the phone, using the direct route while it works and the relay when it doesn't", async () => {
  const machine = await accountMachine(true);
  const remoteUrl = machine.f.server.remoteUrl;
  if (!remoteUrl) throw new Error("Remote listener missing");
  const lanUrl = remoteUrl.replace("wss:", "https:").replace(/\/$/, "");
  // The LAN can drop: its sockets close and new ones fail until it is back.
  let lanUp = true;
  const lanSockets = new Set<{ close(): void }>();
  let skew = 0;
  let networkChanged: (() => void) | undefined;
  const lanTransport = (): Transport => {
    const inner = webSocketTransport(() => {
      const socket = ticketSocket(remoteUrl, identity.fingerprint);
      lanSockets.add(socket);
      return socket as unknown as WebSocket;
    });
    return {
      ...inner,
      open(events) {
        if (!lanUp) events.close(1006, "Network unreachable");
        else inner.open(events);
      },
    };
  };
  const machines = machine.pool("phone", {
    now: () => Date.now() + skew,
    watchNetwork: (changed) => {
      networkChanged = changed;
      return () => {};
    },
    directRoute: (path, credential, paired) =>
      paired && path.url === lanUrl
        ? {
            transport: lanTransport,
            credential,
            probe: async () => {
              if (!lanUp) throw new Error("Network unreachable");
              return 1;
            },
          }
        : undefined,
  });
  // Paired earlier over the LAN; the daemon then said ace's relay knows it by its host key.
  await machines.add({
    identity: { hostId: HostId.parse("host"), displayName: "Office Mac", version: "1" },
    target: { kind: "direct", url: remoteUrl, fingerprint: identity.fingerprint },
    deviceId: "phone-paired",
    token: "e".repeat(64),
  });
  expect(machines.ids).toEqual(["host"]);
  const relayUrl = machine.relay.url.replace(/^ws:/, "wss:");
  await machines.directory.remember("host", {
    paths: [
      { kind: "lan", url: lanUrl, fingerprint: identity.fingerprint },
      { kind: "account", url: relayUrl, relayHostId: machine.hostId },
    ],
  });

  const opened = machines.openAccountMachine({ hostId: machine.hostId, name: "Office Mac" });
  // One machine from the start, before any connection proves it.
  expect(machines.ids).toEqual([machine.hostId]);
  await expect.poll(() => opened.get(), { timeout: 10_000 }).toEqual({ kind: "open" });
  const path = () => machines.machine(machine.hostId)?.path;
  await expect.poll(path, { timeout: 10_000 }).toBe("lan");
  expect(machines.ids).toEqual([machine.hostId]);

  // The LAN goes away: the machine stays one, now through ace's relay.
  lanUp = false;
  for (const socket of lanSockets) socket.close();
  await expect.poll(path, { timeout: 10_000 }).toBe("account");
  expect(machines.machine(machine.hostId)?.status).toBe("online");
  expect(machines.ids).toEqual([machine.hostId]);

  // The LAN is back: past the hold after a switch, a network change brings it back to the LAN.
  lanUp = true;
  skew += 70_000;
  networkChanged?.();
  await expect.poll(path, { timeout: 10_000 }).toBe("lan");
  expect(machines.ids).toEqual([machine.hostId]);
});

it("a turned-off machine's threads leave the inbox and come back when turned on", async () => {
  const machine = await accountMachine();
  const off: string[][] = [];
  const machines = machine.pool("phone", {
    off: { load: () => off.at(-1) ?? [], save: (ids) => void off.push([...ids]) },
  });
  const opened = machines.openAccountMachine({ hostId: machine.hostId, name: "Office Mac" });
  await expect.poll(() => opened.get(), { timeout: 10_000 }).toEqual({ kind: "open" });
  const threads = () => machines.threads.ids.map((key) => machines.threads.thread(key)?.thread.id);
  await expect.poll(threads, { timeout: 10_000 }).toContain(machine.f.thread.id);

  machines.turnOff(machine.hostId);
  expect(threads()).toEqual([]);
  // Still listed, quietly off, and never reconnecting on its own.
  expect(machines.ids).toEqual([machine.hostId]);
  expect(machines.machine(machine.hostId)?.status).toBe("off");
  expect(off.at(-1)).toContain(machine.hostId);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(machines.machine(machine.hostId)?.status).toBe("off");

  machines.turnOn(machine.hostId);
  await expect.poll(() => opened.get(), { timeout: 10_000 }).toEqual({ kind: "open" });
  await expect.poll(threads, { timeout: 10_000 }).toContain(machine.f.thread.id);
  expect(off.at(-1)).toEqual([]);
});

it("turning a machine off never unpairs it, and it stays off after a restart", async () => {
  const machine = await accountMachine();
  const kept: string[][] = [];
  const offStore = {
    load: () => kept.at(-1) ?? [],
    save: (ids: readonly string[]) => void kept.push([...ids]),
  };
  const machines = machine.pool("phone", { off: offStore });
  const paired = await machines.add({
    identity: { hostId: HostId.parse("host"), displayName: "Office Mac", version: "1" },
    target: { kind: "direct", url: "wss://192.168.1.4:7443/" },
    deviceId: "phone-paired",
    token: "e".repeat(64),
  });
  machines.turnOff("host");
  expect(machines.machine("host")?.status).toBe("off");
  // Its pairing is untouched: the entry and its credential stay.
  expect(machines.directory.machines.map((entry) => entry.hostId)).toEqual(["host"]);
  await expect(machines.directory.token(paired)).resolves.toBe("e".repeat(64));
  // The next start of the app finds it listed and still off.
  const again = machine.pool("phone", { off: offStore, directory: machines.directory });
  await again.start();
  expect(again.ids).toEqual(["host"]);
  expect(again.machine("host")?.status).toBe("off");
});

/** Pairs `installId` with this machine over its pairing endpoint. */
async function pairPhone(machine: Awaited<ReturnType<typeof accountMachine>>, installId: string) {
  const pairing = PairingResponse.parse(
    await accessRequest(machine.f.server.httpUrl, "/v1/pairings", {
      method: "POST",
      token,
      body: { scopes: ["read", "operate"] },
    }),
  );
  return DeviceCredential.parse(
    await accessRequest(machine.f.server.httpUrl, "/v1/pair", {
      method: "POST",
      body: { code: parsePairingLink(pairing.url).code, name: "Phone", installId },
    }),
  );
}

it("a command the pairing ran is answered from its receipt through the account only once the account hello proves the pairing", async () => {
  const machine = await accountMachine();
  const installId = "01936d1e-3f8a-7c2b-9d4e-5f6a7b8c9d0e";
  const paired = await pairPhone(machine, installId);
  // Run over the pairing; its receipt never came back before the route moved.
  for (const id of ["ran-on-lan", "ran-on-lan-2", "ran-on-lan-3"])
    machine.f.store.recordCommand(CommandId.parse(id), paired.device.id, () => ({
      commandId: CommandId.parse(id),
      ok: true,
    }));
  const replay = async (link: (() => Promise<PairingLinkProof>) | undefined, id: string) => {
    const client = await machine.device(installId, link).connect();
    expect(client.state).toBe("ready");
    await client.enqueue({ type: "thread.archive", threadId: machine.f.thread.id }, id);
    await expect
      .poll(() => client.intent(id).getSnapshot()?.result, { timeout: 10_000 })
      .toBeDefined();
    const result = client.intent(id).getSnapshot()?.result;
    await client.close();
    return result;
  };
  const proof = (secret: string) => () =>
    pairingLinkProof(secret, paired.device.id, DeviceId.parse(installId), crypto.subtle);

  // Naming the install, or a proof made without the pairing's credential, links nothing.
  expect(await replay(undefined, "ran-on-lan")).toMatchObject({ ok: false, error: "forbidden" });
  expect(await replay(proof("f".repeat(64)), "ran-on-lan-2")).toMatchObject({
    ok: false,
    error: "forbidden",
  });
  // The same install proving the pairing's credential is that device.
  expect(await replay(proof(paired.token), "ran-on-lan-3")).toMatchObject({
    commandId: "ran-on-lan-3",
    ok: true,
  });
});

it("pairing the install again leaves its account connection open", async () => {
  const machine = await accountMachine();
  const installId = "01936d1e-3f8a-7c2b-9d4e-5f6a7b8c9d0e";
  const first = await pairPhone(machine, installId);
  const account = await machine.device(installId).connect();
  expect(account.state).toBe("ready");
  const again = await pairPhone(machine, installId);
  expect(again.device.id).toBe(first.device.id);
  // Still open, and still answering.
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(account.state).toBe("ready");
  await account.enqueue({ type: "thread.archive", threadId: machine.f.thread.id }, "after-repair");
  await expect
    .poll(() => account.intent("after-repair").getSnapshot()?.result, { timeout: 10_000 })
    .toMatchObject({ ok: true });
});
