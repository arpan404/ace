import { CliOperation } from "@ace/protocol";
import type { Client } from "@ace/client";
import { option, validateArgs, type Args } from "./args.ts";
import { key } from "./mutations.ts";
import { mutationResult } from "./io.ts";
import { CliFailure } from "./output.ts";
export async function controlCommand(args: Args, client: Client, signal: AbortSignal) {
  const command = args.words[0];
  if (command === "kill-all") {
    validateArgs(args, ["thread", "provider", "project", "idempotency-key"], 1);
    const id = key(args);
    const operation = CliOperation.parse({
      op: "process.kill_all",
      threadId: option(args, "thread"),
      provider: option(args, "provider"),
      project: option(args, "project"),
      key: id,
    });
    const response = await client.request({ type: "cli.request", operation }, { signal });
    if (!response.result.ok)
      throw new CliFailure(
        response.result.code === "unavailable" ? "uncertain" : "refused",
        response.result.code ?? "Kill refused",
      );
    return mutationResult(args, { ...response.result, idempotencyKey: id });
  }
  throw new CliFailure("refused", `Unknown control command ${command ?? ""}.`);
}
