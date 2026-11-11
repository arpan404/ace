import {
  HTTP_MAX_REQUEST_BYTES,
  HTTP_RESPONSE_WINDOW,
  ResponseHead,
  abortFrame,
  bodyFrame,
  chunks,
  creditFrame,
  decodeFrame,
  endFrame,
  headFrame,
  isEventStream,
  requestHeaders,
} from "@ace/relay/wire";
import type { ForwardPath } from "./http-path.ts";
import { upgraded } from "./upgrade.ts";

/** Per-host limits on forwarded HTTP (ADR 0117). Every open exchange keeps the object awake. */
export const httpLimits = {
  /** Requests in flight at once, streams included. */
  maxRequests: 32,
  /** Of those, responses that are event streams (`subscriptions/listen`). */
  maxStreams: 4,
  /** For the daemon to open its `/serve` socket once asked. */
  openTimeoutMs: 10_000,
  /** From the request's arrival to the daemon's response head. */
  headTimeoutMs: 100_000,
  /** From the response head to its end; a stream is cut then and the client reconnects. */
  responseTimeoutMs: 30 * 60_000,
};

/** How the object asks its daemon for a stream: sent, or why it can't be. */
export type Offer = (ticket: string) => "sent" | "offline" | "unsupported";

type Waiting = {
  open(socket: WebSocket): void;
  refuse(status: number): void;
};

const plain = (status: number, message: string, headers: Record<string, string> = {}) =>
  new Response(`${message}\n`, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
const offline = () =>
  plain(503, "This machine isn't connected to ace's relay.", { "retry-after": "5" });

function randomTicket(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Forwarded HTTP for one relay object. Everything here lives in memory only while a request is
 * in flight, which keeps the object awake anyway; idle, it holds nothing, so hibernation loses
 * nothing. The one timer per exchange is its own deadline and ends with it.
 */
export class HttpGateway {
  #waiting = new Map<string, Waiting>();
  #active = 0;
  #streams = 0;

  /** Forwards one caller request to the daemon and returns its response, streamed. */
  async forward(request: Request, target: ForwardPath, offer: Offer): Promise<Response> {
    if (this.#active >= httpLimits.maxRequests)
      return plain(429, "Too many requests to this machine at once.", { "retry-after": "1" });
    this.#active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#active--;
    };
    try {
      return await this.#exchange(request, target, offer, release);
    } catch {
      release();
      return plain(502, "The machine's answer was cut off.");
    }
  }

  /** The daemon's `/serve` upgrade for `ticket`, or a refusal if nothing waits for it. */
  join(ticket: string): Response {
    const waiting = this.#waiting.get(ticket);
    if (!waiting) return new Response(null, { status: 404 });
    this.#waiting.delete(ticket);
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    // Not hibernatable: the caller's request keeps the object awake for the exchange's life.
    server.accept();
    waiting.open(server);
    return upgraded(client);
  }

  /** The daemon refused `ticket`. False when it isn't an HTTP ticket. */
  rejected(ticket: string, reason: "off" | "busy" | undefined): boolean {
    const waiting = this.#waiting.get(ticket);
    if (!waiting) return false;
    this.#waiting.delete(ticket);
    waiting.refuse(reason === "busy" ? 503 : 404);
    return true;
  }

  async #exchange(
    request: Request,
    target: ForwardPath,
    offer: Offer,
    release: () => void,
  ): Promise<Response> {
    const body = await readBody(request);
    if (!body) {
      release();
      return plain(413, "Request body too large.");
    }
    const ticket = randomTicket();
    const opened = Promise.withResolvers<WebSocket | number>();
    this.#waiting.set(ticket, { open: opened.resolve, refuse: opened.resolve });
    const sent = offer(ticket);
    if (sent !== "sent") {
      this.#waiting.delete(ticket);
      release();
      return sent === "offline" ? offline() : new Response(null, { status: 404 });
    }
    const started = Date.now();
    let timer = setTimeout(() => opened.resolve(503), httpLimits.openTimeoutMs);
    const callerGone = () => opened.resolve(499);
    request.signal?.addEventListener("abort", callerGone, { once: true });
    const socket = await opened.promise;
    clearTimeout(timer);
    this.#waiting.delete(ticket);
    if (typeof socket === "number") {
      request.signal?.removeEventListener("abort", callerGone);
      release();
      return socket === 404 ? new Response(null, { status: 404 }) : offline();
    }

    const head = Promise.withResolvers<ResponseHead | number>();
    let finished = false;
    let counted = false;
    let onFrame: (frame: ReturnType<typeof decodeFrame>) => void = (frame) => {
      if (frame.kind !== "head") return head.resolve(502);
      const parsed = ResponseHead.safeParse(frame.head);
      head.resolve(parsed.success ? parsed.data : 502);
    };
    let onEnd: () => void = () => head.resolve(502);
    const finish = (frame?: Uint8Array) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", cancel);
      if (frame) trySend(socket, frame);
      try {
        socket.close(1000);
      } catch {
        /* Already closed. */
      }
      if (counted) this.#streams--;
      release();
    };
    const cancel = () => {
      onEnd();
      finish(abortFrame());
    };
    request.signal?.removeEventListener("abort", callerGone);
    request.signal?.addEventListener("abort", cancel, { once: true });
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") return cancel();
      try {
        onFrame(decodeFrame(new Uint8Array(event.data)));
      } catch {
        cancel();
      }
    });
    socket.addEventListener("close", () => {
      onEnd();
      finish();
    });
    socket.addEventListener("error", () => {
      onEnd();
      finish();
    });
    timer = setTimeout(cancel, Math.max(0, started + httpLimits.headTimeoutMs - Date.now()));

    trySend(
      socket,
      headFrame({
        method: request.method,
        origin: new URL(request.url).origin,
        prefix: target.prefix,
        path: target.path,
        headers: requestHeaders(request.headers),
      }),
    );
    for (const chunk of chunks(body)) trySend(socket, bodyFrame(chunk));
    trySend(socket, endFrame());

    const answer = await head.promise;
    if (typeof answer === "number") {
      finish(abortFrame());
      return answer === 499
        ? new Response(null, { status: 499 })
        : plain(504, "The machine didn't answer in time.");
    }
    const stream = isEventStream(answer);
    if (stream && this.#streams >= httpLimits.maxStreams) {
      finish(abortFrame());
      return plain(429, "Too many open streams to this machine.", { "retry-after": "5" });
    }
    if (stream) {
      this.#streams++;
      counted = true;
    }
    clearTimeout(timer);
    if (answer.status === 204 || answer.status === 304 || request.method === "HEAD") {
      finish();
      return new Response(null, { status: answer.status, headers: answer.headers });
    }

    let received = 0;
    let credited = 0;
    let queued = () => 0;
    const body$ = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          queued = () => HTTP_RESPONSE_WINDOW - (controller.desiredSize ?? 0);
          onFrame = (frame) => {
            if (frame.kind === "body") {
              received += frame.bytes.length;
              if (received - credited > HTTP_RESPONSE_WINDOW) return cancel();
              controller.enqueue(frame.bytes);
            } else if (frame.kind === "end") {
              onEnd = () => {};
              controller.close();
              finish();
            } else {
              onEnd();
              finish();
            }
          };
          onEnd = () => {
            onEnd = () => {};
            controller.error(new Error("Response cut off"));
          };
          timer = setTimeout(cancel, httpLimits.responseTimeoutMs);
        },
        pull: () => {
          // Acknowledge what the caller took, in batches, or all of it once the queue is empty.
          const owed = received - queued() - credited;
          if (owed > 0 && (owed >= HTTP_RESPONSE_WINDOW / 4 || queued() === 0)) {
            credited += owed;
            if (!finished) trySend(socket, creditFrame(owed));
          }
        },
        cancel: () => {
          onEnd = () => {};
          finish(abortFrame());
        },
      },
      { highWaterMark: HTTP_RESPONSE_WINDOW, size: (chunk) => chunk.byteLength },
    );
    return new Response(body$, {
      status: answer.status,
      headers: answer.headers,
    });
  }
}

function trySend(socket: WebSocket, frame: Uint8Array): void {
  try {
    socket.send(frame);
  } catch {
    /* Closed: its close event ends the exchange. */
  }
}

/** The whole request body, or undefined past the relay's cap. */
async function readBody(request: Request): Promise<Uint8Array | undefined> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > HTTP_MAX_REQUEST_BYTES) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    parts.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return body;
}
