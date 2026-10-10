import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ContextService } from "@ace/context";
import { Agent, Item } from "@ace/protocol";
import { Store } from "./store.ts";
import { createDevThread } from "./commands.ts";
import { observeNativeImages } from "./native-images.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function fixture(withCwd = true) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-native-image-")));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const store = new Store(join(home, "events.sqlite"));
  cleanups.push(async () => store.close());
  const thread = createDevThread(store, store.createWorkspace(join(home, "project"), "Project"));
  const other = createDevThread(store, thread.workspaceId);
  const agent = Agent.parse({
    id: "native-root",
    threadId: thread.id,
    parentId: null,
    origin: "root",
    native: { provider: "codex" },
    fidelity: "full",
    cwd: withCwd ? home : ".",
    status: { state: "idle" },
    createdAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "agent.created", agent }]);
  let next = 0;
  const context = await ContextService.open({
    root: join(home, "context"),
    now: () => 1000,
    id: () => `image-${++next}`,
    authorize: (_device, id) => !!store.getThread(id === thread.id ? thread.id : other.id),
    workspace: () => undefined,
    retained: (id, hash) => store.nativeImages.retains(id, hash),
    imageReference: (id, path, itemId) => store.nativeImages.resolve(id, path, itemId),
  });
  cleanups.push(() => context.close());
  let stop = observeNativeImages(store, context, new AbortController().signal);
  cleanups.push(() => stop());
  const bytes = await readFile(new URL("./testing/measurement-filmstrip.jpg", import.meta.url));
  const path = join(home, "chart.jpg");
  await writeFile(path, bytes);
  const image = (id: string, source?: string) =>
    Item.parse({
      type: "tool_call",
      id,
      agentId: agent.id,
      createdAt: 2,
      complete: true,
      call: {
        id,
        agentId: agent.id,
        kind: "image",
        title: "Viewed image",
        status: "succeeded",
        startedAt: 2,
        detail: { kind: "image", ...(source ? { path: source } : {}) },
        raw: [],
      },
    });
  const emit = (id: string, source?: string) =>
    store.appendEvents(thread.id, [{ type: "item.created", item: image(id, source) }]);
  const attachment = (id: string) => {
    const item = store.snapshotThread(thread.id).items[id];
    return item?.type === "tool_call" && item.call.detail.kind === "image"
      ? item.call.detail.attachment
      : undefined;
  };
  return {
    home,
    store,
    thread,
    other,
    context,
    bytes,
    path,
    emit,
    attachment,
    async restart() {
      await stop();
      stop = observeNativeImages(store, context, new AbortController().signal);
    },
    stop: () => stop(),
  };
}

test("native tool images outside the checkout are captured, resolved per thread and retained after provider updates", async () => {
  const f = await fixture();
  f.emit("viewed", "./chart.jpg");
  await expect.poll(() => f.attachment("viewed")).toBeDefined();
  const attachment = f.attachment("viewed");
  if (!attachment) throw new Error("Missing image");
  expect(
    await readFile(
      (await f.context.uploads.attachment("local", f.thread.id, attachment.sha256)).path,
    ),
  ).toEqual(f.bytes);
  expect(f.store.nativeImages.resolve(f.thread.id, "chart.jpg")).toEqual(attachment);
  expect(f.store.nativeImages.resolve(f.other.id, f.path)).toBeUndefined();
  const result = await f.context.handle("local", {
    type: "context.request",
    requestId: "resolve",
    operation: { op: "image.resolve", threadId: f.thread.id, reference: f.path },
  });
  expect(result.result).toMatchObject({
    kind: "attachment",
    attachment: { sha256: attachment.sha256 },
  });
  await expect(
    f.context.uploads.handle("local", {
      op: "attachment.release",
      threadId: f.thread.id,
      sha256: attachment.sha256,
    }),
  ).rejects.toThrow();
  const item = f.store.snapshotThread(f.thread.id).items.viewed;
  if (item?.type !== "tool_call") throw new Error("Missing tool");
  f.store.appendEvents(f.thread.id, [
    {
      type: "item.updated",
      item: { ...item, call: { ...item.call, detail: { kind: "image", path: "./chart.jpg" } } },
    },
  ]);
  await f.restart();
  expect(f.attachment("viewed")).toEqual(attachment);
});

test("missing and symbolic images become unavailable without breaking the thread", async () => {
  const f = await fixture();
  await symlink(f.path, join(f.home, "linked.jpg"));
  f.emit("missing", join(f.home, "missing.jpg"));
  f.emit("linked", join(f.home, "linked.jpg"));
  await expect.poll(() => f.store.nativeImages.has(f.thread.id, "linked")).toBe(true);
  await expect.poll(() => f.store.nativeImages.has(f.thread.id, "missing")).toBe(true);
  expect(f.attachment("linked")).toBeUndefined();
  expect(f.store.snapshotThread(f.thread.id).items.linked).toMatchObject({
    call: { detail: { kind: "image", unavailable: expect.any(String) } },
  });
});

test("backfill reaches older images even when newer image tools have no saved path", async () => {
  const f = await fixture();
  await f.stop();
  f.emit("old", f.path);
  for (let index = 0; index < 270; index++) f.emit(`pathless-${index}`);
  await f.restart();
  await expect.poll(() => f.store.nativeImages.resolve(f.thread.id, f.path)).toBeDefined();
});

test("a preparing workspace makes a relative image unavailable without repeatedly retrying it", async () => {
  const f = await fixture(false);
  f.store.workspaceReservations.reserve(f.thread.id, "preparing", [join(f.home, "project")]);
  f.emit("reserved", "./chart.jpg");
  await expect.poll(() => f.store.nativeImages.has(f.thread.id, "reserved")).toBe(true);
  expect(f.store.snapshotThread(f.thread.id).items.reserved).toMatchObject({
    call: { detail: { unavailable: expect.any(String) } },
  });
  await f.restart();
  expect(f.attachment("reserved")).toBeUndefined();
});

test("historical replies retain their image when an agent reuses the filename", async () => {
  const f = await fixture();
  f.emit("first", "./chart.jpg");
  await expect.poll(() => f.attachment("first")).toBeDefined();
  const first = f.attachment("first");
  f.store.appendEvents(f.thread.id, [
    {
      type: "item.created",
      item: Item.parse({
        type: "message",
        id: "first-answer",
        agentId: "native-root",
        createdAt: 3,
        role: "assistant",
        complete: true,
        parts: [{ type: "text", text: "![Chart](./chart.jpg)" }],
      }),
    },
  ]);
  await writeFile(f.path, Buffer.concat([f.bytes, Buffer.from("second image")]));
  f.emit("second", "./chart.jpg");
  await expect.poll(() => f.attachment("second")).toBeDefined();
  expect(f.attachment("second")?.sha256).not.toBe(first?.sha256);
  expect(f.store.nativeImages.resolve(f.thread.id, "chart.jpg", "first-answer")).toEqual(first);
  expect(f.store.nativeImages.resolve(f.thread.id, f.path, "first-answer")).toEqual(first);
  expect(f.store.nativeImages.resolve(f.thread.id, "chart.jpg", "absent-answer")).toBeUndefined();
});

test("absolute native images retain relative answer references after the agent changes folders", async () => {
  const f = await fixture();
  f.emit("absolute", f.path);
  await expect.poll(() => f.attachment("absolute")).toBeDefined();
  const attachment = f.attachment("absolute");
  f.store.appendEvents(f.thread.id, [
    {
      type: "item.created",
      item: Item.parse({
        type: "message",
        id: "absolute-answer",
        agentId: "native-root",
        createdAt: 3,
        role: "assistant",
        complete: true,
        parts: [{ type: "text", text: "![Chart](./chart.jpg)" }],
      }),
    },
  ]);
  const agent = f.store.snapshotThread(f.thread.id).agents["native-root"];
  if (!agent) throw new Error("Missing agent");
  f.store.appendEvents(f.thread.id, [
    { type: "agent.updated", agentId: agent.id, cwd: join(f.home, "other") },
  ]);
  await f.restart();
  expect(f.store.nativeImages.resolve(f.thread.id, "chart.jpg", "absolute-answer")).toEqual(
    attachment,
  );
  expect(f.store.nativeImages.resolve(f.thread.id, f.path, "absolute-answer")).toEqual(attachment);
});
