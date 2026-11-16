import { ClientError } from "@ace/client";
import type { Interaction, InteractionRequest } from "@ace/protocol";
import { useCallback, useEffect, useState } from "react";
import { useClient } from "./context.ts";

/**
 * An interaction's request as a card can show it (ADR 0157). `whole`: it came whole with its
 * thread. A summarized one (`truncated`) is `loading` until it is read whole, then `loaded`, or
 * `failed` with why (the daemon's code, or the client's: `offline`, `timeout`, `stale`…).
 */
export type WholeRequest =
  | { status: "whole"; request: InteractionRequest }
  | { status: "loading" }
  | { status: "loaded"; request: InteractionRequest; version: string; retry(): void }
  | { status: "failed"; code: string; retry(): void };

type Outcome =
  | { status: "loaded"; request: InteractionRequest; version: string }
  | { status: "failed"; code: string };

/**
 * The whole request of `interaction`, read from the daemon while a card for it is shown when its
 * thread sent it summarized. Nothing is read ahead or kept once the card is gone: requests too
 * large to send are rare. Undefined while there is no interaction.
 */
export function useWholeRequest(
  threadId: string,
  interaction: Interaction | undefined,
): WholeRequest | undefined {
  const client = useClient();
  const summarized = interaction?.truncated !== undefined;
  const interactionId = interaction?.id ?? "";
  const [attempt, setAttempt] = useState(0);
  // Which read an outcome answers: another request (or a retry) never shows an earlier one's. A
  // request opened again under the same id shows as another summary; the daemon refuses a yes to
  // it under the old version either way. Summaries are small, so naming one by its JSON is cheap.
  const summary = summarized ? JSON.stringify([interaction.truncated, interaction.request]) : "";
  const read = `${threadId}\n${interactionId}\n${summary}\n${attempt}`;
  const [outcome, setOutcome] = useState<{ read: string; outcome: Outcome }>();
  useEffect(() => {
    if (!summarized) return;
    const abort = new AbortController();
    const settle = (next: Outcome) => {
      if (!abort.signal.aborted) setOutcome({ read, outcome: next });
    };
    client.readInteraction({ threadId, interactionId }, { signal: abort.signal }).then(
      ({ request, version }) => settle({ status: "loaded", request, version }),
      (error: unknown) => settle({ status: "failed", code: failure(error) }),
    );
    return () => abort.abort();
  }, [client, read, summarized, threadId, interactionId]);
  const retry = useCallback(() => setAttempt((at) => at + 1), []);
  if (!interaction) return undefined;
  if (!summarized) return { status: "whole", request: interaction.request };
  const current = outcome?.read === read ? outcome.outcome : undefined;
  if (!current) return { status: "loading" };
  // Loaded, `retry` reads it again: the daemon said the request changed since (`request_not_read`).
  return { ...current, retry };
}

function failure(error: unknown): string {
  if (!(error instanceof ClientError)) return "unknown";
  return error.code === "daemon" ? error.message : error.code;
}
