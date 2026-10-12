import type { IncomingMessage, ServerResponse } from "node:http";
import { IconRef } from "@ace/protocol";
import type { ServerOptions } from "./server-options.ts";
import type { RemoteAuth } from "./remote-auth.ts";
import { webOriginAllowlist } from "./web-origins.ts";
import { allows } from "./devices.ts";

/**
 * `GET /v1/icons/<sha256>`: a resolved site or app icon, by the hash of its PNG. Content-addressed,
 * so cached for good; bearer-only like attachments, since which apps and sites an agent used is
 * the person's business.
 */
export function iconsHttp(
  options: ServerOptions,
  auth: RemoteAuth,
  remote: boolean,
  next: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const origins = webOriginAllowlist(options.webOrigins);
  return (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url?.split("?")[0] ?? "";
    if (!path.startsWith("/v1/icons/")) {
      next(request, response);
      return;
    }
    request.resume();
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    const origin = request.headers.origin;
    if (origin && origins.has(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Expose-Headers", "ETag");
    }
    if (request.method === "OPTIONS") {
      response.statusCode = origin && origins.has(origin) ? 204 : 403;
      if (response.statusCode === 204) {
        response.setHeader("Access-Control-Allow-Headers", "Authorization, If-None-Match");
        response.setHeader("Access-Control-Allow-Methods", "GET, HEAD");
      }
      response.end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.end();
      return;
    }
    const token = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? "";
    const device = remote ? auth.deviceBearer(token) : auth.localBearer(token);
    if (!device) {
      response.statusCode = 401;
      response.end();
      return;
    }
    if (!allows(device, "read")) {
      response.statusCode = 403;
      response.end();
      return;
    }
    const ref = IconRef.safeParse(path.slice("/v1/icons/".length).replace(/\.png$/, ""));
    const png = ref.success ? options.icons?.read(ref.data) : undefined;
    if (!ref.success || !png) {
      response.statusCode = 404;
      response.end();
      return;
    }
    const etag = `"${ref.data}"`;
    response.setHeader("ETag", etag);
    response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    response.setHeader("Content-Type", "image/png");
    if (request.headers["if-none-match"] === etag) {
      response.statusCode = 304;
      response.end();
      return;
    }
    response.setHeader("Content-Length", png.length);
    response.end(request.method === "HEAD" ? undefined : png);
  };
}
