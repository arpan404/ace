import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { expect, test } from "vitest";
import { ContextService } from "@ace/context";
import type { ContextOperation } from "@ace/protocol";
import { fixture, token } from "./socket-test-support.ts";

test("a valid original larger than one MiB refuses a range exceeding the independent response range budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-image-range-"));
  let allowedThread: string | undefined;
  const context = await ContextService.open({
    root,
    now: () => 1000,
    id: () => "large-upload",
    authorize: (_device, thread) => thread === allowedThread,
    workspace: () => undefined,
  });
  // Pass the real service instance, as daemon startup does: its methods require their receiver.
  const f = await fixture({ context });
  allowedThread = f.thread.id;
  try {
    const client = await f.connect();
    await client.next();
    let id = 0;
    const send = async (operation: ContextOperation) => {
      client.send({ type: "context.request", requestId: `range-${++id}`, operation });
      const result = await client.next();
      if (result.type !== "context.result") throw new Error("Expected context result");
      return result.result;
    };
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0x61),
      sha256 = createHash("sha256").update(bytes).digest("hex");
    const begin = await send({
      op: "upload.begin",
      threadId: f.thread.id,
      sha256,
      bytes: bytes.length,
      name: "original.dat",
    });
    if (begin.kind !== "upload") throw new Error("Expected upload");
    for (let offset = 0; offset < bytes.length; offset += 65531)
      await send({
        op: "upload.chunk",
        uploadId: begin.uploadId,
        offset,
        data: bytes.subarray(offset, offset + 65531).toString("base64"),
      });
    expect((await send({ op: "upload.commit", uploadId: begin.uploadId })).kind).toBe("attachment");
    const fetchRange = (range: string) =>
      new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
        const req = request(
          `${f.server.httpUrl}/v1/attachments/${f.thread.id}/${sha256}/original`,
          { headers: { Authorization: `Bearer ${token}`, Range: range } },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }),
            );
            response.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end();
      });
    expect((await fetchRange("bytes=0-1048576")).status).toBe(416);
    const accepted = await fetchRange("bytes=0-1048575");
    expect(accepted.status).toBe(206);
    expect(accepted.body).toEqual(bytes.subarray(0, 1024 * 1024));
  } finally {
    await context.close();
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});
