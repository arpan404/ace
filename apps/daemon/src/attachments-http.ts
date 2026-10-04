import type { IncomingMessage, ServerResponse } from "node:http";
import { ContextError } from "@ace/context";
import { ThreadId } from "@ace/protocol";
import type { ServerOptions } from "./server-options.ts";
import type { RemoteAuth } from "./remote-auth.ts";
import { webOriginAllowlist } from "./web-origins.ts";
import { allows } from "./devices.ts";

/** Bearer-only reads share socket scope checks. URLs contain content ids, never credentials. */
export function attachmentsHttp(
  options: ServerOptions,
  auth: RemoteAuth,
  remote: boolean,
  next: (request: IncomingMessage, response: ServerResponse) => void,
) {
  let active = 0;
  const origins = webOriginAllowlist(options.webOrigins);
  return (request: IncomingMessage, response: ServerResponse) => {
    if (!request.url?.startsWith("/v1/attachments/")) {
      next(request, response);
      return;
    }
    void (async () => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      const origin = request.headers.origin;
      if (origin && origins.has(origin)) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
        response.setHeader("Access-Control-Expose-Headers", "ETag, Content-Range, Content-Length");
      }
      if (request.method === "OPTIONS") {
        request.resume();
        if (!origin || !origins.has(origin)) {
          response.statusCode = 403;
          response.end();
          return;
        }
        response.setHeader("Access-Control-Allow-Headers", "Authorization, Range, If-None-Match");
        response.setHeader("Access-Control-Allow-Methods", "GET, HEAD");
        response.statusCode = 204;
        response.end();
        return;
      }
      const match = /^\/v1\/attachments\/([\w-]+)\/([a-f0-9]{64})\/(original|thumbnail)$/.exec(
        request.url ?? "",
      );
      if (!match?.[1] || !match[2] || !match[3]) {
        response.statusCode = 404;
        response.end();
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.statusCode = 405;
        response.end();
        return;
      }
      const token = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? "";
      const actor = () => (remote ? auth.deviceBearer(token) : auth.localBearer(token));
      const device = actor();
      if (!device) {
        response.statusCode = 401;
        response.end();
        return;
      }
      const thread = ThreadId.parse(match[1]);
      const allowed = () => {
        const current = actor();
        return (
          current !== undefined &&
          allows(current, "read") &&
          options.canReadThread?.(device.id, thread) !== false
        );
      };
      if (!allowed()) {
        response.statusCode = 403;
        response.end();
        return;
      }
      const read = options.context?.readAttachment;
      if (!read) {
        response.statusCode = 503;
        response.end();
        return;
      }
      if (active >= 8) {
        response.statusCode = 429;
        response.end();
        return;
      }
      active++;
      try {
        const hash = match[2],
          variant = match[3] === "thumbnail" ? "thumbnail" : "original";
        // Authorize and validate ownership even for HEAD and conditional requests.
        const first = await read(device.id, thread, hash, variant, 0, 65536, allowed);
        if (first.bytes > 32 * 1024 * 1024)
          throw new ContextError("quota", "Attachment exceeds response limit");
        const etag = `"${hash}-${variant}-v1"`;
        response.setHeader("ETag", etag);
        response.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
        response.setHeader("Content-Type", first.mimeType);
        response.setHeader("Content-Disposition", "inline");
        response.setHeader("Accept-Ranges", "bytes");
        if (request.headers["if-none-match"] === etag && !request.headers.range) {
          response.statusCode = 304;
          response.end();
          return;
        }
        let offset = 0,
          end = first.bytes;
        if (request.headers.range) {
          const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
          offset = Number(range?.[1]);
          end = range?.[2] ? Number(range[2]) + 1 : Math.min(offset + 1024 * 1024, first.bytes);
          if (
            !range ||
            !Number.isSafeInteger(offset) ||
            !Number.isSafeInteger(end) ||
            offset < 0 ||
            offset >= first.bytes ||
            end <= offset ||
            end > first.bytes ||
            end - offset > 1024 * 1024
          ) {
            response.setHeader("Content-Range", `bytes */${first.bytes}`);
            response.statusCode = 416;
            response.end();
            return;
          }
          response.statusCode = 206;
          response.setHeader("Content-Range", `bytes ${offset}-${end - 1}/${first.bytes}`);
        }
        response.setHeader("Content-Length", end - offset);
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        while (offset < end && !response.destroyed) {
          const chunk =
            offset === 0
              ? first
              : await read(
                  device.id,
                  thread,
                  hash,
                  variant,
                  offset,
                  Math.min(65536, end - offset),
                  allowed,
                );
          if (!allowed()) throw new ContextError("forbidden", "Device access revoked");
          const data = chunk.data.subarray(0, end - offset);
          if (!data.length) throw new Error("Attachment read made no progress");
          offset += data.length;
          if (!response.write(data))
            await new Promise<void>((resolve) => {
              const done = () => {
                response.off("drain", done);
                response.off("close", done);
                resolve();
              };
              response.once("drain", done);
              response.once("close", done);
            });
        }
        response.end();
      } finally {
        active--;
      }
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.setHeader("Cache-Control", "no-store");
      response.removeHeader("Content-Length");
      const statuses: Partial<Record<import("@ace/protocol").ContextErrorCode, number>> = {
        forbidden: 403,
        not_found: 404,
        unsupported: 415,
        busy: 429,
        offset: 416,
      };
      response.statusCode = error instanceof ContextError ? (statuses[error.code] ?? 400) : 500;
      response.end();
    });
  };
}
