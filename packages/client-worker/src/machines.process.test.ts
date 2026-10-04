import { Worker } from "node:worker_threads";
import { afterEach, expect, test } from "vitest";
import { Client, ClientError, type Selection } from "@ace/client";
import {
  MachineDirectory,
  machineThreadKey,
  type MachineEntry,
  type PairedMachine,
} from "@ace/client/machines";
import { DeviceId, HostId, ThreadId, WorkspaceId } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { z } from "zod";
import { MachinePool, type MachineWorker } from "./machines.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
const scheduler = {
  set(ms: number, callback: () => void) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};
function wait<T>(selection: Selection<T>, predicate: (value: T) => boolean, ms = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error("Observable deadline exceeded"));
    }, ms);
    const check = () => {
      const value = selection.getSnapshot();
      if (predicate(value)) {
        clearTimeout(timer);
        stop();
        resolve(value);
      }
    };
    const stop = selection.subscribe(check);
    check();
  });
}
function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Independent machine stalled")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
function paired(hostId: string, name = hostId, token = "a".repeat(64)): PairedMachine {
  return {
    identity: { hostId: HostId.parse(hostId), displayName: name, version: "fake" },
    target: { kind: "direct", url: `ws://${hostId}.test/` },
    deviceId: "device",
    token,
  };
}
function persistence() {
  let raw: string | null = null;
  const tokens = new Map<string, string>();
  const storage = {
    load: async () => raw,
    save: async (value: string) => {
      raw = value;
    },
  };
  const secrets = {
    get: async (key: string) => tokens.get(key) ?? null,
    set: async (key: string, value: string) => {
      tokens.set(key, value);
    },
    delete: async (key: string) => {
      tokens.delete(key);
    },
  };
  return {
    directory: new MachineDirectory(storage, secrets),
    storage,
    secrets,
    tokens,
    raw: () => raw,
  };
}
function poolWorld() {
  const p = persistence();
  const workers = new Map<string, Worker>();
  let controlId = 0;
  const pool = new MachinePool({
    directory: p.directory,
    remote: { scheduler },
    spawn(entry: MachineEntry, token: string): MachineWorker {
      const worker = new Worker(new URL("./machines-worker.fixture.ts", import.meta.url), {
        workerData: { hostId: entry.hostId, name: entry.displayName, token },
        execArgv: [],
      });
      workers.set(entry.hostId, worker);
      cleanup.push(() => worker.terminate());
      const listeners = new Map<(event: { data: unknown }) => void, (data: unknown) => void>();
      return {
        onFailure(listener) {
          const failed = () => listener(new ClientError("daemon", "Worker stopped"));
          worker.on("error", failed);
          worker.on("exit", failed);
          return () => {
            worker.off("error", failed);
            worker.off("exit", failed);
          };
        },
        config: {},
        terminate() {
          void worker.terminate();
        },
        port: {
          postMessage(value) {
            // A Node worker is a dedicated channel and has no target origin.
            // oxlint-disable-next-line unicorn/require-post-message-target-origin
            worker.postMessage(value);
          },
          addEventListener(_type, listener) {
            const receive = (data: unknown) => listener({ data });
            listeners.set(listener, receive);
            worker.on("message", receive);
          },
          removeEventListener(_type, listener) {
            const receive = listeners.get(listener);
            if (receive) worker.off("message", receive);
            listeners.delete(listener);
          },
        },
      };
    },
  });
  cleanup.push(() => pool.close());
  return {
    ...p,
    pool,
    workers,
    async control(hostId: string, control: string) {
      const worker = workers.get(hostId);
      if (!worker) throw new Error("Missing worker");
      const id = ++controlId;
      const ack = new Promise<void>((resolve) => {
        const listener = (value: unknown) => {
          const parsed = z.object({ controlAck: z.number() }).safeParse(value);
          if (parsed.success && parsed.data.controlAck === id) {
            worker.off("message", listener);
            resolve();
          }
        };
        worker.on("message", listener);
      });
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      worker.postMessage({ control, id });
      await bounded(ack, 2000);
    },
  };
}
const ref = (hostId: string, threadId = "shared") => ({ hostId, threadId });
const key = (hostId: string, threadId = "shared") => machineThreadKey(ref(hostId, threadId));
const create = (id: string) => ({
  type: "thread.create" as const,
  threadId: ThreadId.parse(id),
  workspaceId: WorkspaceId.parse("project"),
  provider: "codex" as const,
  input: [{ type: "text" as const, text: "Synthetic" }],
});

test("three isolated hosts merge colliding thread IDs and route create, send, service reads and subscriptions", async () => {
  const f = poolWorld();
  await f.pool.start();
  for (const host of ["laptop", "desktop", "server"]) await f.pool.add(paired(host));
  for (const host of f.pool.ids)
    await wait(f.pool.status(host), (state) => state?.status === "online");
  await wait(
    f.pool.threads.select(["ids"], (store) => store.ids),
    (ids) => ids.length === 3,
  );
  expect(f.pool.threads.ids).toEqual([key("laptop"), key("desktop"), key("server")]);
  expect(f.pool.threads.thread(key("desktop"))?.machine.displayName).toBe("desktop");
  const result = await f.pool.create("desktop", create("new"));
  expect(result.ok).toBe(true);
  await wait(
    f.pool.threads.select(["ids"], (store) => store.ids),
    (ids) => ids.includes(key("desktop", "new")),
  );
  expect(f.pool.threads.thread(key("laptop", "new"))).toBeUndefined();
  const left = f.pool.thread(ref("laptop"));
  const right = f.pool.thread(ref("desktop"));
  cleanup.push(async () => {
    left.release();
    right.release();
  });
  await wait(
    left.store.select(["thread"], (store) => store.thread?.title),
    (title) => title === "laptop",
  );
  await wait(
    right.store.select(["thread"], (store) => store.thread?.title),
    (title) => title === "desktop",
  );
  expect(
    (
      await f.pool.command(ref("desktop"), {
        type: "thread.send",
        threadId: ThreadId.parse("shared"),
        input: [{ type: "text", text: "Only desktop" }],
      })
    ).ok,
  ).toBe(true);
  await wait(
    right.store.select(["order"], (store) => store.order.length),
    (length) => length > 0,
  );
  expect(left.store.order).toEqual([]);
  expect(
    (await f.pool.request(ref("server"), { type: "host.identity" })).identity.displayName,
  ).toBe("server");
  const accounts = await f.pool.client("server").request({ type: "accounts.list" });
  expect(accounts).toMatchObject({ accounts: [{ id: "server" }] });
  expect(() =>
    f.pool.command(ref("laptop"), {
      type: "thread.interrupt",
      threadId: ThreadId.parse("wrong"),
      cascade: true,
    }),
  ).toThrow("Thread routing mismatch");
  await f.pool.rename("desktop", "Office");
  expect(f.pool.threads.thread(key("desktop"))?.machine.displayName).toBe("Office");
  await f.pool.remove("desktop");
  expect(f.pool.threads.ids).toEqual([key("laptop"), key("server")]);
  expect(() => f.pool.client("desktop")).toThrow("offline");
});

test("a blocked worker and offline host cannot stall another machine; reconnect restores subscriptions", async () => {
  const f = poolWorld();
  await f.pool.add(paired("slow"));
  await f.pool.add(paired("fast"));
  for (const host of f.pool.ids)
    await wait(f.pool.status(host), (state) => state?.status === "online");
  await f.control("slow", "block");
  expect((await bounded(f.pool.create("fast", create("while-blocked")), 1000)).ok).toBe(true);
  await f.control("slow", "offline");
  await wait(f.pool.status("slow"), (state) => state?.status === "connecting");
  expect((await bounded(f.pool.create("fast", create("while-offline")), 1000)).ok).toBe(true);
  f.pool.networkOnline("slow", false);
  await wait(f.pool.status("slow"), (state) => state?.status === "offline");
  expect(f.pool.threads.thread(key("slow"))?.thread.status).toBeDefined();
  await f.control("slow", "online");
  f.pool.networkOnline("slow", true);
  await wait(f.pool.status("slow"), (state) => state?.status === "online");
  expect((await f.pool.create("slow", create("after-reconnect"))).ok).toBe(true);
  await wait(
    f.pool.threads.select(["ids"], (store) => store.ids),
    (ids) => ids.includes(key("slow", "after-reconnect")),
  );
});

test("authentication rejection affects only its machine", async () => {
  const f = poolWorld();
  await f.pool.add(paired("revoked", "revoked", "b".repeat(64)));
  await f.pool.add(paired("valid"));
  await wait(f.pool.status("revoked"), (state) => state?.status === "auth_failed");
  await wait(f.pool.status("valid"), (state) => state?.status === "online");
  expect(() => f.pool.client("revoked")).toThrow("auth");
  expect((await f.pool.create("valid", create("ok"))).ok).toBe(true);
});

test("directory round trip restores targets and names with tokens only in the secret store", async () => {
  const f = persistence();
  await f.directory.load();
  await f.directory.pair("pairing-link", async () => paired("laptop"));
  await f.directory.add({
    ...paired("server"),
    target: { kind: "relay", url: "wss://relay.test/", ticketReference: "relay-slot" },
  });
  await f.directory.rename("laptop", "Personal");
  expect(f.raw()).not.toContain("a".repeat(64));
  expect(f.raw()).not.toContain('"token"');
  expect(f.tokens.size).toBe(2);
  const restored = new MachineDirectory(f.storage, f.secrets);
  expect(await restored.load()).toEqual(f.directory.machines);
  const laptop = restored.machines[0];
  if (!laptop) throw new Error("Missing laptop");
  expect(await restored.token(laptop)).toBe("a".repeat(64));
  await restored.remove("laptop");
  expect(f.tokens.size).toBe(1);
  const again = new MachineDirectory(f.storage, f.secrets);
  expect((await again.load()).map((machine) => machine.hostId)).toEqual(["server"]);
});

test("a single pool machine exposes the existing client behaviour and incremental row changes", async () => {
  const f = poolWorld();
  await f.pool.add(paired("only"));
  await wait(f.pool.status("only"), (state) => state?.status === "online");
  await wait(
    f.pool.threads.select(["ids"], (store) => store.ids),
    (ids) => ids.length === 1,
  );
  const ids = f.pool.threads.ids;
  const count = f.pool.threads.count((row) => row.thread.archivedAt !== undefined);
  const counts: number[] = [];
  expect(count.getSnapshot()).toBe(0);
  const stopCount = count.subscribe(() => counts.push(count.getSnapshot()));
  cleanup.push(async () => stopCount());
  const changes: string[] = [];
  const stop = f.pool.threads.observeChanges((change) => changes.push(change.key));
  cleanup.push(async () => stop());
  expect(
    (
      await f.pool.command(ref("only"), {
        type: "thread.archive",
        threadId: ThreadId.parse("shared"),
      })
    ).ok,
  ).toBe(true);
  await wait(
    f.pool.threads.select(
      [`thread:${key("only")}`],
      (store) => store.thread(key("only"))?.thread.archivedAt,
    ),
    (at) => at !== undefined,
  );
  expect(f.pool.threads.ids).toBe(ids);
  expect(changes).toEqual([key("only")]);
  expect(count.getSnapshot()).toBe(1);
  await f.pool.rename("only", "Renamed");
  expect(counts).toEqual([1]);
  await f.pool.remove("only");
  expect(count.getSnapshot()).toBe(0);
  expect(counts).toEqual([1, 0]);
  const daemon = new FakeDaemon({ clock: () => 1000 });
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse("device"),
    credential: async () => daemon.token,
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    scheduler,
    random: () => 0,
    id: () => `single-${++sequence}`,
  });
  cleanup.push(() => client.close());
  await client.start();
  await wait(client.connectionState(), (state) => state === "ready");
  expect((await client.command(create("legacy"))).ok).toBe(true);
  const lease = client.thread("legacy");
  cleanup.push(async () => lease.release());
  await wait(
    lease.store.select(["thread"], (store) => store.thread?.id),
    (id) => id === "legacy",
  );
});

test("pool startup restores the directory without waiting on an unavailable secret store", async () => {
  const f = poolWorld();
  await f.directory.load();
  await f.directory.add(paired("locked"));
  await f.directory.add(paired("available", "Restored machine"));
  const get = f.secrets.get;
  let unlock: (() => void) | undefined;
  f.secrets.get = async (secretKey) => {
    if (secretKey.includes('"locked"'))
      await new Promise<void>((resolve) => {
        unlock = resolve;
      });
    return get(secretKey);
  };
  cleanup.push(async () => unlock?.());
  await bounded(f.pool.start(), 1000);
  await wait(f.pool.status("available"), (state) => state?.status === "online");
  expect(f.pool.machine("locked")?.status).toBe("connecting");
  expect((await f.pool.create("available", create("restored"))).ok).toBe(true);
  unlock?.();
  await wait(f.pool.status("locked"), (state) => state?.status === "online");
});

test("worker exit reports offline, preserves facts and reconnects only the affected host", async () => {
  const f = poolWorld();
  await f.pool.add(paired("crashed"));
  await f.pool.add(paired("healthy"));
  for (const host of f.pool.ids)
    await wait(f.pool.status(host), (state) => state?.status === "online");
  await wait(
    f.pool.threads.select(["ids"], (store) => store.ids),
    (ids) => ids.length === 2,
  );
  const cached = f.pool.threads.thread(key("crashed"));
  await f.workers.get("crashed")?.terminate();
  await wait(f.pool.status("crashed"), (state) => state?.status === "offline");
  expect(f.pool.threads.thread(key("crashed"))).toBe(cached);
  expect((await f.pool.create("healthy", create("unaffected"))).ok).toBe(true);
  f.pool.reconnect("crashed");
  await wait(f.pool.status("crashed"), (state) => state?.status === "online");
  expect((await f.pool.create("crashed", create("restarted"))).ok).toBe(true);
  await wait(
    f.pool.threads.select(["ids"], (store) => store.ids),
    (ids) => ids.includes(key("crashed", "restarted")),
  );
  expect(f.pool.ids).toEqual(["crashed", "healthy"]);
});

test("a pinned client rejects a different host before replaying persisted commands", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000, hostId: "unexpected" });
  const client = new Client({
    deviceId: DeviceId.parse("device"),
    expectedHostId: HostId.parse("expected"),
    credential: async () => daemon.token,
    transport: () => fakeTransport(daemon),
    storage: {
      load: async () =>
        JSON.stringify([
          {
            state: "pending",
            command: {
              id: "restored",
              deviceId: "device",
              payload: create("must-not-replay"),
            },
          },
        ]),
      save: async () => {},
    },
    scheduler,
    random: () => 0,
    id: () => "request",
  });
  cleanup.push(() => client.close());
  const lease = client.threads();
  cleanup.push(async () => lease.release());
  await client.start();
  await wait(client.connectionState(), (state) => state === "fatal");
  expect(client.error?.code).toBe("auth");
  expect(client.intent("restored").getSnapshot()?.state).toBe("pending");
  expect(
    daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("must-not-replay") }),
  ).toBeUndefined();
  expect(lease.store.loaded).toBe(false);
});
