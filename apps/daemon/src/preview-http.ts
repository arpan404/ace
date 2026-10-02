import type { RequestListener } from "node:http";
import { PreviewPort } from "@ace/protocol/preview";
import type { DaemonPreview } from "./preview.ts";

/** Link issuance only: registering or launching servers remains trusted host control. */
export function previewHttp(
  preview: () => DaemonPreview | undefined,
  next: RequestListener,
): RequestListener {
  return (request, response) => {
    if (!request.url?.startsWith("/v1/previews/")) return next(request, response);
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json");
    const finish = (status: number, result: unknown) => {
      response.writeHead(status);
      response.end(JSON.stringify(result));
    };
    const path = /^\/v1\/previews\/(\d{1,5})\/link$/.exec(request.url);
    const port = PreviewPort.safeParse(Number(path?.[1]));
    const gateway = preview();
    request.resume();
    if (!gateway || !path) return finish(404, { error: "Preview unavailable" });
    if (request.method !== "POST") return finish(405, { error: "POST required" });
    if (!port.success) return finish(400, { error: "Invalid preview port" });
    const token = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.authorization ?? "")?.[1];
    if (!token) return finish(401, { error: "Paired device token required" });
    void gateway.mintLink({ port: port.data, deviceToken: token }).then(
      (url) => finish(200, { url }),
      () => finish(403, { error: "Preview link refused" }),
    );
  };
}
