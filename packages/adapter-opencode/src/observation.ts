import { discoveryFailureCode, discoveryFailureReason } from "@ace/provider-kit/discovery-failure";
import { MetadataResponseError } from "./metadata-failure.ts";
import type { Frame } from "@ace/engine-api";
import type { Runtime } from "./runtime.ts";
import { maxProviderPayloadBytes } from "@ace/provider-kit/payload";
export type Observe = (dir: Frame["dir"], channel: string, data: unknown) => void;
export { sanitize } from "./redaction.ts";
import { sanitize } from "./redaction.ts";
import { JsonElider, openCodeElision } from "./elision.ts";
/**
 * Kept bytes of one JSON body after heavy strings are elided. History pages hold 128 messages,
 * and ordinary tool output alone can push one past 2 MiB with no attachment. 8 MiB leaves room
 * for that, and each message is still held to the 1 MiB frame bound. Raw bytes are bounded
 * by the request deadline only: elided bytes are counted and dropped, never held.
 */
const maxJsonBytes = 8 * 1024 * 1024;
/** Each event becomes one frame, so after elision it must fit the provider payload bound. */
const maxEventBytes = maxProviderPayloadBytes;
/** Larger response bodies are framed by size alone; a frame cannot exceed 1 MiB. */
const maxObservedBodyBytes = 768 * 1024;
export async function jsonResponse(response: Response): Promise<{ value: unknown; bytes: number }> {
  if (!response.headers.get("content-type")?.split(";")[0]?.trim().endsWith("/json")) {
    await response.body?.cancel();
    throw new Error("OpenCode returned non-JSON content");
  }
  if (!response.body) throw new Error("OpenCode returned an empty JSON body");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let bytes = 0,
    text = "";
  const elider = new JsonElider(openCodeElision, (piece) => {
    bytes += piece.byteLength;
    if (bytes > maxJsonBytes) throw new Error("OpenCode JSON exceeds byte limit");
    text += decoder.decode(piece, { stream: true });
  });
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      elider.push(next.value);
    }
    elider.end();
    return { value: JSON.parse(text + decoder.decode()), bytes };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Elide heavy strings, then bound each event. The SDK owns SSE parsing. */
function boundedSse(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let bytes = 0,
    newline = false,
    elider: JsonElider | undefined;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        elider = new JsonElider(openCodeElision, (chunk) => {
          for (const byte of chunk) {
            if (++bytes > maxEventBytes) throw new Error("OpenCode event exceeds byte limit");
            if (byte === 13) continue;
            if (byte === 10) {
              if (newline) bytes = 0;
              newline = true;
            } else newline = false;
          }
          controller.enqueue(chunk);
        });
      },
      transform(chunk) {
        elider?.push(chunk);
      },
      flush() {
        elider?.end();
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
      if (Buffer.byteLength(init.body) > maxProviderPayloadBytes)
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
      let result: unknown, bytes: number;
      try {
        ({ value: result, bytes } = await jsonResponse(response));
      } catch (error) {
        if (!response.ok && metadataResponse)
          throw new MetadataResponseError(
            url.pathname,
            discoveryFailureCode({ status: response.status, cause: error }),
          );
        throw error;
      }
      if (!response.ok && metadataResponse) {
        const code = discoveryFailureCode({ status: response.status, error: result });
        const detail =
          code === "discovery_failed"
            ? sanitize(discoveryFailureReason(result), secrets)
            : undefined;
        throw new MetadataResponseError(
          url.pathname,
          code,
          typeof detail === "string" ? detail : undefined,
        );
      }
      frame(
        "recv",
        "http",
        sanitize(
          bytes > maxObservedBodyBytes
            ? { method, path, status: response.status, bodyBytes: bytes }
            : { method, path, status: response.status, body: result },
          secrets,
        ),
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
