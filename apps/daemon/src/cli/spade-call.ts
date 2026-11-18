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

/** One Spade API call through the daemon's `spade.http` (ADR 0121). */
export async function spadeCaller(client: Client, signal: AbortSignal): Promise<SpadeCall> {
  const { spadeExchange } = await import("@ace/client/spade-http");
  return async (method, path, body) => {
    const answer = await spadeExchange(
      client,
      { method, path, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      { id: () => randomUUID(), signal },
    );
    if (answer.kind === "error") throw spadeFailure(answer);
    if (answer.status >= 200 && answer.status < 300) return answer.body;
    const said = /"(?:error|message)"\s*:\s*"([^"]{1,300})"/.exec(answer.body)?.[1];
    throw new CliFailure(
      answer.status === 404 ? "refused" : "failed",
      said ? `Spade said: ${said}` : `Spade answered ${answer.status}.`,
      undefined,
      { code: answer.status === 404 ? "not_found" : "failed" },
    );
  };
}
