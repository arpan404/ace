import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { BlobHash, ThreadId, type ContextOperation, type ContextResult } from "@ace/protocol";
import { ContextError } from "@ace/context";
import type { ServerOptions } from "./server-options.ts";
import type { RemoteAuth } from "./remote-auth.ts";
import { allows } from "./devices.ts";
import { attachmentResponse } from "./attachment-response.ts";

/** HTTP and socket uploads share reservations, durability, hashes, quotas and device scopes. */
export async function attachmentsUpload(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServerOptions,
  auth: RemoteAuth,
  remote: boolean,
  scope: string,
  url: URL,
): Promise<void> {
  const token = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? "";
  const actor = () => (remote ? auth.deviceBearer(token) : auth.localBearer(token));
  const device = actor();
  if (!device) {
    response.statusCode = 401;
    response.end();
    request.resume();
    return;
  }
  const thread = ThreadId.parse(scope);
  const draft = scope.startsWith("draft-");
  const allowed = () => {
    const current = actor();
    return (
      current !== undefined &&
      allows(current, "operate") &&
      (draft || options.canReadThread?.(device.id, thread) !== false)
    );
  };
  if (!allowed())
    throw new ContextError("forbidden", "This device cannot attach files to the thread.");
  const context = options.context;
  if (!context) {
    response.statusCode = 503;
    response.end();
    request.resume();
    return;
  }
  const length = request.headers["content-length"];
  if (typeof length !== "string" || !/^\d+$/.test(length))
    throw new ContextError(
      "invalid_request",
      "Send Content-Length and X-Ace-Sha256 with the file bytes.",
    );
  const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(Number(length));
  const sha256 = BlobHash.parse(request.headers["x-ace-sha256"]);
  const name = z.string().min(1).max(255).parse(url.searchParams.get("name"));
  const mimeType = z.string().max(128).optional().parse(request.headers["content-type"]);
  const budget = attachmentResponse(
    response,
    options.runtime?.delay ? { delay: options.runtime.delay } : undefined,
    10 * 60_000,
  );
  const ask = async (operation: ContextOperation): Promise<ContextResult["result"]> => {
    const reply = await budget.wait(
      context.handle(
        device.id,
        { type: "context.request", requestId: "http-upload", operation },
        allowed,
      ),
    );
    if (reply.result.kind === "error")
      throw new ContextError(reply.result.code, reply.result.message);
    return reply.result;
  };
  let uploadId: string | undefined;
  try {
    const begun = await ask(
      draft
        ? { op: "draft.upload.begin", draftId: scope, bytes, sha256, name, mimeType }
        : { op: "upload.begin", threadId: thread, bytes, sha256, name, mimeType },
    );
    if (begun.kind !== "upload") throw new Error("Invalid upload reservation");
    uploadId = begun.uploadId;
    let offset = 0;
    const stream = request[Symbol.asyncIterator]();
    for (;;) {
      const next = await budget.wait(stream.next());
      if (next.done) break;
      const chunk = z.instanceof(Buffer).parse(next.value);
      for (let start = 0; start < chunk.length; start += 65536) {
        const data = chunk.subarray(start, start + 65536);
        if (offset + data.length > bytes)
          throw new ContextError("quota", "Upload exceeds its declared size. Send a smaller file.");
        await ask({ op: "upload.chunk", uploadId, offset, data: data.toString("base64") });
        offset += data.length;
      }
    }
    if (offset !== bytes)
      throw new ContextError("offset", "Upload is incomplete. Upload the file again.");
    const committed = await ask({ op: "upload.commit", uploadId });
    if (!allowed()) throw new ContextError("forbidden", "Device access revoked");
    response.statusCode = 201;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(committed));
    uploadId = undefined;
  } finally {
    budget.close();
    if (uploadId)
      await context.handle(device.id, {
        type: "context.request",
        requestId: "http-cancel",
        operation: { op: "upload.cancel", uploadId },
      });
    request.resume();
  }
}
