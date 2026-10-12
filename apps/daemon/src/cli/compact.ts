import type { Client } from "@ace/client";
import type { StorageRequest } from "@ace/protocol";
import { option, validateArgs, type Args } from "./args.ts";
import { mutationResult } from "./io.ts";
import { CliFailure } from "./output.ts";
import { storageRequest } from "./retention-request.ts";

/** `ace clean --compact [--abandon ID]`; the daemon owns the compaction journal. */
export async function compactCommand(args: Args, client: Client, signal: AbortSignal) {
  validateArgs(args, ["compact", "abandon"], 1);
  const abandon = option(args, "abandon");
  const operation: StorageRequest["operation"] = abandon
    ? { op: "cleanup.compactAbandon", compactionId: abandon }
    : { op: "cleanup.compact" };
  const data = await storageRequest(client, operation, signal);
  if (data.kind !== "compaction")
    throw new CliFailure("uncertain", "The daemon returned an unexpected storage result.");
  const done = ["complete", "abandoned"].includes(data.compaction.state);
  await mutationResult(args, data.compaction, done ? "ok" : "uncertain");
}
