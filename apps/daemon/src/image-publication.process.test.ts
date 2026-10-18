import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import { ContextService } from "@ace/context";
import { Agent, ThreadId } from "@ace/protocol";
import { Store } from "./store.ts";
import { createDevThread } from "./commands.ts";
import { startDaemonMcp } from "./mcp.ts";
import { imagePublication, retainsImage } from "./image-publication.ts";
import { invoke, Result } from "./browser-mcp-test-support.ts";

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real 2×2 RGB PNG, so the attachment store's container check passes. */
function png(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

async function show(connection: { url: string; bearer: string }, args: unknown) {
  return Result.parse(await (await invoke(connection, "image_show", args)).json()).result;
}

/** A daemon store, attachment store and ace MCP server, with one agent working in `home`. */
async function daemon() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-image-")));
  const path = join(home, "store.sqlite");
  const world: {
    home: string;
    store: Store;
    context?: ContextService | undefined;
    mcp?: Awaited<ReturnType<typeof startDaemonMcp>> | undefined;
  } = { home, store: new Store(path) };
  const workspace = world.store.createWorkspace(home, "Test");
  const thread = createDevThread(world.store, workspace);
  const agent = Agent.parse({
    id: "root",
    threadId: thread.id,
    parentId: null,
    origin: "root",
    native: { provider: "codex" },
    fidelity: "full",
    cwd: home,
    status: { state: "idle" },
    createdAt: 1,
  });
  world.store.appendEvents(thread.id, [{ type: "agent.created", agent }], 1);
  const open = async () => {
    const store = world.store;
    world.context = await ContextService.open({
      root: join(home, "context"),
      now: () => 2,
      id: randomUUID,
      authorize: () => true,
      workspace: () => undefined,
      threadExists: (id) => store.hasLiveThread(ThreadId.parse(id)),
      retained: (id, hash) => retainsImage(store, id, hash),
    });
    world.mcp = await startDaemonMcp(store, [
      imagePublication({ store, context: () => world.context, now: () => 2, id: randomUUID }),
    ]);
    const lease = world.mcp.openSession(
      { sessionId: "image-test", threadId: thread.id, agentId: agent.id, capabilities: [] },
      new AbortController().signal,
    );
    return { url: world.mcp.url, bearer: lease.bearer };
  };
  const close = async () => {
    await world.mcp?.close();
    world.mcp = undefined;
    await world.context?.close();
    world.context = undefined;
    world.store.close();
  };
  cleanups.push(async () => {
    await close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  });
  const restart = async () => {
    await close();
    world.store = new Store(path);
    return open();
  };
  const items = () => world.store.readItemPage(thread.id, world.store.headSeq() + 1, 200).items;
  return { world, thread, connection: await open(), restart, items };
}

test("an image posted from a relative path is shown in the reply and its bytes read back after restart", async () => {
  const { world, thread, connection, restart, items } = await daemon();
  const bytes = png();
  // The name says JPEG; the bytes decide the type.
  await writeFile(join(world.home, "chart.jpg"), bytes);
  const posted = await show(connection, {
    path: "chart.jpg",
    alt: "Latency by day",
    caption: "p95 latency, sent by reader@example.invalid",
  });
  expect(posted.isError).not.toBe(true);
  const sent = await show(connection, { data: bytes.toString("base64"), alt: "Same chart" });
  expect(sent.isError).not.toBe(true);
  const shown = items().flatMap((item) => (item.type === "image" ? [item.image] : []));
  expect(shown.map(({ alt, caption, attachment }) => [alt, caption, attachment.mimeType])).toEqual([
    ["Latency by day", "p95 latency, sent by <EMAIL>", "image/png"],
    ["Same chart", undefined, "image/png"],
  ]);
  const [first] = shown;
  if (!first) throw new Error("Missing image");
  expect([first.attachment.width, first.attachment.height]).toEqual([2, 2]);

  await restart();
  const context = world.context;
  if (!context) throw new Error("Missing context");
  expect(items().filter((item) => item.type === "image")).toHaveLength(2);
  const read = await context.readAttachment(
    "reader",
    thread.id,
    first.attachment.sha256,
    "original",
    0,
    65536,
    () => true,
  );
  expect(Buffer.from(read.data).equals(bytes)).toBe(true);
});

test("bytes that are not an image are refused and nothing is posted", async () => {
  const { world, connection, items } = await daemon();
  await writeFile(join(world.home, "notes.png"), "not really a picture\n");
  const fromFile = await show(connection, { path: "notes.png", alt: "Notes" });
  expect(fromFile.isError).toBe(true);
  expect(JSON.stringify(fromFile)).toContain("invalid_image");
  const fromData = await show(connection, {
    data: Buffer.from("<svg></svg>").toString("base64"),
    mimeType: "image/png",
    alt: "Claimed PNG",
  });
  expect(fromData.isError).toBe(true);
  expect(JSON.stringify(fromData)).toContain("invalid_image");
  const both = await show(connection, { path: "notes.png", data: "AAAA", alt: "Both" });
  expect(both.isError).toBe(true);
  expect(items()).toHaveLength(0);
});

test("an image reached through a symbolic link is refused", async () => {
  const { world, connection, items } = await daemon();
  await writeFile(join(world.home, "chart.png"), png());
  await symlink(join(world.home, "chart.png"), join(world.home, "link.png"));
  const linked = await show(connection, { path: "link.png", alt: "Linked chart" });
  expect(linked.isError).toBe(true);
  expect(JSON.stringify(linked)).toContain("image_unavailable");
  expect(items()).toHaveLength(0);
});
