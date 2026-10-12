import { CliOperation } from "@ace/protocol";
import type { Client } from "@ace/client";
import { option, timeoutMs, validateArgs, type Args } from "./args.ts";
import { key } from "./work.ts";
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
  const verb = args.words[1];
  validateArgs(args, ["scope", "ttl", "project"], verb === "revoke" ? 3 : 2);
  if (verb === "enroll" && !option(args, "ttl"))
    throw new CliFailure("refused", "Enrollment requires --ttl, e.g. 1h");
  const operation = CliOperation.parse(
    verb === "enroll"
      ? {
          op: "mcp.enroll",
          scope: option(args, "scope") ?? "read",
          ttlMs: timeoutMs({ words: [], flags: { timeout: option(args, "ttl") ?? "1h" } }),
          project: option(args, "project"),
        }
      : { op: `mcp.${verb}`, id: args.words[2] },
  );
  const response = await client.request({ type: "cli.request", operation }, { signal });
  if (!response.result.ok)
    throw new CliFailure("refused", response.result.code ?? "MCP enrollment refused");
  if (verb === "enroll" && !args.flags.json && !args.flags.jq) {
    const { z } = await import("zod");
    const data = z
      .object({
        id: z.string(),
        expiresAt: z.number(),
        setup: z.string(),
        claude: z.string(),
        codex: z.string(),
      })
      .parse(response.result.data);
    return mutationResult(
      args,
      `Enrollment ${data.id}, expires ${new Date(data.expiresAt).toISOString()}\n\n${data.setup}\n\n${data.claude}\n\n# ~/.codex/config.toml\n${data.codex}`,
    );
  }
  return verb === "list"
    ? result(args, response.result.data)
    : mutationResult(args, response.result.data);
}
