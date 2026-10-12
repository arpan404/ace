import type { Client } from "@ace/client";
import { option, validateArgs, type Args } from "./args.ts";
import { TriggerVariables } from "@ace/protocol";
import { result } from "./io.ts";
import { key } from "./work.ts";
import { CliFailure } from "./output.ts";
export async function automationCommand(args: Args, client: Client, signal: AbortSignal) {
  const verb = args.words[1];
  validateArgs(args, ["variables", "idempotency-key"], verb === "run" ? 3 : 2);
  const response =
    verb === "list"
      ? await client.request({ type: "automation.list" }, { signal })
      : verb === "run" && args.words[2]
        ? await client.request(
            {
              type: "automation.run",
              id: args.words[2],
              variables: TriggerVariables.parse(JSON.parse(option(args, "variables") ?? "{}")),
            },
            { signal, requestId: key(args) },
          )
        : undefined;
  if (!response)
    throw new CliFailure("refused", "Usage: ace automation list|run ID [--variables JSON]");
  if (!response.ok) throw new CliFailure("refused", response.error ?? "Automation refused");
  await result(args, response);
}
