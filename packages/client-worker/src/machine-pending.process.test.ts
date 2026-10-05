import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { cleanup, poolWorld, paired, wait, ref, create } from "./machines-process.fixture.ts";

const send = (text: string) => ({
  type: "thread.send" as const,
  threadId: ThreadId.parse("shared"),
  delivery: "queue" as const,
  input: [{ type: "text" as const, text }],
});
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

async function world() {
  const outboxRoot = await mkdtemp(join(tmpdir(), "ace-machine-pending-"));
  cleanup.push(() => rm(outboxRoot, { recursive: true, force: true }));
  const f = poolWorld({ outboxRoot });
  for (const host of ["laptop", "desktop"]) await f.pool.add(paired(host));
  for (const host of f.pool.ids)
    await wait(f.pool.status(host), (state) => state?.status === "online");
  return f;
}

test("offline machine sends keep their drafts and waiters isolated until that machine reconnects", async () => {
  const f = await world();
  const laptop = f.pool.client("laptop");
  const desktop = f.pool.client("desktop");
  const left = laptop.pendingSends("shared");
  const right = desktop.pendingSends("shared");
  f.pool.networkOnline("laptop", false);
  f.pool.networkOnline("desktop", false);
  for (const host of f.pool.ids)
    await wait(f.pool.status(host), (state) => state?.status === "offline");
  const queued = f.pool.enqueue(ref("laptop"), send("Laptop draft"), "same-command");
  expect(left.getSnapshot()).toMatchObject([
    { commandId: "same-command", itemId: "input:same-command", state: "saving" },
  ]);
  expect(right.getSnapshot()).toEqual([]);
  const answered = f.pool.command(ref("desktop"), send("Desktop draft"), {}, "same-command");
  const created = f.pool.create("laptop", create("offline-created"), {}, "create-command");
  expect(right.getSnapshot()).toMatchObject([
    { commandId: "same-command", state: "saving", payload: { input: [{ text: "Desktop draft" }] } },
  ]);
  expect(laptop.pendingSends("pending:create-command").getSnapshot()).toMatchObject([
    { commandId: "create-command", itemId: "input:create-command", state: "saving" },
  ]);
  await queued;
  await wait(left, (entries) => entries[0]?.state === "sent");
  await wait(right, (entries) => entries[0]?.state === "sent");
  let received = false;
  void answered.then(() => {
    received = true;
  });
  f.pool.networkOnline("laptop", true);
  await wait(f.pool.status("laptop"), (state) => state?.status === "online");
  expect(await created).toMatchObject({ ok: true, threadId: "offline-created" });
  await wait(left, (entries) => entries[0]?.state === "accepted");
  expect(received).toBe(false);
  expect(right.getSnapshot()[0]?.state).toBe("sent");
  f.pool.networkOnline("desktop", true);
  expect(await answered).toMatchObject({ ok: true });
  await wait(f.pool.status("desktop"), (state) => state?.status === "online");
  const a = f.pool.thread(ref("laptop"));
  const b = f.pool.thread(ref("desktop"));
  cleanup.push(async () => {
    a.release();
    b.release();
  });
  await wait(left, (entries) => entries[0]?.state === "delivered");
  await wait(right, (entries) => entries[0]?.state === "delivered");
  expect(a.store.item("input:same-command")).toMatchObject({ parts: [{ text: "Laptop draft" }] });
  expect(b.store.item("input:same-command")).toMatchObject({ parts: [{ text: "Desktop draft" }] });
});

test("replacement workers replay every record only to its machine even when command ids collide", async () => {
  const f = await world();
  const desktop = f.pool.client("desktop").pendingSends("shared");
  for (const host of f.pool.ids) f.pool.networkOnline(host, false);
  for (const host of f.pool.ids)
    await wait(f.pool.status(host), (state) => state?.status === "offline");
  await f.pool.enqueue(ref("laptop"), send("First laptop draft"), "same-command");
  await f.pool.enqueue(ref("laptop"), send("Second laptop draft"), "second-command");
  await f.pool.enqueue(ref("desktop"), send("Only desktop draft"), "same-command");
  await wait(desktop, (entries) => entries[0]?.state === "sent");
  f.pool.reconnect("laptop");
  await wait(f.pool.status("laptop"), (state) => state?.status === "online");
  const left = f.pool.thread(ref("laptop"));
  cleanup.push(async () => left.release());
  await wait(
    left.store.select(["order"], (store) => store.order.length),
    (length) => length === 2,
  );
  expect(left.store.order).toEqual(["input:same-command", "input:second-command"]);
  expect(left.store.item("input:same-command")).toMatchObject({
    parts: [{ text: "First laptop draft" }],
  });
  expect(left.store.item("input:second-command")).toMatchObject({
    parts: [{ text: "Second laptop draft" }],
  });
  expect(desktop.getSnapshot()).toMatchObject([
    { state: "sent", payload: { input: [{ text: "Only desktop draft" }] } },
  ]);
  f.pool.reconnect("desktop");
  await wait(f.pool.status("desktop"), (state) => state?.status === "online");
  const right = f.pool.thread(ref("desktop"));
  cleanup.push(async () => right.release());
  await wait(
    right.store.select(["order"], (store) => store.order.length),
    (length) => length === 1,
  );
  expect(right.store.item("input:same-command")).toMatchObject({
    parts: [{ text: "Only desktop draft" }],
  });
  expect(right.store.item("input:second-command")).toBeUndefined();
});
