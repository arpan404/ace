import type { ProviderAdapter } from "@ace/engine-api";
import { defaultProviderExecutable } from "@ace/provider-kit/discovery";
import type { ProviderConfigurationsState } from "./provider-configurations.ts";

/** Guard after account assignment so its effective settings control every actual launch. */
export function configuredAdapter(
  adapter: ProviderAdapter,
  settings?: ProviderConfigurationsState,
): ProviderAdapter {
  const initialOverride = settings?.for(adapter.provider).binaryPath;
  return {
    ...adapter,
    async openSession(context) {
      const configuration = settings?.for(adapter.provider, context.instanceId);
      if (configuration?.enabled === false) throw new Error("Provider disabled in Settings");
      const executable =
        configuration?.binaryPath ??
        (initialOverride && adapter.provider !== "acp"
          ? defaultProviderExecutable(adapter.provider)
          : undefined);
      return adapter.openSession({
        ...context,
        ...(executable ? { executable } : {}),
      });
    },
  };
}
