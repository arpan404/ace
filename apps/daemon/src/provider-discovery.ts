import { discoverProvider, type discoverProviders } from "@ace/provider-kit/discovery";
import type { ServiceContext } from "./services/types.ts";

/** No metadata process is run for a disabled provider. User injections remain test boundaries. */
export function configuredDiscovery(
  context: ServiceContext,
  injected?: typeof discoverProviders,
): typeof discoverProviders {
  return async (options = {}) => {
    if (injected) return injected(options);
    const probe = async (provider: "claude" | "codex" | "opencode") => {
      const config = context.services.providerConfigurations?.for(provider);
      if (config?.enabled === false)
        return {
          installed: false,
          auth: "unknown" as const,
          loginHint: "Provider disabled in Settings",
        };
      return discoverProvider(provider, {
        ...options,
        signal: options.signal ?? context.signal,
        ...(config?.binaryPath
          ? { overrides: { ...options.overrides, [provider]: config.binaryPath } }
          : {}),
      });
    };
    const [claude, codex, opencode] = await Promise.all([
      probe("claude"),
      probe("codex"),
      probe("opencode"),
    ]);
    return {
      claude,
      codex,
      opencode,
      cursor: { installed: false, auth: "unknown", loginHint: "Sign in to Cursor" },
    };
  };
}
