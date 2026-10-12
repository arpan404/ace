import { StorageRequest } from "@ace/protocol";
import type { Client } from "@ace/client";
import { validateArgs, option, type Args } from "./args.ts";
import { print } from "./io.ts";
import { CliFailure } from "./output.ts";
import { planOperation, planOptions } from "./clean-options.ts";
import { cleanCommand, printPlan, printReceipt, terminalConfirmation } from "./clean.ts";
import { applyCleanup, planCleanup, storageRequest } from "./retention-request.ts";
import { compactCommand } from "./compact.ts";

/** The daemon owns inventory, protection rules, reviewed identities and all effects. */
export async function retentionCommand(args: Args, client: Client, signal: AbortSignal) {
  const clean = args.words[0] === "clean";
  // Compaction is not a cleanup plan; it dispatches before the plan/apply flow.
  if (clean && args.flags.compact === true) return compactCommand(args, client, signal);
  const verb = args.words[1] ?? (clean ? "clean" : "usage");
  if (verb === "clean") return cleanCommand(args, client, signal, terminalConfirmation());
  if (verb === "usage") {
    validateArgs(args, [], 1, 2);
    const data = await storageRequest(client, { op: "storage.usage" }, signal);
    if (data.kind !== "usage") throw new CliFailure("uncertain", "The daemon returned no usage");
    await print(args, data.usage);
  } else if (verb === "plan") {
    validateArgs(args, planOptions, 2);
    await printPlan(args, await planCleanup(client, planOperation(args), signal));
  } else if (verb === "apply") {
    validateArgs(args, ["revision"], 3);
    const plan = StorageRequest.shape.operation.parse({
      op: "cleanup.apply",
      planId: args.words[2],
      revision: option(args, "revision"),
    });
    if (plan.op !== "cleanup.apply") throw new CliFailure("refused", "Invalid cleanup plan");
    const receipt = await applyCleanup(
      client,
      { planId: plan.planId, revision: plan.revision },
      signal,
    );
    await printReceipt(args, receipt, receipt);
  } else if (verb === "status") {
    validateArgs(args, [], 3);
    const operation = StorageRequest.shape.operation.parse({
      op: "cleanup.status",
      planId: args.words[2],
    });
    const data = await storageRequest(client, operation, signal);
    if (data.kind !== "apply") throw new CliFailure("uncertain", "The daemon returned no status");
    await printReceipt(args, data.apply, data.apply);
  } else
    throw new CliFailure("refused", "Use storage usage|plan|apply|status or clean [apply|status]");
}
