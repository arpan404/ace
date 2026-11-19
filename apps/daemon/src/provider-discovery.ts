import {
  locateProvider,
  type DiscoveryResult,
  type discoverProviders,
} from "@ace/provider-kit/discovery";
import type { ServiceContext } from "./services/types.ts";

type CliProvider = "claude" | "codex" | "opencode";
const disabled: DiscoveryResult = {
  installed: false,
  auth: "unknown",
  loginHint: "Provider disabled in Settings",
};
const noCursor: DiscoveryResult = {
  installed: false,
  auth: "unknown",
  loginHint: "Sign in to Cursor",
};

function locate(
  context: ServiceContext,
  provider: CliProvider,
  options: Parameters<typeof discoverProviders>[0] = {},
): Promise<{ located: DiscoveryResult; discovered: Promise<DiscoveryResult> }> {
  const config = context.services.providerConfigurations?.for(provider);
  if (config?.enabled === false)
    return Promise.resolve({ located: disabled, discovered: Promise.resolve(disabled) });
  const shared = context.services.startupProbes?.probe;
  return locateProvider(
    provider,
    configuredProviderDiscovery(provider, config?.binaryPath, {
      ...(shared ? { probe: shared } : {}),
      ...options,
      signal: options.signal ?? context.signal,
    }),
  );
}

/** No metadata process is run for a disabled provider. User injections remain test boundaries. */
export function configuredDiscovery(
  context: ServiceContext,
  injected?: typeof discoverProviders,
): typeof discoverProviders {
  return async (options = {}) => {
    if (injected) return injected(options);
    const full = async (provider: CliProvider) =>
      (await locate(context, provider, options)).discovered;
    const [claude, codex, opencode] = await Promise.all([
      full("claude"),
      full("codex"),
      full("opencode"),
    ]);
    return { claude, codex, opencode, cursor: noCursor };
  };
}

/**
 * Discovery that answers once each CLI's path and version are read, its login still `unknown`:
 * the engine registers adapters with that, and `discovered` reports each full result, login
 * included, when its slower login probe ends. A failed login probe is reported like any other
 * unreadable login, never thrown. An injected discovery answers in one stage, as before.
 */
export function stagedDiscovery(
  context: ServiceContext,
  discovered: (provider: CliProvider, result: DiscoveryResult) => void,
  injected?: typeof discoverProviders,
): typeof discoverProviders {
  return async (options = {}) => {
    if (injected) return injected(options);
    const located = async (provider: CliProvider) => {
      const stages = await locate(context, provider, options);
      stages.discovered.then(
        (result) => discovered(provider, result),
        // Aborted at shutdown: nothing is left to report to.
        () => {},
      );
      return stages.located;
    };
    const [claude, codex, opencode] = await Promise.all([
      located("claude"),
      located("codex"),
      located("opencode"),
    ]);
    return { claude, codex, opencode, cursor: noCursor };
  };
}

/** One executable policy for status, sign-in, and managed-account restoration. */
export function configuredProviderDiscovery(
  provider: import("@ace/protocol").ProviderKind,
  binaryPath: string | undefined,
  options: import("@ace/provider-kit/discovery").DiscoveryOptions = {},
): import("@ace/provider-kit/discovery").DiscoveryOptions & { executable?: string } {
  if (!binaryPath) return options;
  if (provider === "pi" || provider === "antigravity")
    return { ...options, executable: binaryPath };
  if (provider === "acp") return options;
  return { ...options, overrides: { ...options.overrides, [provider]: binaryPath } };
}

export interface ProviderExecutableConfiguration {
  enabled?: boolean | undefined;
  binaryPath?: string | undefined;
}

/** Freshness depends on the effective executable and admission policy, not display preferences. */
export function sameProviderExecutableConfiguration(
  observed: ProviderExecutableConfiguration,
  current: ProviderExecutableConfiguration | undefined,
): boolean {
  return (
    current?.binaryPath === observed.binaryPath &&
    (current?.enabled !== false) === (observed.enabled !== false)
  );
}
