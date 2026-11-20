import { randomUUID } from "node:crypto";
import type { Client } from "@ace/client";
import type { SpadeHttpResult } from "@ace/protocol";
import { CliFailure } from "./output.ts";
import type { SpadeCall } from "./spade-bots.ts";

type SpadeError = Extract<SpadeHttpResult["result"], { kind: "error" }>;

/** Why the daemon didn't forward a request, as one sentence and the next step. */
function spadeFailure(error: SpadeError): CliFailure {
  if (error.code === "hidden")
    return new CliFailure("refused", "Spade is hidden: Settings › Beta has it off.", undefined, {
      code: "turned_off",
      hint: "Turn it on with ace spade on.",
    });
  if (error.code === "unavailable")
    return new CliFailure("refused", "Spade isn't running.", undefined, {
      code: "refused",
      hint: "See why with ace spade status.",
    });
  if (error.code === "forbidden")
    return new CliFailure("refused", "This device may not talk to Spade.", undefined, {
      code: "forbidden",
    });
  return new CliFailure("failed", `Spade didn't answer: ${error.message}`, undefined, {
    code: "failed",
    hint: "See how Spade is with ace spade status.",
  });
}

/** Spade's answer as it came: its status and body. */
export interface SpadeAnswer {
  readonly status: number;
  readonly body: string;
}

/** A Spade API call that answers with any status; only a failure to reach Spade throws. */
export type SpadeExchange = (
  method: Parameters<SpadeCall>[0],
  path: string,
  body?: unknown,
) => Promise<SpadeAnswer>;

/** One Spade API exchange through the daemon's `spade.http` (ADR 0121). */
export async function spadeExchanger(client: Client, signal: AbortSignal): Promise<SpadeExchange> {
  const { spadeExchange } = await import("@ace/client/spade-http");
  return async (method, path, body) => {
    const answer = await spadeExchange(
      client,
      { method, path, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      { id: () => randomUUID(), signal },
    );
    if (answer.kind === "error") throw spadeFailure(answer);
    return { status: answer.status, body: answer.body };
  };
}

/** A non-2xx answer as the failure the CLI reports. */
export function answerFailure(answer: SpadeAnswer): CliFailure {
  const said = /"(?:error|message)"\s*:\s*"([^"]{1,300})"/.exec(answer.body)?.[1];
  return new CliFailure(
    answer.status === 404 ? "refused" : "failed",
    said ? `Spade said: ${said}` : `Spade answered ${answer.status}.`,
    undefined,
    { code: answer.status === 404 ? "not_found" : "failed" },
  );
}

/** A call that answers with Spade's body, every non-2xx answer a failure. */
export function callOf(exchange: SpadeExchange): SpadeCall {
  return async (method, path, body) => {
    const answer = await exchange(method, path, body);
    if (answer.status >= 200 && answer.status < 300) return answer.body;
    throw answerFailure(answer);
  };
}

/** One Spade API call through the daemon's `spade.http` (ADR 0121). */
export async function spadeCaller(client: Client, signal: AbortSignal): Promise<SpadeCall> {
  return callOf(await spadeExchanger(client, signal));
}
