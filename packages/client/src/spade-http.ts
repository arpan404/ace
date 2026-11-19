import {
  maxSpadePartChars,
  maxSpadeRequestBytes,
  type SpadeBodyEncoding,
  type SpadeHttpResult,
  type SpadeMethod,
} from "@ace/protocol";
import type { ClientApi } from "./api.ts";
import { onSocketMove } from "./socket-moves.ts";

/*
 * One exchange with Spade through the daemon (ADR 0121, `spade.http`): a body larger than one
 * message goes in `spade.http.part`s, and a long answer comes back in pieces read with
 * `spade.http.read`. Bodies are text or base64 both ways; Spade owns what they mean.
 */

/** What an exchange needs from the connection. */
export type SpadeHttpOwner = Pick<
  ClientApi,
  "request" | "send" | "onMessage" | "connectionState" | "connectionGeneration"
>;

/** Run `callback` after `delay` ms; returns its cancel. Injected so tests control time. */
export type SpadeLater = (delay: number, callback: () => void) => () => void;

const defaultLater: SpadeLater = (delay, callback) => {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
};

/**
 * How long an upload may go without its result once the daemon opened it, unless the caller
 * gives its own: room for tens of megabytes on a slow link and Spade's own work. The request's own timeout ended when it resolved on the open.
 */
const uploadAnswerMs = 5 * 60_000;

export interface SpadeExchangeOptions {
  id(): string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  /** Timers for the wait after an upload's open; real ones by default. */
  later?: SpadeLater | undefined;
}

/** An upload whose result can't come any more, or didn't come in time: Spade may have it. */
const uploadLost = (message: string) => ({
  kind: "error" as const,
  code: "failed" as const,
  message,
});

export interface SpadeExchange {
  method: SpadeMethod;
  path: string;
  body?: string | undefined;
  /** How `body` is written; text by default. */
  encoding?: SpadeBodyEncoding | undefined;
  contentType?: string | undefined;
}

export type SpadeAnswer =
  | {
      kind: "response";
      status: number;
      /** The whole body, every piece joined, in `encoding`. */
      body: string;
      encoding: SpadeBodyEncoding;
      contentType: string | undefined;
    }
  | Extract<SpadeHttpResult["result"], { kind: "error" }>;

/**
 * `text` in pieces of at most `max` characters that join back to it. A text piece never ends
 * between the two halves of a surrogate pair; a base64 piece other than the last holds a
 * multiple of 4 characters, so each decodes on its own.
 */
export function spadeBodyParts(text: string, max: number, encoding: SpadeBodyEncoding): string[] {
  const parts: string[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(text.length, at + max);
    if (end < text.length) {
      if (encoding === "base64") end = at + Math.max(4, Math.floor((end - at) / 4) * 4);
      else if (isHighSurrogate(text.charCodeAt(end - 1)) && end - 1 > at) end -= 1;
    }
    parts.push(text.slice(at, end));
    at = end;
  }
  return parts.length ? parts : [""];
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** Let queued work run, so the socket drains a little between runs of parts. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Parts sent before letting the socket drain a little. */
const partsPerTurn = 16;

/**
 * Send one request and read its whole answer. A body over one message's room goes in parts,
 * sent once the daemon says the upload is open (`spade.http.open`); its result follows them. A
 * refusal comes instead of the open, and then no part is sent. A long answer's pieces are read
 * in order; if the daemon no longer holds them (`gone`), the request is sent once more.
 */
export async function spadeExchange(
  client: SpadeHttpOwner,
  exchange: SpadeExchange,
  options: SpadeExchangeOptions,
): Promise<SpadeAnswer> {
  const first = await attempt(client, exchange, options);
  return first === "gone" ? attemptOnce(client, exchange, options) : first;
}

async function attemptOnce(
  client: SpadeHttpOwner,
  exchange: SpadeExchange,
  options: Parameters<typeof spadeExchange>[2],
): Promise<SpadeAnswer> {
  const answer = await attempt(client, exchange, options);
  if (answer !== "gone") return answer;
  return {
    kind: "error",
    code: "failed",
    message: "Spade's answer was let go before it was read.",
  };
}

async function attempt(
  client: SpadeHttpOwner,
  exchange: SpadeExchange,
  options: Parameters<typeof spadeExchange>[2],
): Promise<SpadeAnswer | "gone"> {
  const requestId = options.id();
  const encoding = exchange.encoding ?? "text";
  const body = exchange.body;
  const parts =
    body !== undefined && body.length > maxSpadeRequestBytes
      ? spadeBodyParts(body, maxSpadePartChars, encoding)
      : undefined;
  const requestOptions = {
    requestId,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  };
  // An upload's result arrives after the request resolved on its open: listen before asking.
  const uploaded = parts ? uploadResult(client, requestId, options.signal) : undefined;
  const reply = client.request(
    {
      type: "spade.http",
      method: exchange.method,
      path: exchange.path,
      encoding,
      ...(exchange.contentType ? { contentType: exchange.contentType } : {}),
      ...(parts ? { parts: parts.length } : body !== undefined ? { body } : {}),
    },
    requestOptions,
  );
  if (parts && uploaded) {
    try {
      const answer = await reply;
      if (answer.type === "spade.http.result")
        return finish(client, requestId, answer.result, requestOptions);
      // The open: the daemon took the request and wants the body now. A refusal partway through
      // ends the upload with a result; a part the socket can't take ends it here, and so does a
      // drop, a socket move or a long silence after the open (`uploadResult`).
      uploaded.arm(options.timeoutMs ?? uploadAnswerMs, options.later ?? defaultLater);
      const lost = sendParts(client, requestId, parts).then(
        () => new Promise<never>(() => {}),
        () => uploadLost("The connection dropped while sending to Spade."),
      );
      const result = await Promise.race([uploaded.result, lost]);
      return finish(client, requestId, result, requestOptions);
    } finally {
      uploaded.stop();
    }
  }
  const answer = await reply;
  if (answer.type !== "spade.http.result")
    return { kind: "error", code: "failed", message: "The daemon opened an upload with no body." };
  return finish(client, requestId, answer.result, requestOptions);
}

const noop = () => {};

/**
 * The `spade.http.result` that ends the upload `requestId`, however it arrives. It can't arrive
 * once the connection leaves ready or moves to another socket (the daemon ended the upload with
 * the old one), so either ends it as lost; so does no result within the time `arm` sets.
 */
function uploadResult(client: SpadeHttpOwner, requestId: string, signal: AbortSignal | undefined) {
  let stop: () => void = noop;
  let settle: (result: SpadeHttpResult["result"]) => void = noop;
  let cancelTimer: () => void = noop;
  const result = new Promise<SpadeHttpResult["result"]>((resolve, reject) => {
    settle = resolve;
    const connection = client.connectionState();
    const unsubscribe = client.onMessage((message) => {
      if (message.type === "spade.http.result" && message.requestId === requestId)
        resolve(message.result);
    });
    const dropped = connection.subscribe(() => {
      if (connection.getSnapshot() !== "ready")
        resolve(uploadLost("The connection dropped before Spade answered."));
    });
    const moved = onSocketMove(client, () =>
      resolve(uploadLost("The connection moved before Spade answered.")),
    );
    const aborted = () => reject(signal?.reason ?? new Error("aborted"));
    signal?.addEventListener("abort", aborted, { once: true });
    stop = () => {
      unsubscribe();
      dropped();
      moved();
      cancelTimer();
      signal?.removeEventListener("abort", aborted);
    };
  });
  // Unobserved until the open arrives; a refusal before it never reads this.
  result.catch(() => {});
  return {
    result,
    stop: () => stop(),
    /** Start the wait for the result: past `delay`, the upload is lost. */
    arm(delay: number, later: SpadeLater) {
      cancelTimer = later(delay, () =>
        settle(uploadLost("Spade didn't answer the upload in time.")),
      );
    },
  };
}

async function sendParts(client: SpadeHttpOwner, requestId: string, parts: readonly string[]) {
  for (const [index, body] of parts.entries()) {
    if (index % partsPerTurn === 0) await nextTask();
    client.send({ type: "spade.http.part", requestId, index, body });
  }
}

async function finish(
  client: SpadeHttpOwner,
  requestId: string,
  result: SpadeHttpResult["result"],
  options: { requestId: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<SpadeAnswer | "gone"> {
  if (result.kind === "error") return result;
  const pieces = [result.body];
  for (let index = 1; index < (result.parts ?? 1); index++) {
    const chunk = await client.request({ type: "spade.http.read", requestId, index }, options);
    if (chunk.gone) return "gone";
    pieces.push(chunk.body);
  }
  return {
    kind: "response",
    status: result.status,
    body: pieces.join(""),
    encoding: result.encoding,
    contentType: result.contentType,
  };
}
