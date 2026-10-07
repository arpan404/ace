import { discoveryFailureCode } from "@ace/provider-kit/discovery-failure";
import type { Frame } from "@ace/engine-api";
import type { Runtime } from "./runtime.ts";
export type Observe = (dir: Frame["dir"], channel: string, data: unknown) => void;
export { sanitize } from "./redaction.ts";
import { sanitize } from "./redaction.ts";
export async function jsonResponse(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.split(";")[0]?.trim().endsWith("/json")) {
    await response.body?.cancel();
    throw new Error("OpenCode returned non-JSON content");
  }
  if (!response.body) throw new Error("OpenCode returned an empty JSON body");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let bytes = 0,
    text = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error("OpenCode JSON exceeds byte limit");
      text += decoder.decode(next.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Scan bytes without decoding or copying chunks. SDK owns SSE parsing. */
function boundedSse(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let bytes = 0,
    newline = false;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        for (const byte of chunk) {
          if (++bytes > 1024 * 1024) throw new Error("OpenCode event exceeds byte limit");
          if (byte === 13) continue;
          if (byte === 10) {
            if (newline) bytes = 0;
            newline = true;
          } else newline = false;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}
export function observedFetch(
  runtime: Runtime,
  authorization: string,
  secrets: readonly string[],
  signal: AbortSignal,
  frame: Observe,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (/credential|integration|\/auth|\/config|\/pair/.test(url.pathname))
      throw new Error("OpenCode credential/config operations are forbidden");
    const method = init?.method ?? "GET",
      path = url.pathname + url.search;
    let body: unknown;
    if (typeof init?.body === "string") {
      if (Buffer.byteLength(init.body) > 1024 * 1024)
        throw new Error("OpenCode input exceeds byte limit");
      body = JSON.parse(init.body);
    }
    frame(
      "send",
      "http",
      sanitize({ method, path, ...(body === undefined ? {} : { body }) }, secrets),
    );
    const deadline = new AbortController();
    const cancelDeadline = runtime.schedule(() => deadline.abort(), 30000);
    try {
      const response = await runtime.fetch(url, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization },
        signal: AbortSignal.any([signal, deadline.signal, ...(init?.signal ? [init.signal] : [])]),
        redirect: "error",
      });
      if (url.pathname === "/api/event") {
        if (
          !response.ok ||
          !response.headers.get("content-type")?.startsWith("text/event-stream") ||
          !response.body
        ) {
          await response.body?.cancel();
          throw Object.assign(new Error("OpenCode event transport rejected"), {
            code: discoveryFailureCode({ status: response.status }, "unreachable"),
          });
        }
        return new Response(boundedSse(response.body), {
          status: response.status,
          headers: response.headers,
        });
      }
      if (response.status === 204) {
        frame("recv", "http", { method, path, status: 204 });
        return response;
      }
      const metadataResponse = ["/api/model", "/api/info", "/openapi.json"].includes(url.pathname);
      let result: unknown;
      try {
        result = await jsonResponse(response);
      } catch (error) {
        if (!response.ok && metadataResponse)
          throw Object.assign(new Error("OpenCode metadata response failed"), {
            code: discoveryFailureCode({ status: response.status, cause: error }),
          });
        throw error;
      }
      if (!response.ok && metadataResponse)
        throw Object.assign(new Error("OpenCode metadata response failed"), {
          code: discoveryFailureCode({ status: response.status, error: result }),
        });
      frame(
        "recv",
        "http",
        sanitize({ method, path, status: response.status, body: result }, secrets),
      );
      return new Response(JSON.stringify(result), {
        status: response.status,
        headers: response.headers,
      });
    } finally {
      cancelDeadline();
    }
  };
}
