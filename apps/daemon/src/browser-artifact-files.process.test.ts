import { mkdir, mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, onTestFinished } from "vitest";
import { Item, type ThreadId } from "@ace/protocol";
import { BrowserArtifactFiles } from "./browser-artifact-files.ts";
import { Store } from "./store.ts";
import { createDevThread } from "./commands.ts";
import { readConfig } from "./config.ts";
import { originFixture } from "./browser-origin-test-support.ts";
import { FilesWorkspaces } from "./files-workspaces.ts";

const idle = () => {};
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "ace-browser-artifact-"));
  const store = new Store(join(home, "events.sqlite"));
  let sequence = 0;
  let onId = idle;
  const context = {
    config: readConfig({ ACE_HOME: home }),
    store,
    now: () => 100,
    id: () => {
      onId();
      return `artifact-${++sequence}`;
    },
  };
  const owners: BrowserArtifactFiles[] = [];
  const open = () => {
    const owner = new BrowserArtifactFiles(context);
    owners.push(owner);
    return owner;
  };
  onTestFinished(async () => {
    for (const owner of owners.toReversed()) await owner.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  await mkdir(join(home, "browser"));
  const artifact = { path: join(home, "browser", "saved.png"), mimeType: "image/png", bytes: 5 };
  await writeFile(artifact.path, "image");
  const workspace = store.createWorkspace(home, "Repo");
  const thread = createDevThread(store, workspace);
  const other = createDevThread(store, workspace);
  const append = (threadId: ThreadId, id: string) =>
    store.appendEvents(threadId, [
      {
        type: "item.created",
        item: Item.parse({
          type: "artifact",
          source: "browser",
          id: `item-${id}`,
          artifactId: id,
          ...artifact,
          createdAt: 100,
          complete: true,
        }),
      },
    ]);
  return {
    home,
    store,
    thread,
    other,
    artifact,
    open,
    append,
    onId: (callback: () => void) => {
      onId = callback;
    },
  };
}

it("restart reclaims orphaned and deleted registrations while preserving live thread downloads", async () => {
  const f = await fixture();
  const owner = f.open();
  let liveId = "";
  await owner.publish(f.thread.id, f.artifact, (id) => {
    liveId = id;
    f.append(f.thread.id, id);
  });
  let otherId = "";
  await owner.publish(f.other.id, f.artifact, (id) => {
    otherId = id;
    f.append(f.other.id, id);
  });
  expect(owner.owns(f.other.id, otherId)).toBe(true);
  const service = await owner.get();
  await service.registerArtifact({
    root: join(f.home, "browser"),
    path: "saved.png",
    name: "orphan",
    category: "other",
    id: "browser-orphan",
  });
  f.store.appendEvents(f.other.id, [
    { type: "thread.client.updated", changes: { deletedAt: 101 } },
  ]);
  // Download authorization must stop immediately, before registry reconciliation.
  expect(owner.owns(f.other.id, otherId)).toBe(false);
  expect(await service.request("reader", { op: "artifacts.list" })).toHaveLength(3);
  await owner.close();
  const restarted = f.open();
  const files = await restarted.get();
  expect(await files.request("reader", { op: "artifacts.list" })).toEqual([
    { id: liveId, name: "saved.png", category: "screenshot", size: 5 },
  ]);
  expect(restarted.owns(f.thread.id, liveId)).toBe(true);
  expect(restarted.owns(f.other.id, liveId)).toBe(false);
  const download = await files.downloadForTransport("reader", {
    op: "artifact.download",
    artifactId: liveId,
  });
  try {
    const parts: Buffer[] = [];
    for await (const bytes of download.chunks) parts.push(bytes);
    expect(Buffer.concat(parts).toString()).toBe("image");
  } finally {
    await download.close();
  }
  f.store.deleteThread(f.thread.id);
  await restarted.sweep();
  expect(await files.request("reader", { op: "artifacts.list" })).toEqual([]);
});

it("failed and deletion-raced publication release their registrations without reviving the thread", async () => {
  const f = await fixture();
  const owner = f.open();
  const files = await owner.get();
  await expect(
    owner.publish(f.thread.id, f.artifact, () => {
      throw new Error("Publication failed");
    }),
  ).rejects.toThrow("Publication failed");
  expect(await files.request("reader", { op: "artifacts.list" })).toEqual([]);
  // The injected producer ID boundary runs inside registration, after admission but before publication.
  f.onId(() => {
    f.store.deleteThread(f.thread.id);
  });
  await owner.publish(f.thread.id, f.artifact, (id) => f.append(f.thread.id, id));
  expect(f.store.getThread(f.thread.id)).toBeUndefined();
  expect(await files.request("reader", { op: "artifacts.list" })).toEqual([]);
});

it("maintenance cannot reclaim a registration before its admitted publication commits", async () => {
  const f = await fixture();
  const owner = f.open();
  let maintenance: Promise<void> | undefined;
  let id = "";
  f.onId(() => {
    maintenance = owner.sweep();
  });
  await owner.publish(f.thread.id, f.artifact, (value) => {
    id = value;
    f.append(f.thread.id, value);
  });
  await maintenance;
  expect(await (await owner.get()).request("reader", { op: "artifacts.list" })).toMatchObject([
    { id },
  ]);
});

it("an exhausted orphan registry frees capacity for the next live browser artifact", async () => {
  const f = await fixture();
  const owner = f.open();
  const files = await owner.get();
  for (let index = 0; index < 1024; index++)
    await files.registerArtifact({
      root: join(f.home, "browser"),
      path: "saved.png",
      name: "orphan",
      category: "other",
      id: `browser-orphan-${index}`,
    });
  let id = "";
  await owner.publish(f.thread.id, f.artifact, (value) => {
    id = value;
    f.append(f.thread.id, value);
  });
  expect(await files.request("reader", { op: "artifacts.list" })).toMatchObject([{ id }]);
});

it("deleting a recording thread closes its browser and removes its persistent profile", async () => {
  const f = await originFixture();
  const files = new FilesWorkspaces(f.context);
  f.context.services.threadFiles = files;
  f.context.resources.own(() => files.close());
  await f.browser.startRecording(f.thread.id);
  const key = createHash("sha256").update(`${f.thread.workspaceId}:${f.thread.id}`).digest("hex");
  const profile = join(f.home, "browser", "profiles", key);
  await access(profile);
  f.store.appendEvents(f.thread.id, [
    { type: "thread.client.updated", changes: { deletedAt: 1001 } },
  ]);
  // Share the real forget operation already triggered by the deletion listener.
  await f.browser.forgetThread(f.thread.id, f.thread.workspaceId);
  await expect(access(profile)).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    f.store
      .readEvents({ afterSeq: 0, threadId: f.thread.id, limit: 100 })
      .some(
        (event) => event.payload.type === "item.created" && event.payload.item.type === "artifact",
      ),
  ).toBe(false);
});
