import type { ClientApi } from "@ace/client";
import { spadeExchange, type SpadeExchange } from "@ace/client/spade-http";
import { maxSpadeRequestBytes, type SpadeMethod } from "@ace/protocol";
import { spadeProblem } from "@ace/ui-core/spade-chat";

/**
 * Spade's local API through the daemon (`spade.http`, ADR 0121), large bodies in parts and long
 * answers in pieces (`@ace/client/spade-http`). Spade owns the bodies' shape, so callers parse
 * them with `@ace/ui-core/spade-chat`.
 */

/** Spade refused, or the daemon couldn't reach it. `status` is Spade's, when it answered. */
export class SpadeRequestError extends Error {
  readonly status: number | undefined;
  /** The daemon's code when it, not Spade, answered (`failed`: no answer came back). */
  readonly code: string | undefined;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "SpadeRequestError";
    this.status = status;
    this.code = code;
  }
  /** The request may have reached Spade: no answer came back to say either way. */
  get unanswered(): boolean {
    return this.code === "failed";
  }
}

/** What a refusal says to the person, by Spade's status where its own words would be vague. */
function refusal(status: number, body: string): string {
  if (status === 402) return "Today's spending cap is reached. Spade will answer again tomorrow.";
  return spadeProblem(body) ?? `Spade answered ${status}.`;
}

const ids = () => crypto.randomUUID();
/** Uploads with images may be tens of megabytes: give them the time a slow link needs. */
const uploadTimeoutMs = 5 * 60_000;

/** One exchange, resolving with Spade's answer on 2xx (in its encoding) and throwing otherwise. */
async function spadeAnswer(
  client: ClientApi,
  exchange: SpadeExchange,
  signal: AbortSignal | undefined,
): Promise<{ body: string; encoding: "text" | "base64"; contentType: string | undefined }> {
  const large = (exchange.body?.length ?? 0) > maxSpadeRequestBytes;
  const answer = await spadeExchange(client, exchange, {
    id: ids,
    signal,
    ...(large ? { timeoutMs: uploadTimeoutMs } : {}),
  });
  if (answer.kind === "error") throw new SpadeRequestError(answer.message, undefined, answer.code);
  if (answer.status < 200 || answer.status > 299)
    throw new SpadeRequestError(
      refusal(answer.status, answer.encoding === "text" ? answer.body : ""),
      answer.status,
    );
  return answer;
}

/** One request with a JSON body; resolves with Spade's text answer on 2xx and throws otherwise. */
export async function spadeHttp(
  client: ClientApi,
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
  return answer.body;
}

/** A binary answer (an image) as a Blob of Spade's content type. */
export async function spadeBlob(
  client: ClientApi,
  path: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const answer = await spadeAnswer(client, { method: "GET", path }, signal);
  const type = answer.contentType ?? "application/octet-stream";
  if (answer.encoding === "text") return new Blob([answer.body], { type });
  const binary = atob(answer.body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
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
