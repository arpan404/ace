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
