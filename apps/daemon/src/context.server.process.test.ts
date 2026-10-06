import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ContextService } from "@ace/context";
import { ThreadId, type ContextOperation, type ContextResult } from "@ace/protocol";
import { fixture, type Client } from "./socket-test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup(authorize?: () => Promise<boolean>) {
  let service: ContextService | undefined;
  const f = await fixture({
    context: {
      handle: async (device, request, allowed) => {
        if (!service) throw new Error("Service unavailable");
        return service.handle(device, request, allowed);
      },
    },
  });
  let id = 0;
  service = await ContextService.open({
    root: join(f.home, "context"),
    id: () => `upload-${++id}`,
    now: () => 1000,
    authorize: async (_device, thread) =>
      thread === f.thread.id && (authorize ? await authorize() : true),
    workspace: () => undefined,
  });
  const owned = service;
  cleanups.push(async () => {
    await f.close();
    await owned.close();
  });
  let request = 0;
  const send = async (
    client: Client,
    operation: ContextOperation,
  ): Promise<ContextResult["result"]> => {
    client.send({ type: "context.request", requestId: `req-${++request}`, operation });
    const result = await client.next();
    if (result.type !== "context.result") throw new Error(`Unexpected ${result.type}`);
    return result.result;
  };
  return { ...f, service: owned, send };
}
test("a disconnected phone resumes the same upload over an authenticated WebSocket", async () => {
  const f = await setup();
  const bytes = Buffer.from("phone attachment bytes"),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  const first = await f.connect();
  await first.next();
  const begin = await f.send(first, {
    op: "upload.begin",
    threadId: f.thread.id,
    bytes: bytes.length,
    sha256,
    name: "phone.txt",
  });
  if (begin.kind !== "upload") throw new Error("Expected upload");
  const uploadId = begin.uploadId;
  expect(
    await f.send(first, {
      op: "upload.chunk",
      uploadId,
      offset: 0,
      data: bytes.subarray(0, 6).toString("base64"),
    }),
  ).toMatchObject({ kind: "upload", offset: 6 });
  await first.close();
  const resumed = await f.connect();
  await resumed.next();
  expect(await f.send(resumed, { op: "upload.status", uploadId })).toMatchObject({
    kind: "upload",
    offset: 6,
  });
  await f.send(resumed, {
    op: "upload.chunk",
    uploadId,
    offset: 6,
    data: bytes.subarray(6).toString("base64"),
  });
  expect(await f.send(resumed, { op: "upload.commit", uploadId })).toMatchObject({
    kind: "attachment",
    attachment: { sha256, mimeType: "text/plain" },
  });
  expect(
    await readFile((await f.service.uploads.attachment("device", f.thread.id, sha256)).path),
  ).toEqual(bytes);
});
test("upload requests require hello authentication and an authorized thread", async () => {
  const f = await setup();
  const first = await f.open();
  first.send({
    type: "context.request",
    requestId: "no-auth",
    operation: { op: "attachment.list", threadId: f.thread.id },
  });
  expect(await first.next()).toMatchObject({ type: "error", code: "unauthorized" });
  const client = await f.connect();
  await client.next();
  expect(
    await f.send(client, { op: "attachment.list", threadId: ThreadId.parse("unknown") }),
  ).toMatchObject({ kind: "error", code: "forbidden" });
});
test("overlapping context operations wait their turn without making tiny uploads fail", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const f = await setup(async () => {
    entered.resolve();
    await release.promise;
    return true;
  });
  const client = await f.connect();
  await client.next();
  const bytes = Buffer.from("tiny attachment");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  client.send({
    type: "context.request",
    requestId: "first",
    operation: {
      op: "upload.begin",
      threadId: f.thread.id,
      name: "first.txt",
      bytes: bytes.length,
      sha256,
    },
  });
  await entered.promise;
  try {
    client.send({
      type: "context.request",
      requestId: "second",
      operation: {
        op: "upload.begin",
        threadId: f.thread.id,
        name: "second.txt",
        bytes: bytes.length,
        sha256,
      },
    });
    client.send({ type: "ping" });
    const messages = [];
    while (true) {
      const message = await client.next();
      if (message.type === "pong") break;
      messages.push(message);
    }
    expect(messages).toEqual([]);
  } finally {
    release.resolve();
  }
  const first = await client.next();
  const second = await client.next();
  expect(first).toMatchObject({
    type: "context.result",
    requestId: "first",
    result: { kind: "upload", offset: 0 },
  });
  expect(second).toMatchObject({
    type: "context.result",
    requestId: "second",
    result: { kind: "upload", offset: 0 },
  });
  for (const result of [first, second]) {
    if (result.type !== "context.result" || result.result.kind !== "upload")
      throw new Error("No upload");
    const uploadId = result.result.uploadId;
    await f.send(client, {
      op: "upload.chunk",
      uploadId,
      offset: 0,
      data: bytes.toString("base64"),
    });
    expect(await f.send(client, { op: "upload.commit", uploadId })).toMatchObject({
      kind: "attachment",
      attachment: { sha256 },
    });
  }
  expect(
    await readFile((await f.service.uploads.attachment("device", f.thread.id, sha256)).path),
  ).toEqual(bytes);
});
