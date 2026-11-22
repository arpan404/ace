import type { ClientCore } from "@ace/client";
import { spadeExchange } from "@ace/client/spade-http";
import type { SpadeMethod } from "@ace/protocol";
import { spadeProblemNeeds, spadeRefusal, SpadeRequestError } from "@ace/ui-core/spade-chat";

/* One request to Spade through the daemon (ADR 0121), as every Spade module on the phone asks. */

/** A path segment from an id Spade gave us. */
export const segment = (id: string) => encodeURIComponent(id);

/** One request to Spade through the daemon: its text on 2xx, else a `SpadeRequestError`. */
export async function spadeText(
  owner: ClientCore,
  id: () => string,
  method: SpadeMethod,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  /** How long an upload may take; the transport's default otherwise. */
  timeoutMs?: number,
): Promise<string> {
  const answer = await spadeExchange(
    owner,
    { method, path, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    { id, signal, ...(timeoutMs ? { timeoutMs } : {}) },
  );
  if (answer.kind === "error") throw new SpadeRequestError(answer.message, undefined, answer.code);
  const text = answer.encoding === "text" ? answer.body : "";
  if (answer.status < 200 || answer.status > 299)
    throw new SpadeRequestError(
      spadeRefusal(answer.status, text),
      answer.status,
      undefined,
      spadeProblemNeeds(text),
    );
  return text;
}
