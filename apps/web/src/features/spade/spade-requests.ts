import type { ClientApi } from "@ace/client";
import type { SpadeExchange } from "@ace/client/spade-http";
import { maxSpadeRequestBytes, type SpadeMethod } from "@ace/protocol";
import { spadeProblem, spadeProblemNeeds } from "@ace/ui-core/spade-chat";
import { spadeTransport, SpadeTransport, type SpadeBody } from "./spade-transport.ts";

/**
 * Spade's local API: straight to Spade in the desktop app (ADR 0123), else through the daemon
 * (`spade.http`, ADR 0121) with large bodies in parts and long answers in pieces. Spade owns
 * the bodies' shape, so callers parse them with `@ace/ui-core/spade-chat`.
 */

/** Spade refused, or the daemon couldn't reach it. `status` is Spade's, when it answered. */
export class SpadeRequestError extends Error {
  readonly status: number | undefined;
  /** The daemon's code when it, not Spade, answered (`failed`: no answer came back). */
  readonly code: string | undefined;
  /** What Spade said the request still needs, such as `client_id` or `ace_account`. */
  readonly needs: string | undefined;
  constructor(message: string, status?: number, code?: string, needs?: string) {
    super(message);
    this.name = "SpadeRequestError";
    this.status = status;
    this.code = code;
    this.needs = needs;
  }
  /** The request may have reached Spade: no answer came back to say either way. */
  get unanswered(): boolean {
    return this.code === "failed";
  }
}

/** What a refusal says to the person, by Spade's status where its own words would be vague. */
function refusal(status: number, body: string): string {
  // A cap's refusal says which cap and until when, in Spade's own words (ADR 0135).
  const words = spadeProblem(body);
  if (status === 402)
    return words ?? "Today's spending cap is reached. Spade will answer again tomorrow.";
  return words ?? `Spade answered ${status}.`;
}

/** A connection, or the transport over it (`spadeTransport`). */
export type SpadeTarget = ClientApi | SpadeTransport;
const transportOf = (target: SpadeTarget) =>
  target instanceof SpadeTransport ? target : spadeTransport(target);

/**
 * Uploads with documents may be hundreds of megabytes: five minutes, and a second more for
 * every megabyte, the time a slow link needs.
 */
const uploadTimeoutMs = (length: number) => 5 * 60_000 + Math.ceil(length / 1_000_000) * 1_000;

/** One exchange, resolving with Spade's answer on 2xx (in its encoding) and throwing otherwise. */
async function spadeAnswer(
  target: SpadeTarget,
  exchange: SpadeExchange,
  signal: AbortSignal | undefined,
): Promise<{ body: SpadeBody; contentType: string | undefined }> {
  const length = exchange.body?.length ?? 0;
  const answer = await transportOf(target).exchange(exchange, {
    signal,
    ...(length > maxSpadeRequestBytes ? { timeoutMs: uploadTimeoutMs(length) } : {}),
  });
  if (answer.kind === "error") throw new SpadeRequestError(answer.message, undefined, answer.code);
  if (answer.status < 200 || answer.status > 299) {
    const text = "text" in answer.body ? answer.body.text : "";
    throw new SpadeRequestError(
      refusal(answer.status, text),
      answer.status,
      undefined,
      spadeProblemNeeds(text),
    );
  }
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

/** A message's body as Spade takes it: images as `{data}`, documents as `{name, data}`, a voice
 * recording with its transcript (the message's words). */
export function spadeBody(message: {
  text: string;
  images: readonly { data: string }[];
  documents?: readonly { name: string; data: string }[] | undefined;
  voice?: { data: string; mediaType: string } | undefined;
}) {
  const documents = message.documents ?? [];
  return {
    text: message.text,
    ...(message.images.length ? { images: message.images.map(({ data }) => ({ data })) } : {}),
    ...(documents.length ? { files: documents.map(({ name, data }) => ({ name, data })) } : {}),
    ...(message.voice
      ? {
          voice: {
            data: message.voice.data,
            media_type: message.voice.mediaType,
            transcript: message.text,
          },
        }
      : {}),
  };
}

/** A path segment from an id Spade gave us. */
export const segment = (id: string) => encodeURIComponent(id);
