import { instanceEnv, type AccountRegistry } from "@ace/accounts";
import { findExecutable, type DiscoveryOptions } from "@ace/provider-kit/discovery";
import type { AccountResetOutcome } from "@ace/protocol/accounts";
import { configuredProviderDiscovery } from "./provider-discovery.ts";

export type ConsumeReset = (options: {
  executable: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  signal: AbortSignal;
  idempotencyKey: string;
}) => Promise<AccountResetOutcome>;

/** Uses only the selected account's own CLI login. No credentials cross this boundary. */
export async function consumeAccountReset(options: {
  registry: AccountRegistry;
  instanceId: string;
  idempotencyKey: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  signal: AbortSignal;
  discovery?: DiscoveryOptions | undefined;
  configuration?: { enabled?: boolean | undefined; binaryPath?: string | undefined } | undefined;
  consume?: ConsumeReset | undefined;
}): Promise<AccountResetOutcome> {
  const account = options.registry.get(options.instanceId);
  if (
    !account ||
    account.instance.provider !== "codex" ||
    account.quota.auth === "logged_out" ||
    account.quota.blockers.homeUnavailable ||
    options.configuration?.enabled === false
  )
    throw new Error("Account reset unavailable");
  const discovery = configuredProviderDiscovery(
    "codex",
    options.configuration?.binaryPath,
    options.discovery,
  );
  const env = instanceEnv(account.instance, options.env);
  const executable = await findExecutable(discovery.overrides?.codex ?? "codex", env);
  if (!executable) throw new Error("Codex is not installed");
  const consume =
    options.consume ?? (await import("@ace/adapter-codex/usage-read")).consumeCodexReset;
  try {
    return await consume({
      executable,
      env,
      cwd: options.cwd,
      signal: options.signal,
      idempotencyKey: options.idempotencyKey,
    });
  } catch {
    // Provider errors may contain raw response bodies. Never relay or log those here.
    throw new Error("Couldn't confirm the account reset. Retry this attempt or refresh usage.");
  }
}
