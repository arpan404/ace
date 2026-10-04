import { afterEach, expect, test } from "vitest";
import { Client } from "@ace/client";
import { MachineDirectory } from "@ace/client/machines";
import { DeviceId, HostId, ThreadId } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import {
  cleanup,
  scheduler,
  wait,
  bounded,
  paired,
  persistence,
  poolWorld,
  ref,
  key,
  create,
} from "./machines-process.fixture.ts";

afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
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
  const memberships: boolean[] = [];
  const stopMembership = f.pool.threads.observeChanges((change) => {
    if (change.key === key("desktop", "new"))
      memberships.push(f.pool.threads.ids.includes(change.key));
  });
  cleanup.push(async () => stopMembership());
  const result = await f.pool.create("desktop", create("new"));
  expect(result.ok).toBe(true);
  await wait(
    f.pool.threads.select(["ids"], (store) => store.ids),
    (ids) => ids.includes(key("desktop", "new")),
  );
  expect(f.pool.threads.thread(key("laptop", "new"))).toBeUndefined();
  expect(memberships).toEqual([true]);
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
  expect((await f.pool.create("slow", create("still-running"))).ok).toBe(true);
  await wait(
    f.pool.threads.select(
      [`thread:${key("slow", "still-running")}`],
      (store) => store.thread(key("slow", "still-running"))?.thread.status.state,
    ),
    (state) => state === "working",
  );
  await f.control("slow", "block");
  expect((await bounded(f.pool.create("fast", create("while-blocked")), 1000)).ok).toBe(true);
  await f.control("slow", "offline");
  await wait(f.pool.status("slow"), (state) => state?.status === "connecting");
  expect((await bounded(f.pool.create("fast", create("while-offline")), 1000)).ok).toBe(true);
  f.pool.networkOnline("slow", false);
  await wait(f.pool.status("slow"), (state) => state?.status === "offline");
  expect(f.pool.threads.thread(key("slow", "still-running"))?.thread.status).toMatchObject({
    state: "working",
  });
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
