import type { IncomingMessage, ServerResponse } from "node:http";
import { ContextError } from "@ace/context";
import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import type { ServerOptions } from "./server-options.ts";
import type { RemoteAuth } from "./remote-auth.ts";
import { webOriginAllowlist } from "./web-origins.ts";
import { allows } from "./devices.ts";
import { attachmentResponse } from "./attachment-response.ts";
import { attachmentsUpload } from "./attachments-upload.ts";

/** Bearer-only transfers share socket scope checks. URLs contain content ids, never credentials. */
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
        response.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization, Range, If-None-Match, Content-Type, X-Ace-Sha256",
        );
        response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST");
        response.statusCode = 204;
        response.end();
        return;
      }
      const url = new URL(request.url ?? "", "http://daemon.local");
      const upload = /^\/v1\/attachments\/([\w-]+)\/upload$/.exec(url.pathname);
      if (upload?.[1]) {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end();
          request.resume();
          return;
        }
        if (active >= 8) {
          response.statusCode = 429;
          response.end();
          request.resume();
          return;
        }
        active++;
        try {
          await attachmentsUpload(request, response, options, auth, remote, upload[1], url);
        } finally {
          active--;
        }
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
      const read = options.context?.readAttachment?.bind(options.context);
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
      const budget = attachmentResponse(
        response,
        options.runtime?.delay ? { delay: options.runtime.delay } : undefined,
      );
      try {
        const hash = match[2],
          variant = match[3] === "thumbnail" ? "thumbnail" : "original";
        // Authorize and validate ownership even for HEAD and conditional requests.
        const first = await budget.wait(read(device.id, thread, hash, variant, 0, 65536, allowed));
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
              : await budget.wait(
                  read(
                    device.id,
                    thread,
                    hash,
                    variant,
                    offset,
                    Math.min(65536, end - offset),
                    allowed,
                  ),
                );
          if (!allowed()) throw new ContextError("forbidden", "Device access revoked");
          const data = chunk.data.subarray(0, end - offset);
          if (!data.length) throw new Error("Attachment read made no progress");
          offset += data.length;
          if (!response.write(data)) await budget.drain();
        }
        await budget.end();
      } finally {
        budget.close();
        active--;
      }
    })().catch((error: unknown) => {
      if (response.headersSent || response.destroyed) {
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
        quota: 413,
      };
      response.statusCode =
        error instanceof ContextError
          ? (statuses[error.code] ?? 400)
          : error instanceof z.ZodError
            ? 400
            : 500;
      request.resume();
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          error:
            error instanceof z.ZodError
              ? "Invalid attachment metadata. Send a valid filename, size and SHA-256."
              : error instanceof Error
                ? error.message
                : "Attachment request failed",
        }),
      );
    });
  };
}
