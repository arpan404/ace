import { CliOperation } from "@ace/protocol";
import type { Client } from "@ace/client";
import { option, timeoutMs, validateArgs, type Args } from "./args.ts";
import { key } from "./mutations.ts";
import { result, mutationResult } from "./io.ts";
import { CliFailure } from "./output.ts";
import { hostConnection } from "./connection.ts";
import { accessRequest } from "../client-access.ts";
import { setTimeout as delay } from "node:timers/promises";
import { ShutdownAdmission, readShutdownReceipt } from "../shutdown-receipt.ts";
export async function stopCommand(args: Args, home: string) {
  validateArgs(args, [], 1);
  const connection = hostConnection(home);
  const signal = AbortSignal.timeout(timeoutMs(args));
  const admission = ShutdownAdmission.parse(
    await accessRequest(connection.origin, "/v1/stop", { method: "POST", token: connection.token }),
  );
  while (!signal.aborted) {
    try {
      const receipt = readShutdownReceipt(home);
      if (receipt?.id === admission.receiptId && receipt.state !== "pending")
        return result(
          args,
          { stopped: receipt.state === "succeeded", receipt },
          receipt.state === "succeeded" ? "ok" : "failed",
        );
    } catch {
      throw new CliFailure(
        "uncertain",
        "Shutdown accepted but its completion receipt is unavailable",
        admission,
      );
    }
    await delay(100, undefined, { signal }).catch(() => {});
  }
  throw new CliFailure(
    "uncertain",
    "Shutdown accepted but cleanup completion is unconfirmed",
    admission,
  );
}
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
