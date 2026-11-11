import type WebSocket from "ws";
import type { Clock } from "./clock.ts";
import type { FrameReader } from "./socket.ts";
import { sendFrame } from "./socket.ts";
import {
  HTTP_MAX_REQUEST_BYTES,
  HTTP_RESPONSE_WINDOW,
  RequestHead,
  abortFrame,
  bodyFrame,
  chunks,
  decodeFrame,
  endFrame,
  headFrame,
  responseHeaders,
} from "./http-frames.ts";

/** Where a forwarded request arrived: the relay's public origin and this machine's prefix. */
export type ForwardedHttp = { origin: string; prefix: string };

/**
 * Serves one forwarded request. `request.url` is the public URL the caller used
 * (`<origin><prefix><path>`); `signal` aborts when the caller goes away or the relay drops.
 */
export type RelayHttpHandler = (
  request: Request,
  signal: AbortSignal,
  forwarded: ForwardedHttp,
) => Promise<Response>;

/** What a host needs to answer `http` control messages from ace's hosted relay. */
export type HostHttpOptions = {
  /** Read for every request: off, the relay is told so and the caller gets 404. */
  enabled(): boolean | Promise<boolean>;
  handle: RelayHttpHandler;
  /** Requests served at once; more are refused as busy. Default 32. */
  maxConcurrent?: number;
};

const HEAD_TIMEOUT_MS = 10_000;

/**
 * Reads one request from a `/serve` socket, hands it to `handle` and streams the response back
 * within the relay's credit (framing in `http-frames.ts`). Resolves once the exchange ends,
 * whichever side ends it; the socket is closed by then.
 */
export async function serveHttpExchange(
  socket: WebSocket,
  reader: FrameReader,
  handle: RelayHttpHandler,
  options: { clock: Clock; signal: AbortSignal },
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener("abort", abort, { once: true });
  socket.once("close", abort);
  const expire = options.clock.schedule(HEAD_TIMEOUT_MS, () => socket.terminate());
  try {
    let request: { head: RequestHead; body: Uint8Array<ArrayBuffer> };
    try {
      request = await readRequest(reader);
    } finally {
      expire();
    }
    let window = HTTP_RESPONSE_WINDOW;
    let wake: (() => void) | undefined;
    // After the request, the relay sends only credit, or abort when the caller leaves.
    void (async () => {
      try {
        for (;;) {
          const frame = decodeFrame(await reader.next());
          if (frame.kind !== "credit") break;
          window += frame.bytes;
          wake?.();
        }
      } catch {
        /* The socket closed. */
      }
      controller.abort();
      wake?.();
    })();
    const { head, body } = request;
    const url = head.origin + head.prefix + head.path;
    const response = await handle(
      new Request(url, {
        method: head.method,
        headers: head.headers,
        signal: controller.signal,
        ...(body.length && head.method !== "GET" && head.method !== "HEAD" ? { body } : {}),
      }),
      controller.signal,
      { origin: head.origin, prefix: head.prefix },
    ).catch(() => new Response(null, { status: 502 }));
    if (controller.signal.aborted) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    await sendFrame(
      socket,
      headFrame({ status: response.status, headers: responseHeaders(response.headers) }),
    );
    const source = response.body?.getReader();
    const stop = () => void source?.cancel().catch(() => {});
    controller.signal.addEventListener("abort", stop, { once: true });
    try {
      for (;;) {
        if (!source || controller.signal.aborted) break;
        const { done, value } = await source.read();
        if (done) break;
        for (const chunk of chunks(value)) {
          while (window < chunk.length && !controller.signal.aborted)
            await new Promise<void>((resolve) => (wake = resolve));
          if (controller.signal.aborted) return;
          window -= chunk.length;
          await sendFrame(socket, bodyFrame(chunk));
        }
      }
      if (!controller.signal.aborted) await sendFrame(socket, endFrame());
    } catch {
      await sendFrame(socket, abortFrame()).catch(() => {});
    } finally {
      controller.signal.removeEventListener("abort", stop);
    }
  } catch {
    /* Malformed request or a closed socket: the exchange ends. */
  } finally {
    controller.abort();
    options.signal.removeEventListener("abort", abort);
    socket.off("close", abort);
    socket.close(1000);
  }
}

async function readRequest(
  reader: FrameReader,
): Promise<{ head: RequestHead; body: Uint8Array<ArrayBuffer> }> {
  const first = decodeFrame(await reader.next());
  if (first.kind !== "head") throw new Error("Request head expected");
  const head = RequestHead.parse(first.head);
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const frame = decodeFrame(await reader.next());
    if (frame.kind === "end") break;
    if (frame.kind !== "body") throw new Error("Request ended early");
    size += frame.bytes.length;
    if (size > HTTP_MAX_REQUEST_BYTES) throw new Error("Request body too large");
    parts.push(frame.bytes);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return { head, body };
}
