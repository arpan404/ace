import { afterEach, expect, test } from "vitest";
import { ThreadId, WorkspaceId } from "@ace/protocol";
import {
  cleanup,
  poolWorld,
  paired,
  wait,
  ref,
  key,
  create,
  bounded,
} from "./machines-process.fixture.ts";

afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

test.each(["hold", "fail"] as const)(
  "worker recovery retains working facts and attention counts while its replacement snapshot %s",
  async (fault) => {
    const f = poolWorld();
    await f.pool.add(paired("recovering"));
    await f.pool.add(paired("healthy"));
    for (const hostId of f.pool.ids)
      await wait(f.pool.status(hostId), (state) => state?.status === "online");
    expect((await f.pool.create("recovering", create("working"))).ok).toBe(true);
    await wait(
      f.pool.threads.select(
        [`thread:${key("recovering", "working")}`],
        (store) => store.thread(key("recovering", "working"))?.thread.status.state,
      ),
      (state) => state === "working",
    );
    const count = f.pool.threads.count(
      (row) => row.hostId === "recovering" && row.thread.status.state === "working",
    );
    const values: number[] = [];
    const stop = count.subscribe(() => values.push(count.getSnapshot()));
    cleanup.push(async () => stop());
    const cached = f.pool.threads.thread(key("recovering", "working"));
    await f.workers.get("recovering")?.terminate();
    await wait(f.pool.status("recovering"), (state) => state?.status === "offline");
    f.sidebarFaults.set("recovering", fault);
    f.pool.reconnect("recovering");
    await wait(f.pool.status("recovering"), (state) => state?.status === "online");
    // A round trip through each worker gives the replacement time to process its sidebar lease.
    await f.pool.request(ref("recovering"), { type: "host.identity" });
    expect((await bounded(f.pool.create("healthy", create("unaffected")), 1000)).ok).toBe(true);
    expect(f.pool.threads.loaded("recovering")).toBe(false);
    expect(f.pool.threads.thread(key("recovering", "working"))).toBe(cached);
    expect(count.getSnapshot()).toBe(1);
    expect(values).toEqual([]);
    if (fault === "fail") {
      const lease = f.pool.client("recovering").threads();
      cleanup.push(async () => lease.release());
      await wait(
        lease.store.select(["error"], (store) => store.error?.code),
        (code) => code === "daemon",
      );
    }
    await f.control("recovering", "release-sidebar");
    if (fault === "fail") {
      f.pool.networkOnline("recovering", false);
      await wait(f.pool.status("recovering"), (state) => state?.status === "offline");
      f.pool.networkOnline("recovering", true);
      await wait(f.pool.status("recovering"), (state) => state?.status === "online");
    }
    await wait(
      f.pool.threads.select(["loaded:recovering"], (store) => store.loaded("recovering")),
      Boolean,
    );
    // This restarted fake has no old working thread. Only its authoritative snapshot removes it.
    expect(f.pool.threads.thread(key("recovering", "working"))).toBeUndefined();
    expect(count.getSnapshot()).toBe(0);
    expect(values).toEqual([0]);
  },
);

test("removal disables live and retained client access when secret deletion succeeds but metadata persistence fails", async () => {
  const f = poolWorld();
  await f.pool.add(paired("removed"));
  await f.pool.add(paired("healthy"));
  for (const hostId of f.pool.ids)
    await wait(f.pool.status(hostId), (state) => state?.status === "online");
  const client = f.pool.client("removed");
  const save = f.storage.save;
  const saving = Promise.withResolvers<void>();
  const releaseSave = Promise.withResolvers<void>();
  f.storage.save = async () => {
    saving.resolve();
    await releaseSave.promise;
    throw new Error("Disk unavailable");
  };
  cleanup.push(async () => releaseSave.resolve());
  const removal = f.pool.remove("removed");
  await saving.promise;
  expect(() => f.pool.client("removed")).toThrow("offline");
  expect(() => f.pool.reconnect("removed")).toThrow("Machine removal pending");
  await expect(client.command(create("during-removal"))).rejects.toThrow("offline");
  releaseSave.resolve();
  await expect(removal).rejects.toThrow();
  expect(f.tokens.size).toBe(1);
  expect(f.pool.machine("removed")).toMatchObject({
    status: "offline",
    error: { code: "storage" },
  });
  expect(f.pool.ids).toEqual(["removed", "healthy"]);
  expect(() => f.pool.create("removed", create("unauthorized"))).toThrow("offline");
  await expect(client.command(create("retained-handle"))).rejects.toThrow("offline");
  expect(() =>
    client.send({ type: "browser.close", requestId: "old", threadId: ThreadId.parse("shared") }),
  ).toThrow("offline");
  expect((await f.pool.create("healthy", create("allowed"))).ok).toBe(true);
  f.pool.reconnect("removed");
  await wait(f.pool.status("removed"), (state) => state?.status === "auth_failed");
  f.storage.save = save;
  await f.pool.remove("removed");
  expect(f.pool.ids).toEqual(["healthy"]);
  expect(f.directory.machines.map((entry) => entry.hostId)).toEqual(["healthy"]);
});

test("mismatched command, enqueue, request and one-way controls have no effects on either thread", async () => {
  const f = poolWorld();
  await f.pool.add(paired("host"));
  await wait(f.pool.status("host"), (state) => state?.status === "online");
  expect((await f.pool.create("host", create("other"))).ok).toBe(true);
  const client = f.pool.client("host");
  for (const threadId of ["shared", "other"]) {
    expect(
      await f.pool.request(ref("host", threadId), {
        type: "browser.open",
        options: {
          threadId: ThreadId.parse(threadId),
          workspaceId: WorkspaceId.parse("project"),
          profile: "ephemeral",
          headed: false,
        },
      }),
    ).toMatchObject({ ok: true });
  }
  const wrong = ThreadId.parse("other");
  const interrupt = { type: "thread.interrupt" as const, threadId: wrong, cascade: true };
  expect(() => f.pool.command(ref("host"), interrupt)).toThrow("Thread routing mismatch");
  expect(() => f.pool.enqueue(ref("host"), interrupt)).toThrow("Thread routing mismatch");
  expect(() => f.pool.request(ref("host"), { type: "browser.close", threadId: wrong })).toThrow(
    "Thread routing mismatch",
  );
  expect(() =>
    f.pool.request(ref("host"), {
      type: "browser.open",
      options: {
        threadId: wrong,
        workspaceId: WorkspaceId.parse("project"),
        profile: "ephemeral",
        headed: false,
      },
    }),
  ).toThrow("Thread routing mismatch");
  for (const message of [
    { type: "browser.close" as const, requestId: "close", threadId: wrong },
    { type: "browser.ack" as const, requestId: "ack", threadId: wrong, sequence: 0 },
    {
      type: "browser.input" as const,
      requestId: "input",
      threadId: wrong,
      input: { kind: "scroll" as const, x: 0, y: 0, deltaX: 1, deltaY: 1 },
    },
  ])
    expect(() => f.pool.send(ref("host"), message)).toThrow("Thread routing mismatch");
  // Successful snapshots prove neither open browser was closed by the rejected controls.
  for (const threadId of ["shared", "other"]) {
    expect(
      await f.pool.request(ref("host", threadId), {
        type: "browser.execute",
        threadId: ThreadId.parse(threadId),
        command: { action: "snapshot" },
      }),
    ).toMatchObject({ ok: true, result: { text: "Synthetic fixture page" } });
  }
  const closed = new Promise<void>((resolve) => {
    const stop = client.onMessage((message) => {
      if (message.type === "browser.result" && message.requestId === "correct-close") {
        stop();
        resolve();
      }
    });
    cleanup.push(async () => stop());
  });
  f.pool.send(ref("host", "other"), {
    type: "browser.close",
    requestId: "correct-close",
    threadId: wrong,
  });
  await bounded(closed, 2000);
  expect(
    await f.pool.request(ref("host", "other"), {
      type: "browser.execute",
      threadId: wrong,
      command: { action: "snapshot" },
    }),
  ).toMatchObject({ ok: false, error: "Browser closed" });
  expect(
    await f.pool.request(ref("host"), {
      type: "browser.execute",
      threadId: ThreadId.parse("shared"),
      command: { action: "snapshot" },
    }),
  ).toMatchObject({ ok: true });
  await f.pool.enqueue(
    ref("host", "other"),
    { type: "thread.archive", threadId: wrong },
    "routed-archive",
  );
  await wait(client.intent("routed-archive"), (intent) => intent?.state === "acked");
  await wait(
    f.pool.threads.select(
      [`thread:${key("host", "other")}`],
      (store) => store.thread(key("host", "other"))?.thread.archivedAt,
    ),
    (at) => at !== undefined,
  );
  expect(f.pool.threads.thread(key("host"))?.thread.archivedAt).toBeUndefined();
});
