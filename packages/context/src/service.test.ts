import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ContextService, type ProjectionCapabilities } from "./index.ts";
import { repository, hash, png, thread } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const repo = await repository();
  let id = 0;
  const service = await ContextService.open({
    root: join(repo.root, ".git", "ace-context"),
    now: () => 1000,
    id: () => `upload-${++id}`,
    authorize: (device, value) => device === "device" && value === thread,
    workspace: () => repo.root,
  });
  cleanups.push(async () => {
    await service.close();
    await repo.close();
  });
  return { ...repo, service };
}
const caps: ProjectionCapabilities = {
  provider: "claude",
  images: ["image/png"],
  documents: [],
  embeddedContext: false,
  maxInlineBytes: 1000,
};

test("composer resolves mentions and stored phone uploads into one provider input", async () => {
  const f = await fixture();
  await f.write("main.ts", "one\ntwo\nthree");
  const begin = await f.service.handle("device", {
    type: "context.request",
    requestId: "begin",
    operation: {
      op: "upload.begin",
      threadId: thread,
      sha256: hash(png),
      bytes: png.length,
      name: "phone.png",
    },
  });
  if (begin.result.kind !== "upload") throw new Error("Expected upload");
  const uploadId = begin.result.uploadId;
  await f.service.handle("device", {
    type: "context.request",
    requestId: "chunk",
    operation: { op: "upload.chunk", uploadId, offset: 0, data: png.toString("base64") },
  });
  await f.service.handle("device", {
    type: "context.request",
    requestId: "commit",
    operation: { op: "upload.commit", uploadId },
  });
  const result = await f.service.compose(
    "device",
    thread,
    {
      mentions: [{ path: "main.ts", lines: { start: 2, end: 2 } }],
      attachments: [{ sha256: hash(png) }],
    },
    caps,
  );
  expect(result.projection.input).toEqual([
    { type: "text", text: "File: main.ts:2-2\ntwo" },
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: png.toString("base64") },
    },
  ]);
  expect(result.diagnostics).toEqual([]);
});
test("binary mentions retain validated paths and typed fallback diagnostics", async () => {
  const f = await fixture();
  await f.write("binary.dat", Buffer.from([0, 1]));
  const result = await f.service.compose(
    "device",
    thread,
    { mentions: [{ path: "binary.dat" }], attachments: [] },
    caps,
  );
  expect(result.projection.input).toEqual([
    { type: "text", text: `Attachment: ${join(f.root, "binary.dat")}` },
  ]);
  expect(result.diagnostics.map((d) => d.code)).toEqual(["binary", "unsupported"]);
});
test("workspace contents are never returned to a denied device", async () => {
  const f = await fixture();
  await f.write("private.ts", "private content");
  const result = await f.service.handle("denied", {
    type: "context.request",
    requestId: "denied",
    operation: { op: "mention.complete", threadId: thread, query: "private" },
  });
  expect(result.result).toMatchObject({ kind: "error", code: "forbidden" });
  await expect(
    f.service.compose("denied", thread, { mentions: [], attachments: [] }, caps),
  ).rejects.toMatchObject({ code: "forbidden" });
});
test("completion and folder context share the initialized file index", async () => {
  const f = await fixture();
  await f.write("src/main.ts", "source");
  await f.write(".gitignore", "hidden.txt\n");
  await f.write("hidden.txt", "secret");
  const complete = await f.service.handle("device", {
    type: "context.request",
    requestId: "paths",
    operation: { op: "mention.complete", threadId: thread, query: "smn" },
  });
  expect(complete.result).toEqual({ kind: "completion", paths: ["src/main.ts"] });
  const mentions = await f.service.handle("device", {
    type: "context.request",
    requestId: "folder",
    operation: { op: "mention.resolve", threadId: thread, mentions: [{ path: "src" }] },
  });
  expect(mentions.result).toMatchObject({
    kind: "mentions",
    entries: [{ path: "src/main.ts", text: "File: src/main.ts\nsource" }],
  });
});

test("composition falls back when a stored image exceeds the inline media budget", async () => {
  const f = await fixture();
  const begin = await f.service.uploads.handle("device", {
    op: "upload.begin",
    threadId: thread,
    bytes: png.length,
    sha256: hash(png),
    name: "phone.png",
  });
  if (begin.kind !== "upload") throw new Error("Expected upload");
  await f.service.uploads.handle("device", {
    op: "upload.chunk",
    uploadId: begin.uploadId,
    offset: 0,
    data: png.toString("base64"),
  });
  await f.service.uploads.handle("device", { op: "upload.commit", uploadId: begin.uploadId });
  const result = await f.service.compose(
    "device",
    thread,
    { mentions: [], attachments: [{ sha256: hash(png) }] },
    { ...caps, maxInlineBytes: 0 },
  );
  expect(result.projection.input).toEqual([
    {
      type: "text",
      text: `Attachment: ${join(f.root, ".git", "ace-context", "blobs", hash(png))}`,
    },
  ]);
  expect(result.diagnostics).toMatchObject([{ code: "unsupported" }]);
});
