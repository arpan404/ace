import {
  maxSpadePartChars,
  maxSpadeRequestBytes,
  type SpadeBodyEncoding,
  type SpadeHttpResult,
  type SpadeMethod,
} from "@ace/protocol";
import type { ClientApi } from "./api.ts";

/*
 * One exchange with Spade through the daemon (ADR 0117, `spade.http`): a body larger than one
 * message goes in `spade.http.part`s, and a long answer comes back in pieces read with
 * `spade.http.read`. Bodies are text or base64 both ways; Spade owns what they mean.
 */

/** What an exchange needs from the connection. */
export type SpadeHttpOwner = Pick<ClientApi, "request" | "send">;

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

/** Let queued work run, so a request already handed to the client is on the socket first. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Parts sent before letting the socket drain a little. */
const partsPerTurn = 16;

/**
 * Send one request and read its whole answer. A body over one message's room goes in parts
 * after the request (the daemon drops a part for a request it hasn't seen, so each part waits
 * until the request is out). A long answer's pieces are read in order; if the daemon no longer
 * holds them (`gone`), the request is sent once more.
 */
export async function spadeExchange(
  client: SpadeHttpOwner,
  exchange: SpadeExchange,
  options: { id(): string; signal?: AbortSignal | undefined; timeoutMs?: number | undefined },
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
  if (parts) {
    // A refusal can arrive before every part is out; the reply says why either way.
    const sent = sendParts(client, requestId, parts).catch(() => undefined);
    const [result] = await Promise.all([reply, sent]);
    return finish(client, requestId, result.result, requestOptions);
  }
  return finish(client, requestId, (await reply).result, requestOptions);
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
