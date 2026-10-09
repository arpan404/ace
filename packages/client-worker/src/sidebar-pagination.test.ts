import { afterEach, expect, test, vi } from "vitest";
import { ThreadId } from "@ace/protocol";
import { cleanups, world } from "./worker-test-support.ts";
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
test("worker bootstrap and Show more fetch bounded server pages; unlisted selection loads directly", async () => {
  const { daemon, tab, faults } = world();
  const remote = tab();
  await remote.start();
  await vi.waitFor(() => expect(remote.state).toBe("ready"));
  for (let i = 0; i < 45; i++) {
    const id = `settled-${i}`;
    daemon.createThread({ id, workspaceId: "repo", title: `Settled ${i}`, provider: "codex" });
    daemon.updateThread(id, { status: { state: "done" } });
    await remote.command({ type: "thread.settle", threadId: ThreadId.parse(id) });
  }
  daemon.createThread({ id: "active", workspaceId: "repo", title: "Active", provider: "codex" });
  const lease = remote.threads();
  cleanups.push(lease.release);
  await vi.waitFor(() => expect(lease.store.ids).toHaveLength(21));
  const initial = await faults.wait(
    (message) => message.type === "snapshot" && message.view.kind === "threads",
  );
  if (initial.type !== "snapshot" || initial.view.kind !== "threads")
    throw new Error("Missing bootstrap");
  expect(Object.keys(initial.view.threads)).toHaveLength(21);
  expect(initial.view.window?.total).toBe(45);
  expect(lease.store.window?.before).not.toBeNull();
  const hidden = "settled-0";
  expect(lease.store.thread(hidden)).toBeUndefined();
  const selected = remote.thread(hidden);
  cleanups.push(selected.release);
  await vi.waitFor(() => expect(selected.store.thread?.title).toBe("Settled 0"));
  expect(lease.store.ids).toHaveLength(21);
  await remote.threadsMore();
  await vi.waitFor(() => expect(lease.store.ids).toHaveLength(41));
  const page = await faults.wait(
    (message) => message.type === "threads.patch" && !!message.requestId,
  );
  if (page.type !== "threads.patch") throw new Error("Missing page");
  expect(Object.keys(page.threads)).toHaveLength(20);
  await remote.threadsMore();
  await vi.waitFor(() => expect(lease.store.ids).toHaveLength(46));
  expect(lease.store.window?.before).toBeNull();
  await remote.threadsWindow({ project: "missing" });
  await vi.waitFor(() => expect(lease.store.loaded && lease.store.ids.length === 0).toBe(true));
});

test("archive has its own bounded window while Home stays live, and leaving archive releases its history", async () => {
  const { daemon, tab } = world();
  for (let i = 0; i < 45; i++) {
    const id = `archived-${i}`;
    daemon.createThread({ id, workspaceId: "repo", title: `Archived ${i}`, provider: "codex" });
    daemon.updateThread(id, { status: { state: "done" }, archivedAt: 100 + i });
  }
  daemon.createThread({ id: "active", workspaceId: "repo", title: "Active", provider: "codex" });
  const remote = tab();
  await remote.start();
  await vi.waitFor(() => expect(remote.state).toBe("ready"));
  const lease = remote.threads();
  cleanups.push(lease.release);
  await vi.waitFor(() => expect(lease.store.ids).toEqual(["active"]));
  await remote.threadsWindow({ archived: true });
  await vi.waitFor(() => expect(lease.store.ids).toHaveLength(21));
  expect(lease.store.homeWindow?.total).toBe(0);
  expect(lease.store.window?.total).toBe(45);
  await remote.threadsMore();
  await vi.waitFor(() => expect(lease.store.ids).toHaveLength(41));
  daemon.updateThread("active", { title: "Home still live" });
  await vi.waitFor(() => expect(lease.store.thread("active")?.title).toBe("Home still live"));
  await remote.threadsWindow({});
  await vi.waitFor(() => expect(lease.store.ids).toEqual(["active"]));
  expect(lease.store.window?.before).toBeNull();
});

test("duplicate initial Home and Archive snapshots do not discard expanded pages; reconnect accepts fresh snapshots", async () => {
  const { daemon, tab, faults } = world();
  const snapshots: { text: string; deliver(text: string): void }[] = [];
  faults.incoming = (message, text, deliver) => {
    if (message.type === "snapshot" && message.view.kind === "threads")
      snapshots.push({ text, deliver });
    deliver(text);
  };
  const remote = tab();
  await remote.start();
  await vi.waitFor(() => expect(remote.state).toBe("ready"));
  for (let i = 0; i < 45; i++) {
    const id = `done-${i}`;
    daemon.createThread({ id, workspaceId: "repo", title: `Done ${i}`, provider: "codex" });
    daemon.updateThread(id, { status: { state: "done" } });
    await remote.command({ type: "thread.settle", threadId: ThreadId.parse(id) });
    const archived = `archive-${i}`;
    daemon.createThread({
      id: archived,
      workspaceId: "repo",
      title: `Archive ${i}`,
      provider: "codex",
    });
    daemon.updateThread(archived, { status: { state: "done" }, archivedAt: 100 + i });
  }
  const lease = remote.threads();
  cleanups.push(lease.release);
  await vi.waitFor(() => expect(lease.store.ids).toHaveLength(20));
  await remote.threadsMore();
  await vi.waitFor(() => expect(lease.store.ids).toHaveLength(40));
  const home = snapshots[0];
  if (!home) throw new Error("Missing Home snapshot");
  home.deliver(home.text);
  await remote.request({ type: "diagnostics.health" });
  expect(lease.store.ids).toHaveLength(40);
  await remote.threadsWindow({ archived: true });
  await vi.waitFor(() => expect(lease.store.ids).toHaveLength(60));
  await remote.threadsMore();
  await vi.waitFor(() => expect(lease.store.ids).toHaveLength(80));
  const archive = snapshots[1];
  if (!archive) throw new Error("Missing Archive snapshot");
  archive.deliver(archive.text);
  await remote.request({ type: "diagnostics.health" });
  expect(lease.store.ids).toHaveLength(80);
  daemon.disconnectAll();
  await vi.waitFor(() => expect(remote.state).not.toBe("ready"));
  await expect(remote.threadsMore()).rejects.toMatchObject({ code: "offline" });
  remote.networkOnline(false);
  remote.networkOnline(true);
  await vi.waitFor(() => expect(remote.state).toBe("ready"));
  await vi.waitFor(() => expect(lease.store.ids).toHaveLength(40));
  expect(lease.store.homeWindow?.total).toBe(45);
  expect(lease.store.window?.total).toBe(45);
});
