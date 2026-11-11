import type { ClientApi } from "@ace/client";
import type { SpadeMethod } from "@ace/protocol";
import { spadeProblem } from "@ace/ui-core/spade-chat";

/**
 * Spade's local API through the daemon (`spade.http`, ADR 0117). Bodies go as text and come
 * back as text; Spade owns their shape, so callers parse them with `@ace/ui-core/spade-chat`.
 */

/** Spade refused, or the daemon couldn't reach it. `status` is Spade's, when it answered. */
export class SpadeRequestError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "SpadeRequestError";
    this.status = status;
  }
}

/** What a refusal says to the person, by Spade's status where its own words would be vague. */
function refusal(status: number, body: string): string {
  if (status === 402) return "Today's spending cap is reached. Spade will answer again tomorrow.";
  return spadeProblem(body) ?? `Spade answered ${status}.`;
}

/** One request; resolves with Spade's body on a 2xx answer and throws otherwise. */
export async function spadeHttp(
  client: ClientApi,
  method: SpadeMethod,
  path: string,
  options: { body?: unknown; signal?: AbortSignal | undefined } = {},
): Promise<string> {
  const reply = await client.request(
    {
      type: "spade.http",
      method,
      path,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    options.signal ? { signal: options.signal } : {},
  );
  const { result } = reply;
  if (result.kind === "error") throw new SpadeRequestError(result.message);
  if (result.status < 200 || result.status > 299)
    throw new SpadeRequestError(refusal(result.status, result.body), result.status);
  return result.body;
}

/** A path segment from an id Spade gave us. */
export const segment = (id: string) => encodeURIComponent(id);
