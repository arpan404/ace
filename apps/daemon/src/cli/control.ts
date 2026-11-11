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
/** `--ttl` for a grant: minutes, hours or days (`30m`, `12h`, `30d`). */
function grantLifetimeMs(value: string): number {
  const match = /^(\d{1,4})(m|h|d)$/.exec(value);
  if (!match)
    throw new CliFailure("refused", "--ttl takes minutes, hours or days (30m, 12h, 30d), or never");
  const scale = match[2] === "d" ? 86_400_000 : match[2] === "h" ? 3_600_000 : 60_000;
  return Number(match[1]) * scale;
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
  validateArgs(args, ["scope", "allow", "ttl", "project", "name"], verb === "revoke" ? 3 : 2);
  const ttl = option(args, "ttl");
  if (verb === "enroll" && !ttl)
    throw new CliFailure("refused", "Enrollment requires --ttl, e.g. 1h, 30d or never");
  if (verb === "enroll" && option(args, "scope") && option(args, "allow"))
    throw new CliFailure("refused", "Pass --scope or --allow, not both");
  const list = (name: string) =>
    option(args, name)
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  const operation = CliOperation.parse(
    verb === "enroll"
      ? {
          op: "mcp.enroll",
          scope: option(args, "scope"),
          allow: list("allow"),
          ttlMs: ttl === "never" ? null : grantLifetimeMs(ttl ?? "1h"),
          projects: list("project"),
          name: option(args, "name"),
        }
      : { op: `mcp.${verb}`, id: args.words[2] },
  );
  const response = await client.request({ type: "cli.request", operation }, { signal });
  if (!response.result.ok) {
    if (verb === "revoke" && response.result.code === "not_found")
      throw new CliFailure(
        "refused",
        `No MCP enrollment ${args.words[2]}: it may have expired or been revoked already`,
      );
    throw new CliFailure("refused", response.result.code ?? "MCP enrollment refused");
  }
  if (verb === "revoke" && !args.flags.json && !args.flags.jq)
    return mutationResult(args, `Revoked MCP enrollment ${args.words[2]}`);
  if (verb === "enroll" && !args.flags.json && !args.flags.jq) {
    const { z } = await import("zod");
    const data = z
      .object({
        id: z.string(),
        expiresAt: z.number().nullable(),
        setup: z.string(),
        claude: z.string(),
        codex: z.string(),
      })
      .parse(response.result.data);
    return mutationResult(
      args,
      `Enrollment ${data.id}, ${data.expiresAt === null ? "until revoked" : `expires ${new Date(data.expiresAt).toISOString()}`}\n\n${data.setup}\n\n${data.claude}\n\n# ~/.codex/config.toml\n${data.codex}`,
    );
  }
  return verb === "list"
    ? result(args, response.result.data)
    : mutationResult(args, response.result.data);
}
