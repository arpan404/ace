import type { ClientApi } from "@ace/client";
import type { SpadeExchange } from "@ace/client/spade-http";
import { maxSpadeRequestBytes, type SpadeMethod } from "@ace/protocol";
import { spadeRefusal, SpadeRequestError, type SpadeFollowLink } from "@ace/ui-core/spade-chat";
import { spadeTransport, SpadeTransport, type SpadeBody } from "./spade-transport.ts";

/**
 * Spade's local API: straight to Spade in the desktop app (ADR 0123), else through the daemon
 * (`spade.http`, ADR 0121) with large bodies in parts and long answers in pieces. Spade owns
 * the bodies' shape, so callers parse them with `@ace/ui-core/spade-chat`.
 */

export { SpadeRequestError };

/** A connection, or the transport over it (`spadeTransport`). */
export type SpadeTarget = ClientApi | SpadeTransport;
const transportOf = (target: SpadeTarget) =>
  target instanceof SpadeTransport ? target : spadeTransport(target);

/** Uploads with images may be tens of megabytes: give them the time a slow link needs. */
const uploadTimeoutMs = 5 * 60_000;

/** One exchange, resolving with Spade's answer on 2xx (in its encoding) and throwing otherwise. */
async function spadeAnswer(
  target: SpadeTarget,
  exchange: SpadeExchange,
  signal: AbortSignal | undefined,
): Promise<{ body: SpadeBody; contentType: string | undefined }> {
  const large = (exchange.body?.length ?? 0) > maxSpadeRequestBytes;
  const answer = await transportOf(target).exchange(exchange, {
    signal,
    ...(large ? { timeoutMs: uploadTimeoutMs } : {}),
  });
  if (answer.kind === "error") throw new SpadeRequestError(answer.message, undefined, answer.code);
  if (answer.status < 200 || answer.status > 299)
    throw new SpadeRequestError(
      spadeRefusal(answer.status, "text" in answer.body ? answer.body.text : ""),
      answer.status,
    );
  return answer;
}

/** One request with a JSON body; resolves with Spade's text answer on 2xx and throws otherwise. */
export async function spadeHttp(
  client: SpadeTarget,
  method: SpadeMethod,
  path: string,
  options: { body?: unknown; signal?: AbortSignal | undefined } = {},
): Promise<string> {
  const answer = await spadeAnswer(
    client,
    {
      method,
      path,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    options.signal,
  );
  if ("text" in answer.body) return answer.body.text;
  throw new SpadeRequestError("Spade answered with something other than text.");
}

/** A binary answer (an image) as a Blob of Spade's content type. */
export async function spadeBlob(
  client: SpadeTarget,
  path: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const answer = await spadeAnswer(client, { method: "GET", path }, signal);
  const type = answer.contentType ?? "application/octet-stream";
  const { body } = answer;
  if ("text" in body) return new Blob([body.text], { type });
  if ("bytes" in body) return new Blob([body.bytes.slice()], { type });
  const binary = atob(body.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
}

/** A conversation's live streams and history reads, by the transport's way. */
export function followLink(transport: SpadeTransport): SpadeFollowLink {
  return {
    canOpen: () => transport.canOpen(),
    onOpenable: (listener) => transport.onOpenable(listener),
    open: (path, sink) => transport.open(path, sink),
    read: (path) => spadeHttp(transport, "GET", path),
  };
}

/** A message's body as Spade takes it: images as `{data}` with their base64. */
export function spadeBody(message: { text: string; images: readonly { data: string }[] }) {
  return {
    text: message.text,
    ...(message.images.length ? { images: message.images.map(({ data }) => ({ data })) } : {}),
  };
}

/** A path segment from an id Spade gave us. */
export const segment = (id: string) => encodeURIComponent(id);
