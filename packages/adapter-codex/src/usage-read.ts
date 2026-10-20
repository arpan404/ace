import { z } from "zod";
import { AccountResetOutcome } from "@ace/protocol/accounts";
import type { JsonRpcPeer } from "@ace/provider-kit/jsonrpc";
import type { SpawnOptions, SupervisedProcess } from "@ace/provider-kit/process";
import { openAppServer } from "./app-server.ts";

/**
 * One account's Codex limits without a session: a short-lived `codex app-server` answers
 * `account/rateLimits/read` (every window, banked resets) and exits. It calls Codex's usage
 * endpoint only; no model turn runs and no quota is spent. The result is the read's own object,
 * for the account registry to decode like any other rate-limit report.
 */
type UsageOptions = {
  executable: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  signal: AbortSignal;
  spawn?: (options: SpawnOptions) => SupervisedProcess;
};

export function readCodexUsage(options: UsageOptions): Promise<Record<string, unknown>> {
  return withUsageServer(options, async (rpc) => {
    const result = await rpc.request("account/rateLimits/read", {}, { signal: options.signal });
    if (typeof result !== "object" || result === null || Array.isArray(result))
      throw new Error("Codex returned no rate-limit snapshot");
    return { ...result };
  });
}

/** One explicitly confirmed attempt. Retrying must reuse the same idempotency key. */
export function consumeCodexReset(
  options: UsageOptions & { idempotencyKey: string },
): Promise<AccountResetOutcome> {
  return withUsageServer(options, async (rpc) => {
    const result = await rpc.request(
      "account/rateLimitResetCredit/consume",
      { idempotencyKey: options.idempotencyKey },
      { signal: options.signal },
    );
    return z.object({ outcome: AccountResetOutcome }).parse(result).outcome;
  });
}

async function withUsageServer<T>(
  options: UsageOptions,
  run: (rpc: JsonRpcPeer) => Promise<T>,
): Promise<T> {
  const server = await openAppServer(options, "codex-usage-read");
  try {
    return await run(server.rpc);
  } finally {
    await server.close();
  }
}
