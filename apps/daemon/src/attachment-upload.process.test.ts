import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { ContextService } from "@ace/context";
import { fixture, token } from "./socket-test-support.ts";

test("HTTP uploads sync chunks before the body finishes, preserve every byte and reject oversize reservations", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-http-upload-"));
  const synced = Promise.withResolvers<void>();
  let sequence = 0;
  const context = await ContextService.open({
    root,
    now: () => 1000,
    id: () => `http-${++sequence}`,
    authorize: () => true,
    workspace: () => undefined,
    limits: { fileBytes: 100000 },
    async syncChunk(file) {
      await file.sync();
      synced.resolve();
    },
  });
  const f = await fixture({ context });
  try {
    const bytes = Buffer.alloc(98304, 42);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const upload = (size: number) => {
      const reply = Promise.withResolvers<{ status: number; body: string }>();
      const req = request(
        `${f.server.httpUrl}/v1/attachments/${f.thread.id}/upload?name=archive.zip`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Length": size,
            "X-Ace-Sha256": hash,
            "Content-Type": "application/zip",
          },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            body += chunk;
          });
          res.on("end", () => reply.resolve({ status: res.statusCode ?? 0, body }));
          res.on("error", reply.reject);
        },
      );
      req.on("error", reply.reject);
      return { req, reply: reply.promise };
    };
    const accepted = upload(bytes.length);
    accepted.req.write(bytes.subarray(0, 49152));
    await synced.promise;
    expect(
      await context.uploads.handle("local", { op: "upload.status", uploadId: "http-1" }),
    ).toMatchObject({ offset: 49152 });
    accepted.req.end(bytes.subarray(49152));
    const reply = await accepted.reply;
    expect(reply.status).toBe(201);
    expect(JSON.parse(reply.body)).toMatchObject({
      kind: "attachment",
      attachment: { sha256: hash, bytes: bytes.length },
    });
    expect(
      await readFile((await context.uploads.attachment("local", f.thread.id, hash)).path),
    ).toEqual(bytes);
    const rejected = upload(100001);
    rejected.req.flushHeaders();
    const refused = await rejected.reply;
    expect(refused.status).toBe(413);
    expect(refused.body).toContain("Choose a smaller file");
    rejected.req.destroy();
  } finally {
    await f.close();
    await context.close();
    await rm(root, { recursive: true, force: true });
  }
});
