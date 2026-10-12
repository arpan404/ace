import { access, readFile, writeFile, unlink, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Thread, ThreadId } from "@ace/protocol";
import { StorageService } from "./service.ts";
import { git, worktreeFixture } from "./worktree-test-support.ts";

const fixtures: Awaited<ReturnType<typeof worktreeFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function setup() {
  const f = await worktreeFixture();
  fixtures.push(f);
  return f;
}
const request = { op: "cleanup.plan", kinds: ["worktrees"], forceItems: [] } satisfies Parameters<
  StorageService["plan"]
>[1];

test("unmanaged linked checkouts outside and inside the managed root never become removable", async () => {
  const f = await setup();
  const outside = join(f.root, "handmade"),
    inside = join(f.root, "worktrees", "handmade");
  await git(f.repo, "worktree", "add", "-b", "handmade-outside", outside, "main");
  await git(f.repo, "worktree", "add", "-b", "handmade-inside", inside, "main");
  const plan = await f.storage.plan("owner", request);
  expect(plan.items.map((item) => item.label)).toEqual([f.path]);
  expect(plan.items[0]?.disposition).toBe("remove");
  await f.storage.apply("owner", plan.id, plan.revision);
  await expect(access(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(outside, "file.txt"), "utf8")).toBe("original\n");
  expect(await readFile(join(inside, "file.txt"), "utf8")).toBe("original\n");
});

test("a replacement at a managed path cannot inherit the original cleanup authority", async () => {
  const f = await setup();
  const plan = await f.storage.plan("owner", request);
  await rename(f.path, `${f.path}-old`);
  await mkdir(f.path);
  await writeFile(join(f.path, "keep"), "new owner's data");
  expect((await f.storage.apply("owner", plan.id, plan.revision)).state).toBe("stale");
  expect(await readFile(join(f.path, "keep"), "utf8")).toBe("new owner's data");
});

test("root admission is already fenced when a new owner arrives during final Git inspection", async () => {
  const f = await setup();
  const plan = await f.storage.plan("owner", request);
  let admission = "never attempted";
  f.edge.inspectWhen = () => f.store.workspaceReservations.reserved(f.path);
  f.edge.duringInspection = async () => {
    // Public workspace admission fails before a session can be created.
    try {
      f.store.workspaceReservations.assertAvailable(f.path);
      admission = "accepted";
    } catch (error) {
      admission = error instanceof Error ? error.message : "unknown";
    }
    // Even durable ownership written by an older/in-flight admission is re-read under the fence.
    const workspace = f.store.createWorkspace(f.path, "New checkout owner", 2);
    const thread = Thread.parse({
      id: "new-owner",
      workspaceId: workspace,
      title: "Live",
      provider: "codex",
      status: { state: "new" },
      createdAt: 2,
      updatedAt: 2,
    });
    f.store.appendEvents(thread.id, [{ type: "thread.created", thread }], 2);
  };
  const result = await f.storage.apply("owner", plan.id, plan.revision);
  expect(admission).toBe("workspace_change_in_progress");
  expect(result.items).toMatchObject([{ state: "protected", reason: "live_thread" }]);
  expect(await readFile(join(f.path, "file.txt"), "utf8")).toBe("original\n");
  expect(f.store.executionWorkspace(ThreadId.parse("new-owner")).path).toBe(f.path);
});

test("workspace owners without an engine session protect a retained managed worktree", async () => {
  const f = await setup();
  const workspace = f.store.createWorkspace(f.path, "Live project", 2);
  const thread = Thread.parse({
    id: "local-owner",
    workspaceId: workspace,
    title: "Live",
    provider: "codex",
    status: { state: "done" },
    createdAt: 2,
    updatedAt: 2,
  });
  f.store.appendEvents(thread.id, [{ type: "thread.created", thread }], 2);
  const plan = await f.storage.plan("owner", request);
  expect(plan.items).toMatchObject([{ disposition: "protect", reasons: ["live_thread"] }]);
  await f.storage.apply("owner", plan.id, plan.revision);
  await access(f.path);
});

test("a definitive final Git refusal releases admission and stays protected across recovery", async () => {
  const f = await setup();
  const dirty = join(f.path, "untracked");
  await writeFile(dirty, "reviewed dirty bytes");
  const preview = await f.storage.plan("owner", request);
  const item = preview.items[0];
  if (!item) throw new Error("Missing worktree preview");
  const plan = await f.storage.plan("owner", { ...request, forceItems: [item.id] });
  expect(plan.items[0]?.disposition).toBe("remove");
  f.edge.beforeCleanup = () => writeFile(dirty, "changed after final daemon inspection");
  const result = await f.storage.apply("owner", plan.id, plan.revision);
  expect(result).toMatchObject({
    state: "complete",
    items: [{ state: "protected", reason: "changed" }],
  });
  expect(await readFile(dirty, "utf8")).toBe("changed after final daemon inspection");
  expect(() => f.store.workspaceReservations.assertAvailable(f.path)).not.toThrow();
  await f.storage.close();
  const restarted = new StorageService({
    root: f.root,
    store: f.store,
    services: f.services,
    now: f.now,
    id: () => "after-refusal",
  });
  try {
    await restarted.resume();
    expect(restarted.status("owner", plan.id).items).toMatchObject([{ state: "protected" }]);
    expect(() => f.store.workspaceReservations.assertAvailable(f.path)).not.toThrow();
    await unlink(dirty);
    const fresh = await restarted.plan("owner", request);
    expect(fresh.items[0]?.disposition).toBe("remove");
    await restarted.apply("owner", fresh.id, fresh.revision);
    await expect(access(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await restarted.close();
  }
});
