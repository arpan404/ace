import type { StorageApply, StoragePlan, StorageRequest } from "@ace/protocol";
import { ClientError, type Client } from "@ace/client";
import { CliFailure, type Outcome } from "./output.ts";
import type { PlanOperation } from "./clean-options.ts";

export type ApplyReceipt = StorageApply & { planId: string; revision: string };

/** A lost apply acknowledgement carries the plan identity so it can be read or retried. */
export async function storageRequest(
  client: Client,
  operation: StorageRequest["operation"],
  signal: AbortSignal,
) {
  const evidence =
    operation.op === "cleanup.apply"
      ? { planId: operation.planId, revision: operation.revision }
      : undefined;
  try {
    const response = await client.request({ type: "storage.request", operation }, { signal });
    const data = response.result;
    if (data.kind === "error")
      throw new CliFailure(
        ["forbidden", "not_found", "invalid_request"].includes(data.code) ? "refused" : "uncertain",
        data.message,
        evidence,
      );
    return data;
  } catch (error) {
    if (evidence && (signal.aborted || error instanceof ClientError))
      throw new CliFailure(
        "uncertain",
        "Cleanup acknowledgement unavailable. Read clean status PLAN_ID or apply the same plan and revision again.",
        evidence,
      );
    throw error;
  }
}

export async function planCleanup(
  client: Client,
  operation: PlanOperation,
  signal: AbortSignal,
): Promise<StoragePlan> {
  const data = await storageRequest(client, operation, signal);
  if (data.kind !== "plan") throw new CliFailure("uncertain", "The daemon returned no plan");
  return data.plan;
}

export async function applyCleanup(
  client: Client,
  plan: { planId: string; revision: string },
  signal: AbortSignal,
): Promise<ApplyReceipt> {
  const data = await storageRequest(client, { op: "cleanup.apply", ...plan }, signal);
  if (data.kind !== "apply")
    throw new CliFailure("uncertain", "The daemon returned no cleanup receipt", plan);
  return { ...data.apply, ...plan };
}

export function applyOutcome(apply: StorageApply): Outcome {
  return apply.state === "complete" ? "ok" : apply.state === "stale" ? "refused" : "uncertain";
}
