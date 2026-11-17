import { readFile } from "node:fs/promises";
import type { Client } from "@ace/client";
import { option, type Args } from "./args.ts";
import { emit } from "./io.ts";
import { CliFailure, usageFailure } from "./output.ts";
import { planOperation } from "./clean-options.ts";
import { printPlan, printResult } from "./clean.ts";
import { applyCleanup, applyOutcome, planCleanup, storageRequest } from "./retention-request.ts";
import { receiptLine, usageLines } from "./render/storage.ts";

/**
 * `ace storage usage|plan|apply|status` (ADR 0176 §7). The daemon owns the inventory, the
 * protection rules, the reviewed plan identities and every effect; these only ask and print.
 */

export async function storageUsage(args: Args, client: Client, signal: AbortSignal) {
  const data = await storageRequest(client, { op: "storage.usage", force: true }, signal);
  if (data.kind !== "usage") throw new CliFailure("uncertain", "The daemon returned no usage.");
  await emit(args, data.usage, { human: usageLines, quiet: () => [] });
}

export async function storagePlan(args: Args, client: Client, signal: AbortSignal) {
  const operation = await planOperation(args, (path) => readFile(path, "utf8"));
  await printPlan(args, await planCleanup(client, operation, signal));
}

/** A plan id from the command line; the daemon checks that it names a plan. */
function planId(args: Args): string {
  const id = args.words[0];
  if (!id || id.length > 256)
    throw usageFailure("PLAN must be a plan id from ace storage plan.", { argument: "PLAN" });
  return id;
}

export async function storageApply(args: Args, client: Client, signal: AbortSignal) {
  const id = planId(args);
  const revision = option(args, "revision");
  if (!revision || !/^[a-f0-9]{64}$/.test(revision))
    throw usageFailure("--revision must be the revision the plan printed.", {
      code: revision ? "bad_argument" : "missing_argument",
      argument: "--revision",
      hint: `See it with ace storage plan, then ace storage apply ${id} --revision REVISION.`,
    });
  const receipt = await applyCleanup(client, { planId: id, revision }, signal);
  await printResult(
    args,
    receipt,
    { human: (value) => receiptLine(value), quiet: () => [] },
    applyOutcome(receipt),
  );
}

export async function storageStatus(args: Args, client: Client, signal: AbortSignal) {
  const data = await storageRequest(client, { op: "cleanup.status", planId: planId(args) }, signal);
  if (data.kind !== "apply") throw new CliFailure("uncertain", "The daemon returned no status.");
  await printResult(
    args,
    data.apply,
    { human: (value) => receiptLine(value), quiet: () => [] },
    applyOutcome(data.apply),
  );
}
