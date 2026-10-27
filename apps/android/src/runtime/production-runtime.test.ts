import { afterEach, expect, it } from "vitest";
import { Client, type Storage } from "@ace/client";
import { MachineEntry } from "@ace/client/machines";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import type { ExpoPinnedBridge } from "../security/expo-bridge.ts";
import { createMemoryCredentialStore } from "../pairing/credentials.ts";
import { saveCredential } from "../pairing/credentials.ts";
import { ProductionTransportError } from "./machines-runtime.ts";
import { PinnedTransportError } from "../security/pinned-transport.ts";
import {
  createProductionCredential,
  createProductionMakeRuntime,
  namespaceFor,
} from "./production-runtime.ts";
import type { MachineRuntime } from "./machines-runtime.ts";

const PIN = "9f".repeat(32);
const TOKEN = "e0".repeat(32);
const TICKET = "f1".repeat(32);
const SOCKET_URL = "wss://192.168.1.20:4243/";
const HOST = "fake-host";

function entry(hostId = HOST, deviceId = "phone-1"): MachineEntry {
  return MachineEntry.parse({
    hostId,
    displayName: hostId,
    target: { kind: "direct", url: SOCKET_URL, fingerprint: PIN },
    deviceId,
  });
}

function memoryStorage(): Storage & { namespaces?: never } {
  const meta = new Map<string, string>();
  const records = new Map<string, string>();
  return {
    load: async () => meta.get("legacy") ?? null,
    save: async (value) => {
      meta.set("legacy", value);
    },
    hostBinding: {
      load: async () => meta.get("host") ?? null,
      save: async (value) => {
        meta.set("host", value);
      },
    },
    records: {
      load: async () => [...records.values()],
      write: async (id, value) => {
        if (value === null) records.delete(id);
        else records.set(id, value);
      },
    },
  };
}

function ticketBridge(seen: string[]): ExpoPinnedBridge {
  return {
    pinnedFetch: async (input) => {
      if (input.path !== "/v1/tickets") return { status: 404, body: "{}" };
      if (input.token !== undefined) seen.push(input.token);
      return {
        status: 200,
        body: JSON.stringify({ ticket: TICKET, expiresAt: Date.now() + 60_000 }),
      };
    },
    pinnedSocketOpen: () => {},
    pinnedSocketSend: () => {},
    pinnedSocketClose: () => {},
    addSocketListener: () => () => {},
  };
}

/** A daemon that accepts the stubbed single-use ticket instead of a token. */
class TicketDaemon extends FakeDaemon {
  override accepts(credential: { token?: string | undefined; ticket?: string | undefined }) {
    return credential.ticket === TICKET;
  }
}

const runtimes: MachineRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0).toReversed()) await runtime.close();
});

async function until(done: () => boolean): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (done()) return;
    if (Date.now() - started > 15_000) throw new Error("Timed out waiting for the client.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

it("scopes the outbox namespace by host and device identity", () => {
  expect(namespaceFor(entry("host-a", "phone-1"))).not.toBe(
    namespaceFor(entry("host-a", "phone-2")),
  );
  expect(namespaceFor(entry("host-a", "phone-1"))).not.toBe(
    namespaceFor(entry("host-b", "phone-1")),
  );
  expect(namespaceFor(entry("host-a", "phone-1"))).toBe(namespaceFor(entry("host-a", "phone-1")));
  expect(namespaceFor(entry("ab", "c"))).not.toBe(namespaceFor(entry("a", "bc")));
  // NUL-free for sqlite3_bind_text: an embedded NUL would truncate the
  // comparison and alias two machines onto one namespace.
  for (const scope of [namespaceFor(entry("host-a", "phone-1")), namespaceFor(entry("ab", "c"))]) {
    expect(scope).not.toContain("\0");
  }
  expect(namespaceFor({ hostId: "a\0b", deviceId: "c" })).not.toBe(
    namespaceFor({ hostId: "a", deviceId: "b\0c" }),
  );
  expect(namespaceFor({ hostId: "a\0b", deviceId: "c" })).not.toContain("\0");
});

it("rejects relay targets and malformed pins before touching the network", () => {
  const seen: string[] = [];
  const credentials = createMemoryCredentialStore();
  const deps = {
    bridge: ticketBridge(seen),
    credentials,
    storageFor: () => memoryStorage(),
  };
  const makeRuntime = createProductionMakeRuntime(deps);
  const relay = MachineEntry.parse({
    hostId: HOST,
    displayName: HOST,
    target: { kind: "relay", url: SOCKET_URL, ticketReference: "ref" },
    deviceId: "phone-1",
  });
  expect(() => makeRuntime(relay)).toThrow(ProductionTransportError);
  const unpinned = MachineEntry.parse({
    hostId: HOST,
    displayName: HOST,
    target: { kind: "direct", url: SOCKET_URL },
    deviceId: "phone-1",
  });
  expect(() => makeRuntime(unpinned)).toThrowError(PinnedTransportError);
  expect(seen).toHaveLength(0);
});

it("exchanges a fresh ticket on every attempt and re-reads the token", async () => {
  const seen: string[] = [];
  const credentials = createMemoryCredentialStore();
  const same = entry();
  await saveCredential(credentials, same, TOKEN);
  const credential = createProductionCredential({ bridge: ticketBridge(seen), credentials }, same);
  await expect(credential()).resolves.toEqual({ ticket: TICKET });
  await expect(credential()).resolves.toEqual({ ticket: TICKET });
  expect(seen).toEqual([TOKEN, TOKEN]);
  await saveCredential(credentials, same, "d2".repeat(32));
  await expect(credential()).resolves.toEqual({ ticket: TICKET });
  expect(seen).toEqual([TOKEN, TOKEN, "d2".repeat(32)]);
});

it("surfaces a missing token as an authentication failure for pairing routing", async () => {
  const seen: string[] = [];
  const credentials = createMemoryCredentialStore();
  const credential = createProductionCredential(
    { bridge: ticketBridge(seen), credentials },
    entry(),
  );
  await expect(credential()).rejects.toMatchObject({ code: "auth" });
  expect(seen).toHaveLength(0);
});

it("reports a ticket pin refusal to trust while surfacing auth for routing", async () => {
  const credentials = createMemoryCredentialStore();
  const same = entry();
  await saveCredential(credentials, same, TOKEN);
  const pinBridge: ExpoPinnedBridge = {
    pinnedFetch: async () => {
      throw new Error("pin");
    },
    pinnedSocketOpen: () => {},
    pinnedSocketSend: () => {},
    pinnedSocketClose: () => {},
    addSocketListener: () => () => {},
  };
  const { TrustMonitor } = await import("../security/pinned-transport.ts");
  const trust = new TrustMonitor();
  const credential = createProductionCredential({ bridge: pinBridge, credentials }, same, trust);
  await expect(credential()).rejects.toMatchObject({ code: "auth" });
  expect(trust.failure).toBe("pin");
});

it("connects one isolated runtime per machine over fresh tickets", async () => {
  const seen: string[] = [];
  const credentials = createMemoryCredentialStore();
  const daemon = new TicketDaemon({ clock: Date.now, hostId: HOST, token: "unused" });
  const first = entry(HOST, "phone-1");
  const second = entry(HOST, "phone-2");
  await saveCredential(credentials, first, TOKEN);
  await saveCredential(credentials, second, TOKEN);
  const namespaces: string[] = [];
  const observed = new Map<string, Client>();
  const makeRuntime = createProductionMakeRuntime({
    bridge: ticketBridge(seen),
    credentials,
    storageFor: (candidate) => {
      namespaces.push(namespaceFor(candidate));
      return memoryStorage();
    },
    transportFor: () => fakeTransport(daemon),
    observe: (candidate, client) => {
      observed.set(candidate.deviceId, client);
    },
  });
  const one = makeRuntime(first);
  const two = makeRuntime(second);
  runtimes.push(one, two);
  await one.start();
  await two.start();
  await until(
    () =>
      observed.get("phone-1")?.connectionState().getSnapshot() === "ready" &&
      observed.get("phone-2")?.connectionState().getSnapshot() === "ready",
  );
  // One ticket exchange per connection, each carrying the device token.
  expect(seen).toEqual([TOKEN, TOKEN]);
  // Namespaces isolate the two outboxes.
  expect(namespaces).toEqual([namespaceFor(first), namespaceFor(second)]);
  expect(new Set(namespaces).size).toBe(2);
});

it("fails a runtime whose daemon answers with another host identity", async () => {
  const seen: string[] = [];
  const credentials = createMemoryCredentialStore();
  const daemon = new TicketDaemon({ clock: Date.now, hostId: HOST, token: "unused" });
  const wrong = entry("other-host", "phone-1");
  await saveCredential(credentials, wrong, TOKEN);
  let observed: Client | undefined;
  const makeRuntime = createProductionMakeRuntime({
    bridge: ticketBridge(seen),
    credentials,
    storageFor: () => memoryStorage(),
    transportFor: () => fakeTransport(daemon),
    observe: (_entry, client) => {
      observed = client;
    },
  });
  const runtime = makeRuntime(wrong);
  runtimes.push(runtime);
  await runtime.start();
  await until(() => observed?.connectionState().getSnapshot() === "fatal");
  expect(observed?.error?.code).toBe("identity");
});

it("close during a hanging ticket exchange stops retries", async () => {
  // The native bridge cannot cancel an in-flight ticket request: abort only
  // stops waiting, and the shared `accessHttp` maps it to `offline`, which
  // the SDK would retry with backoff. `Client.close` must still settle that
  // machine for good: the epoch guard drops the late credential and the
  // closed flag blocks reconnect and wake.
  const seen: string[] = [];
  const credentials = createMemoryCredentialStore();
  const same = entry();
  await saveCredential(credentials, same, TOKEN);
  const hanging: ExpoPinnedBridge = {
    pinnedFetch: async (input) => {
      if (input.token !== undefined) seen.push(input.token);
      return new Promise<{ status: number; body: string }>(() => {});
    },
    pinnedSocketOpen: () => {},
    pinnedSocketSend: () => {},
    pinnedSocketClose: () => {},
    addSocketListener: () => () => {},
  };
  const timers = new Set<() => void>();
  const scheduler = {
    set: (_delayMs: number, callback: () => void) => {
      timers.add(callback);
      return () => {
        timers.delete(callback);
      };
    },
  };
  let opened = 0;
  let observed: Client | undefined;
  const makeRuntime = createProductionMakeRuntime({
    bridge: hanging,
    credentials,
    storageFor: () => memoryStorage(),
    scheduler,
    transportFor: () => ({
      open: (events) => {
        opened += 1;
        // Opening triggers the credential exchange, which hangs above.
        events.open();
      },
      send: () => {},
      close: () => {},
    }),
    observe: (_entry, client) => {
      observed = client;
    },
  });
  const runtime = makeRuntime(same);
  runtimes.push(runtime);
  await runtime.start();
  // Let the open event reach the credential exchange.
  for (let flush = 0; flush < 10; flush++) await Promise.resolve();
  expect(opened).toBe(1);
  expect(seen).toEqual([TOKEN]);
  expect(observed?.connectionState().getSnapshot()).toBe("connecting");

  await runtime.close();
  // The handshake timer is cancelled: nothing left can fire a retry.
  expect(timers.size).toBe(0);
  expect(observed?.connectionState().getSnapshot()).toBe("offline");
  // Wake and reconnect-now after close are no-ops, not retries.
  runtime.wake?.();
  runtime.reconnectNow();
  for (let flush = 0; flush < 10; flush++) await Promise.resolve();
  expect(timers.size).toBe(0);
  expect(opened).toBe(1);
  expect(seen).toEqual([TOKEN]);
  expect(observed?.connectionState().getSnapshot()).toBe("offline");
});

it("binds the manager epoch so stale callbacks stop after replacement", () => {
  const credentials = createMemoryCredentialStore();
  const captured: { isCurrent: () => boolean }[] = [];
  const makeRuntime = createProductionMakeRuntime({
    bridge: ticketBridge([]),
    credentials,
    storageFor: () => memoryStorage(),
    transportFor: (_entry, context) => {
      captured.push({ isCurrent: context.isCurrent });
      return { open: () => {}, send: () => {}, close: () => {} };
    },
    epochs: {
      isCurrent: (hostId, epoch) => hostId === HOST && epoch === 1,
      epochOf: (hostId) => (hostId === HOST ? 1 : undefined),
    },
  });
  const runtime = makeRuntime(entry());
  expect(captured).toHaveLength(1);
  // Before the manager binds the epoch, events flow (standalone use).
  expect(captured[0]?.isCurrent()).toBe(true);
  runtime.bindEpoch(1);
  expect(captured[0]?.isCurrent()).toBe(true);
  runtime.bindEpoch(2);
  expect(captured[0]?.isCurrent()).toBe(false);
});

it("opens and closes the pinned socket through the bridge", async () => {
  const credentials = createMemoryCredentialStore();
  const same = entry();
  await saveCredential(credentials, same, TOKEN);
  const opened: { id: string; url: string; fingerprint: string }[] = [];
  const closed: string[] = [];
  let next = 0;
  // Observe the default transport path by swapping the bridge module only.
  const recording: ExpoPinnedBridge = {
    pinnedFetch: async () => ({ status: 200, body: "{}" }),
    pinnedSocketOpen: (id, url, fingerprint) => {
      opened.push({ id, url, fingerprint });
    },
    pinnedSocketSend: () => {},
    pinnedSocketClose: (id) => {
      closed.push(id);
    },
    addSocketListener: () => () => {},
  };
  const wired = createProductionMakeRuntime({
    bridge: recording,
    credentials,
    storageFor: () => memoryStorage(),
    scheduler: { set: () => () => {} },
    socketId: () => `socket-${(next += 1)}`,
  });
  const runtime = wired(same);
  runtimes.push(runtime);
  await runtime.start();
  expect(opened).toEqual([{ id: "socket-1", url: SOCKET_URL, fingerprint: PIN }]);
  await runtime.close();
  expect(closed).toEqual(["socket-1"]);
});
