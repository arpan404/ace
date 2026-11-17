import type { Client } from "@ace/client";
import type { StorageRequest } from "@ace/protocol";
import { option, type Args } from "./args.ts";
import { CliFailure } from "./output.ts";
import { printResult } from "./clean.ts";
import { storageRequest } from "./retention-request.ts";
import { compactionLines } from "./render/storage.ts";

/** `ace storage compact [--abandon ID]` (`ace clean --compact`); the daemon keeps the journal. */
export async function compactCommand(args: Args, client: Client, signal: AbortSignal) {
  const abandon = option(args, "abandon");
  const operation: StorageRequest["operation"] = abandon
    ? { op: "cleanup.compactAbandon", compactionId: abandon }
    : { op: "cleanup.compact" };
  const data = await storageRequest(client, operation, signal);
  if (data.kind !== "compaction")
    throw new CliFailure("uncertain", "The daemon returned an unexpected storage result.");
  const done = ["complete", "abandoned"].includes(data.compaction.state);
  await printResult(
    args,
    data.compaction,
    { human: compactionLines, quiet: (value) => [value.id] },
    done ? "ok" : "uncertain",
  );
}
