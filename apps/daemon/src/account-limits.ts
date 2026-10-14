import type { AccountRegistry } from "@ace/accounts";
import { instanceEnv } from "@ace/accounts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { defaultProviderExecutable, type DiscoveryOptions } from "@ace/provider-kit/discovery";
import type { ProviderInstance } from "@ace/protocol/accounts";
import { configuredProviderDiscovery } from "./provider-discovery.ts";

/** Reads one account's Codex limits without a model turn (`account/rateLimits/read`). */
export type ReadCodexUsage = (options: {
  executable: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  signal: AbortSignal;
}) => Promise<Record<string, unknown>>;

const defaultRead: ReadCodexUsage = async (options) =>
  (await import("@ace/adapter-codex/usage-read")).readCodexUsage(options);

/**
 * Ask every signed-in Codex account for its current limits and record them, so Usage has the
 * 5-hour and weekly windows and banked resets even when no Codex session has run since the last
 * reset. Claude has no equivalent: its CLI reports limits only during a turn, so its windows
 * come from sessions alone. One account failing never stops the others.
 */
export async function refreshCodexLimits(options: {
  registry: AccountRegistry;
  env: NodeJS.ProcessEnv;
  cwd: string;
  now(): number;
  signal: AbortSignal;
  discovery?: DiscoveryOptions | undefined;
  configuration?:
    | ((
        provider: ProviderInstance["provider"],
        instance?: string,
      ) => { enabled?: boolean | undefined; binaryPath?: string | undefined })
    | undefined;
  read?: ReadCodexUsage | undefined;
  onError?: ((instance: string, error: unknown) => void) | undefined;
}): Promise<void> {
  const read = options.read ?? defaultRead;
  const accounts = options.registry
    .list()
    .filter(
      ({ instance, quota }) =>
        instance.provider === "codex" &&
        quota.auth === "logged_in" &&
        !quota.blockers.homeUnavailable &&
        options.configuration?.("codex", instance.id).enabled !== false,
    );
  await Promise.all(
    accounts.map(async ({ instance }) => {
      try {
        const discovery = configuredProviderDiscovery(
          "codex",
          options.configuration?.("codex", instance.id).binaryPath,
          options.discovery,
        );
        const result = await read({
          executable: discovery.overrides?.codex ?? defaultProviderExecutable("codex"),
          env: instanceEnv(instance, options.env),
          cwd: options.cwd,
          signal: options.signal,
        });
        options.registry.ingest(instance.id, {
          provider: "codex",
          payload: new ProviderPayload(JSON.stringify(result)),
          observedAt: options.now(),
          timeZone: "UTC",
        });
      } catch (error) {
        options.onError?.(instance.id, error);
      }
    }),
  );
}
