import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ContextService, type ProjectionCapabilities } from "./index.ts";
import { repository, hash, png, thread } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(workspace?: (root: string) => Promise<string>) {
  const repo = await repository();
  let id = 0;
  const service = await ContextService.open({
    root: join(repo.root, ".git", "ace-context"),
    now: () => 1000,
    id: () => `upload-${++id}`,
    authorize: (device, value) => device === "device" && value === thread,
    workspace: () => (workspace ? workspace(repo.root) : repo.root),
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
    {
      type: "text",
      text: 'Provider claude cannot take attachment "binary.dat" (application/octet-stream) within its media capabilities and size limits.',
    },
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
      text: 'Provider claude cannot take attachment "phone.png" (image/png) within its media capabilities and size limits.',
    },
  ]);
  expect(result.diagnostics).toMatchObject([{ code: "unsupported" }]);
});

async function storeBytes(service: ContextService, bytes: Buffer, name: string) {
  const begin = await service.uploads.handle("device", {
    op: "upload.begin",
    threadId: thread,
    bytes: bytes.length,
    sha256: hash(bytes),
    name,
  });
  if (begin.kind !== "upload") throw new Error("Expected upload");
  for (let offset = 0; offset < bytes.length; offset += 65536)
    await service.uploads.handle("device", {
      op: "upload.chunk",
      uploadId: begin.uploadId,
      offset,
      data: bytes.subarray(offset, offset + 65536).toString("base64"),
    });
  await service.uploads.handle("device", { op: "upload.commit", uploadId: begin.uploadId });
}
test("multi-megabyte documents compose into Claude and ACP native inputs", async () => {
  const f = await fixture();
  const bytes = Buffer.alloc(4 * 1024 * 1024, 32);
  bytes.write("%PDF-1.7\n");
  await storeBytes(f.service, bytes, "large.pdf");
  for (const provider of ["claude", "acp"] as const) {
    const result = await f.service.compose(
      "device",
      thread,
      { mentions: [], attachments: [{ sha256: hash(bytes) }] },
      {
        ...caps,
        provider,
        documents: ["application/pdf"],
        embeddedContext: true,
        maxInlineBytes: bytes.length,
      },
    );
    expect(result.projection.input).toMatchObject(
      provider === "claude"
        ? [{ type: "document", source: { data: bytes.toString("base64") } }]
        : [{ type: "resource", resource: { blob: bytes.toString("base64") } }],
    );
    expect(result.diagnostics).toEqual([]);
    result.release();
  }
});
test("provider consumption retains local images after thread release until explicit release", async () => {
  const f = await fixture();
  await storeBytes(f.service, png, "phone.png");
  const result = await f.service.compose(
    "device",
    thread,
    { mentions: [], attachments: [{ sha256: hash(png) }, { sha256: hash(png) }] },
    { ...caps, provider: "codex" },
  );
  if (result.projection.provider !== "codex") throw new Error("Expected Codex");
  const part = result.projection.input[0];
  if (!part || part.type !== "localImage") throw new Error("Expected image");
  await f.service.uploads.releaseThread(thread);
  await f.service.uploads.collect();
  expect(await readFile(part.path)).toEqual(png);
  result.release();
  result.release();
  await f.service.uploads.collect();
  await expect(access(part.path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("composition pins the complete batch before asynchronous mention preparation", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const f = await fixture(async (root) => {
    entered.resolve();
    await release.promise;
    return root;
  });
  await f.write("main.ts", "main");
  await storeBytes(f.service, png, "phone.png");
  const composing = f.service.compose(
    "device",
    thread,
    {
      mentions: [{ path: "main.ts" }],
      attachments: [{ sha256: hash(png) }, { sha256: hash(png) }],
    },
    caps,
  );
  await entered.promise;
  try {
    await f.service.uploads.releaseThread(thread);
    await f.service.uploads.collect();
  } finally {
    release.resolve();
  }
  const result = await composing;
  expect(result.projection.input).toMatchObject([
    { type: "text" },
    { type: "image" },
    { type: "image" },
  ]);
  result.release();
  expect(await f.service.uploads.collect()).toBe(1);
});
test("lease admission stays bounded and explicit release permits new consumption", async () => {
  const f = await fixture();
  await storeBytes(f.service, png, "phone.png");
  const leases = [];
  try {
    for (let i = 0; i < 128; i++)
      leases.push(await f.service.uploads.acquire("device", thread, [hash(png)]));
    await expect(f.service.uploads.acquire("device", thread, [hash(png)])).rejects.toMatchObject({
      code: "busy",
    });
    leases.pop()?.release();
    const next = await f.service.uploads.acquire("device", thread, [hash(png)]);
    expect(await readFile(next.blobs[0]?.path ?? "missing")).toEqual(png);
    next.release();
  } finally {
    for (const lease of leases) lease.release();
  }
});

test("failed preparation releases every acquired blob lease", async () => {
  const f = await fixture(async () => {
    throw new Error("workspace unavailable");
  });
  await storeBytes(f.service, png, "phone.png");
  await expect(
    f.service.compose(
      "device",
      thread,
      { mentions: [{ path: "main.ts" }], attachments: [{ sha256: hash(png) }] },
      caps,
    ),
  ).rejects.toThrow("workspace unavailable");
  await f.service.uploads.releaseThread(thread);
  expect(await f.service.uploads.collect()).toBe(1);
});

test("caller edits to a leased descriptor cannot change which blob gets released", async () => {
  const f = await fixture();
  await storeBytes(f.service, png, "phone.png");
  const lease = await f.service.uploads.acquire("device", thread, [hash(png)]);
  const blob = lease.blobs[0];
  if (!blob) throw new Error("Expected blob");
  blob.attachment.sha256 = "f".repeat(64);
  await f.service.uploads.releaseThread(thread);
  await f.service.uploads.collect();
  expect(await readFile(blob.path)).toEqual(png);
  lease.release();
  expect(await f.service.uploads.collect()).toBe(1);
});

test("Codex receives exact image bytes at a MIME-derived filename even when the upload name lies", async () => {
  const f = await fixture();
  await storeBytes(f.service, png, "wrong.txt");
  const result = await f.service.compose(
    "device",
    thread,
    {
      mentions: [],
      attachments: [{ sha256: hash(png) }],
    },
    { ...caps, provider: "codex" },
  );
  try {
    const image = result.projection.input[0];
    if (image?.type !== "localImage") throw new Error("Expected native local image");
    expect(image.path.endsWith(".png")).toBe(true);
    expect(hash(await readFile(image.path))).toBe(hash(png));
  } finally {
    result.release();
  }
});
