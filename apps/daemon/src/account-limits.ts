import type { AccountRegistry } from "@ace/accounts";
import { instanceEnv } from "@ace/accounts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import {
  defaultProviderExecutable,
  findExecutable,
  type DiscoveryOptions,
} from "@ace/provider-kit/discovery";
import type { ProviderInstance } from "@ace/protocol/accounts";
import { configuredProviderDiscovery } from "./provider-discovery.ts";

/**
 * Reads one account's limits without a model turn, through its own CLI: Codex's
 * `account/rateLimits/read`, Claude's SDK `get_usage`. Undefined when the login has no plan
 * limits to report.
 */
export type ReadCliUsage = (options: {
  executable: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  signal: AbortSignal;
}) => Promise<Record<string, unknown> | undefined>;

/** The providers whose own CLI reads an account's limits. */
export type CliUsageProvider = "codex" | "claude";

const defaultReads: Record<CliUsageProvider, ReadCliUsage> = {
  codex: async (options) => (await import("@ace/adapter-codex/usage-read")).readCodexUsage(options),
  claude: async (options) =>
    (await import("@ace/adapter-claude/usage-read")).readClaudePlanUsage({ ...options, args: [] }),
};

/**
 * Ask every account of `provider` not known to be signed out for its current limits and record
 * them, so Usage has the session and weekly windows (and Codex's banked resets) at startup and on
 * every refresh, with no session open. The CLI's own login starts out `unknown` until a session
 * or a sign-in check says otherwise, so it is asked too: a login that lapsed only fails its read.
 * One account failing never stops the others.
 */
export async function refreshCliLimits(options: {
  provider: CliUsageProvider;
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
  read?: ReadCliUsage | undefined;
  onError?: ((instance: string, error: unknown) => void) | undefined;
}): Promise<void> {
  const { provider } = options;
  const read = options.read ?? defaultReads[provider];
  const accounts = options.registry
    .list()
    .filter(
      ({ instance, quota }) =>
        instance.provider === provider &&
        quota.auth !== "logged_out" &&
        !quota.blockers.homeUnavailable &&
        options.configuration?.(provider, instance.id).enabled !== false,
    );
  await Promise.all(
    accounts.map(async ({ instance }) => {
      try {
        const discovery = configuredProviderDiscovery(
          provider,
          options.configuration?.(provider, instance.id).binaryPath,
          options.discovery,
        );
        const env = instanceEnv(instance, options.env);
        const executable = await findExecutable(
          discovery.overrides?.[provider] ?? defaultProviderExecutable(provider),
          env,
        );
        // A CLI that isn't installed has no limits to read, and that is no error.
        if (!executable) return;
        const result = await read({ executable, env, cwd: options.cwd, signal: options.signal });
        if (!result) return;
        options.registry.ingest(instance.id, {
          provider,
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
