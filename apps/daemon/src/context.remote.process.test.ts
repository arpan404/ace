import { once } from "node:events";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ContextService } from "@ace/context";
import { DeviceId, type ContextOperation } from "@ace/protocol";
import { pinnedAgent } from "./client-access.ts";
import { Client } from "./socket-test-support.ts";
import { setup, cleanups, identity } from "./remote-test-support.ts";

async function contextFixture() {
  let service: ContextService | undefined;
  const f = await setup({
    context: {
      handle: async (device, request, access) => {
        if (!service) throw new Error("Context unavailable");
        return service.handle(device, request, access);
      },
    },
  });
  let id = 0;
  service = await ContextService.open({
    root: join(f.home, "context"),
    id: () => `upload-${++id}`,
    now: () => 1000,
    authorize: (_device, thread) => thread === f.thread.id,
    workspace: () => undefined,
  });
  const owned = service;
  cleanups.push(() => owned.close());
  let request = 0;
  const send = async (client: Client, operation: ContextOperation) => {
    client.send({ type: "context.request", requestId: `request-${++request}`, operation });
    const response = await client.next();
    if (response.type !== "context.result") throw new Error("Expected context result");
    return response.result;
  };
  const connect = async (scopes: string[]) => {
    const paired = await f.pair(scopes),
      ticket = await f.ticket(paired.token),
      agent = pinnedAgent(identity.fingerprint);
    cleanups.push(() => agent.destroy());
    const client = new Client(f.server.remoteUrl, { agent });
    cleanups.push(() => client.close());
    await once(client.socket, "open");
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse(paired.device.id),
      ticket: ticket.ticket,
    });
    expect(await client.next()).toMatchObject({ type: "welcome" });
    return client;
  };
  return { ...f, send, connect, service: owned };
}
test("a paired phone uploads to its remote daemon over pinned WSS", async () => {
  const f = await contextFixture(),
    client = await f.connect(["read", "operate"]),
    bytes = Buffer.from("remote phone image or file"),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  const begin = await f.send(client, {
    op: "upload.begin",
    threadId: f.thread.id,
    bytes: bytes.length,
    sha256,
    name: "phone.txt",
  });
  if (begin.kind !== "upload") throw new Error("Expected upload");
  await f.send(client, {
    op: "upload.chunk",
    uploadId: begin.uploadId,
    offset: 0,
    data: bytes.toString("base64"),
  });
  expect(await f.send(client, { op: "upload.commit", uploadId: begin.uploadId })).toMatchObject({
    kind: "attachment",
    attachment: { sha256 },
  });
  expect(await f.send(client, { op: "attachment.list", threadId: f.thread.id })).toMatchObject({
    kind: "attachments",
    attachments: [{ sha256 }],
  });
});
test("remote read scope can list attachments but cannot reserve or release them", async () => {
  const f = await contextFixture(),
    client = await f.connect(["read"]);
  expect(await f.send(client, { op: "attachment.list", threadId: f.thread.id })).toEqual({
    kind: "attachments",
    attachments: [],
  });
  expect(
    await f.send(client, {
      op: "upload.begin",
      threadId: f.thread.id,
      bytes: 1,
      sha256: "0".repeat(64),
      name: "file",
    }),
  ).toMatchObject({ kind: "error", code: "forbidden" });
  expect(
    await f.send(client, {
      op: "attachment.release",
      threadId: f.thread.id,
      sha256: "0".repeat(64),
    }),
  ).toMatchObject({ kind: "error", code: "forbidden" });
});
test("remote operate scope can reserve files but cannot read workspace or attachment listings", async () => {
  const f = await contextFixture(),
    client = await f.connect(["operate"]);
  expect(
    await f.send(client, {
      op: "upload.begin",
      threadId: f.thread.id,
      bytes: 1,
      sha256: "0".repeat(64),
      name: "file",
    }),
  ).toMatchObject({ kind: "upload", offset: 0 });
  expect(await f.send(client, { op: "attachment.list", threadId: f.thread.id })).toMatchObject({
    kind: "error",
    code: "forbidden",
  });
  expect(
    await f.send(client, {
      op: "mention.complete",
      threadId: f.thread.id,
      query: "secret",
      limit: 20,
    }),
  ).toMatchObject({ kind: "error", code: "forbidden" });
});

test("attachment HTTP reads require current read and thread permission, preserve original bytes and bound preview and ranges", async () => {
  let context: ContextService | undefined;
  const { token } = await import("./socket-test-support.ts");
  const { readFile } = await import("node:fs/promises");
  const { request: httpsRequest } = await import("node:https");
  const { imageSize } = await import("image-size");
  let allowed = true;
  const f = await setup({
    context: {
      handle: (device, request, access) => {
        if (!context) throw new Error("Context unavailable");
        return context.handle(device, request, access);
      },
      readAttachment: (...args) => {
        if (!context) throw new Error("Context unavailable");
        return context.readAttachment(...args);
      },
    },
    canReadThread: (_device, thread) => allowed && thread === f.thread.id,
  });
  context = await ContextService.open({
    root: join(f.home, "context"),
    id: () => "image-upload",
    now: () => 1000,
    authorize: (_device, thread) => thread === f.thread.id,
    workspace: () => undefined,
  });
  const owned = context;
  cleanups.push(() => owned.close());
  const bytes = await readFile(
    new URL("../../../packages/context/fixtures/colours.png", import.meta.url),
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const uploader = await f.connect();
  await uploader.next();
  const send = async (operation: ContextOperation) => {
    uploader.send({ type: "context.request", requestId: "http-upload", operation });
    const reply = await uploader.next();
    if (reply.type !== "context.result") throw new Error("Expected context result");
    return reply.result;
  };
  const begin = await send({
    op: "upload.begin",
    threadId: f.thread.id,
    sha256,
    bytes: bytes.length,
    name: "screen.txt",
  });
  if (begin.kind !== "upload") throw new Error("Expected upload");
  for (let offset = 0; offset < bytes.length; offset += 65531)
    await send({
      op: "upload.chunk",
      uploadId: begin.uploadId,
      offset,
      data: bytes.subarray(offset, offset + 65531).toString("base64"),
    });
  await send({ op: "upload.commit", uploadId: begin.uploadId });
  const reader = await f.pair(["read"]),
    operator = await f.pair(["operate"]);
  const base = `${f.server.remoteUrl.replace("wss:", "https:")}/v1/attachments/${f.thread.id}/${sha256}`;
  const get = (url: string, credential: string, headers: Record<string, string> = {}) =>
    new Promise<{
      status: number;
      bytes: Buffer;
      headers: import("node:http").IncomingHttpHeaders;
    }>((resolve, reject) => {
      const req = httpsRequest(
        url,
        {
          rejectUnauthorized: false,
          headers: { authorization: `Bearer ${credential}`, ...headers },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              bytes: Buffer.concat(chunks),
              headers: response.headers,
            }),
          );
          response.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
    });
  expect((await get(`${base}/original`, "0".repeat(64))).status).toBe(401);
  expect((await get(`${base}/original`, token)).status).toBe(401);
  expect((await get(`${base}/original`, operator.token)).status).toBe(403);
  const original = await get(`${base}/original`, reader.token);
  expect(original.status).toBe(200);
  expect(original.bytes).toEqual(bytes);
  expect(original.headers["content-type"]).toBe("image/png");
  expect(original.headers.etag).toContain(sha256);
  expect((await get(`${base}/original`, reader.token, { range: "bytes=17-123" })).bytes).toEqual(
    bytes.subarray(17, 124),
  );
  expect((await get(`${base}/original`, reader.token, { range: "bytes=0-999999999" })).status).toBe(
    416,
  );
  expect(
    (await get(`${base}/original`, reader.token, { "if-none-match": original.headers.etag ?? "" }))
      .status,
  ).toBe(304);
  const preview = await get(`${base}/thumbnail`, reader.token);
  expect(preview.status).toBe(200);
  expect(preview.bytes.length).toBeLessThan(256 * 1024);
  expect(imageSize(preview.bytes)).toMatchObject({ width: 256, height: 192 });
  allowed = false;
  expect(
    (await get(`${base}/original`, reader.token, { "if-none-match": original.headers.etag ?? "" }))
      .status,
  ).toBe(403);
  allowed = true;
  expect(
    (await get(base.replace(f.thread.id, "other-thread") + "/original", reader.token)).status,
  ).toBe(403);
  await f.request(`/v1/devices/${reader.device.id}`, { method: "DELETE", token });
  expect((await get(`${base}/original`, reader.token)).status).toBe(401);
});
