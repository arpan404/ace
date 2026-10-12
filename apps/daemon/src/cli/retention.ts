import { StorageRequest, StorageKind, StorageRetention } from "@ace/protocol";
import { ClientError, type Client } from "@ace/client";
import { z } from "zod";
import { option, validateArgs, type Args } from "./args.ts";
import { print, mutationResult, result } from "./io.ts";
import { CliFailure } from "./output.ts";

/** The daemon owns inventory, protection rules, reviewed identities and all effects. */
export async function retentionCommand(args: Args, client: Client, signal: AbortSignal) {
  const verb = args.words[1] ?? (args.words[0] === "clean" ? "plan" : "usage");
  let operation: StorageRequest["operation"];
  if (verb === "usage") {
    validateArgs(args, [], 1, 2);
    operation = { op: "storage.usage" };
  } else if (verb === "plan") {
    validateArgs(args, ["kinds", "retention", "force-items"], 1, 2);
    operation = {
      op: "cleanup.plan",
      ...(option(args, "kinds")
        ? { kinds: z.array(StorageKind).min(1).max(6).parse(option(args, "kinds")?.split(",")) }
        : {}),
      ...(option(args, "retention")
        ? { retention: StorageRetention.parse(JSON.parse(option(args, "retention") ?? "")) }
        : {}),
      forceItems: z
        .array(z.string().min(1).max(256))
        .max(256)
        .parse(JSON.parse(option(args, "force-items") ?? "[]")),
    };
  } else if (verb === "apply") {
    validateArgs(args, ["revision"], 3);
    operation = StorageRequest.shape.operation.parse({
      op: "cleanup.apply",
      planId: args.words[2],
      revision: option(args, "revision"),
    });
  } else if (verb === "status") {
    validateArgs(args, [], 3);
    operation = StorageRequest.shape.operation.parse({
      op: "cleanup.status",
      planId: args.words[2],
    });
  } else
    throw new CliFailure(
      "refused",
      "Use storage usage|plan|apply|status or clean [plan|apply|status]",
    );
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
    if (data.kind === "apply") {
      const receipt = { ...data.apply, ...evidence };
      try {
        await result(
          args,
          receipt,
          data.apply.state === "complete"
            ? "ok"
            : data.apply.state === "stale"
              ? "refused"
              : "uncertain",
        );
      } catch {
        throw new CliFailure(
          "uncertain",
          "Cleanup result could not be printed. Read the recorded plan status.",
          receipt,
        );
      }
    } else if (data.kind === "plan") await mutationResult(args, data.plan);
    else await print(args, data.usage);
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
