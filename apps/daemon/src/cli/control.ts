import { CliOperation } from "@ace/protocol";
import type { Client } from "@ace/client";
import { option, timeoutMs, validateArgs, type Args } from "./args.ts";
import { key } from "./work.ts";
import { print, result } from "./io.ts";
import { CliFailure } from "./output.ts";
import { hostConnection } from "./connection.ts";
import { accessRequest } from "../client-access.ts";
import { setTimeout as delay } from "node:timers/promises";
export async function stopCommand(args: Args, home: string) {
  validateArgs(args, [], 1);
  const connection = hostConnection(home);
  const signal = AbortSignal.timeout(timeoutMs(args));
  await accessRequest(connection.origin, "/v1/stop", { method: "POST", token: connection.token });
  while (!signal.aborted) {
    try {
      await accessRequest(connection.origin, "/v1/status", { token: connection.token });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ECONNREFUSED")
        return result(args, { stopped: true });
      throw new CliFailure("uncertain", "Shutdown accepted but daemon termination is unconfirmed");
    }
    await delay(100, undefined, { signal }).catch(() => {});
  }
  throw new CliFailure("uncertain", "Shutdown accepted but daemon termination is unconfirmed");
}
export async function controlCommand(args: Args, client: Client, signal: AbortSignal) {
  const command = args.words[0];
  if (command === "kill-all") {
    validateArgs(args, ["thread", "provider", "project", "idempotency-key"], 1);
    const operation = CliOperation.parse({
      op: "process.kill_all",
      threadId: option(args, "thread"),
      provider: option(args, "provider"),
      project: option(args, "project"),
      key: key(args),
    });
    const response = await client.request({ type: "cli.request", operation }, { signal });
    if (!response.result.ok)
      throw new CliFailure(
        response.result.code === "unavailable" ? "uncertain" : "refused",
        response.result.code ?? "Kill refused",
      );
    return result(args, response.result);
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
      .object({ id: z.string(), expiresAt: z.number(), claude: z.string(), codex: z.string() })
      .parse(response.result.data);
    return print(
      args,
      `Enrollment ${data.id}, expires ${new Date(data.expiresAt).toISOString()}\n\n${data.claude}\n\n# ~/.codex/config.toml\n${data.codex}`,
    );
  }
  return result(args, response.result.data);
}
