import { instanceEnv } from "@ace/accounts";
import {
  defaultProviderExecutable,
  findExecutable,
  type DiscoveryOptions,
} from "@ace/provider-kit/discovery";
import type { ProviderInstance } from "@ace/protocol/accounts";
import { configuredProviderDiscovery } from "./provider-discovery.ts";

export type AccountConfiguration = (
  provider: ProviderInstance["provider"],
  instance?: string,
) => { enabled?: boolean | undefined; binaryPath?: string | undefined };

/**
 * The CLI one account runs, in that account's environment: its configured binary path, else the
 * provider's default on the account's PATH. Undefined when it isn't installed.
 */
export async function accountExecutable(
  instance: ProviderInstance,
  provider: "codex" | "claude",
  options: {
    env: NodeJS.ProcessEnv;
    discovery?: DiscoveryOptions | undefined;
    configuration?: AccountConfiguration | undefined;
  },
): Promise<{ executable: string | undefined; env: NodeJS.ProcessEnv }> {
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
  return { executable, env };
}
