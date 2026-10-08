import { instanceEnv, loginStatus, type AccountRegistry } from "@ace/accounts";
import type { ProviderInstance } from "@ace/protocol/accounts";
import { discoverCursorSdk } from "@ace/adapter-cursor/discovery";
import type { SdkDiscoveryOptions } from "@ace/provider-kit/sdk";
import type { DiscoveryOptions } from "@ace/provider-kit/discovery";
import { probeOutput } from "@ace/provider-kit/process";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { apiKeySupport } from "./provider-api-key.ts";

export function reportedAuthMethod(detail?: string): "browser" | "api_key" | "unknown" {
  return detail === "API key" || detail === "api_key"
    ? "api_key"
    : ["ChatGPT", "claude.ai", "oauth"].includes(detail ?? "")
      ? "browser"
      : "unknown";
}
/** Cold metadata probes never read auth files. The CLI reports safe status itself. */
export async function inspectAccountSupport(
  provider: ProviderInstance["provider"],
  options: {
    registry: AccountRegistry;
    env: NodeJS.ProcessEnv;
    discovery?: DiscoveryOptions | undefined;
    cursorDiscovery?: SdkDiscoveryOptions | undefined;
    signal?: AbortSignal | undefined;
    configuration?(provider: ProviderInstance["provider"]): {
      enabled?: boolean | undefined;
      binaryPath?: string | undefined;
    };
    now(): number;
  },
) {
  const configuration = options.configuration?.(provider);
  if (configuration?.enabled === false)
    return { supported: false, reason: "Provider is disabled." };
  if (provider === "cursor") {
    const sdk = await discoverCursorSdk(options.cursorDiscovery);
    return apiKeySupport(provider, sdk.supported ? sdk.version : undefined);
  }
  if (provider === "acp") return apiKeySupport(provider);
  const rows = options.registry.list();
  const instance =
    rows.find((row) => row.instance.provider === provider && row.instance.implicit)?.instance ??
    rows.find((row) => row.instance.provider === provider)?.instance;
  if (!instance) return apiKeySupport(provider);
  const status = await loginStatus(instance, {
    ...options.discovery,
    ...(configuration?.binaryPath && provider !== "pi"
      ? { overrides: { ...options.discovery?.overrides, [provider]: configuration.binaryPath } }
      : {}),
    env: options.env,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!status.path) return apiKeySupport(provider);
  options.registry.ingest(instance.id, {
    provider,
    payload: new ProviderPayload(JSON.stringify({ auth: status.auth })),
    observedAt: options.now(),
    timeZone: "UTC",
  });
  const method = reportedAuthMethod(status.authDetail);
  if (status.auth === "logged_out" || method !== "unknown" || status.accountLabel)
    options.registry.recordAuth(
      instance.id,
      status.auth === "logged_out" ? "unknown" : method,
      status.accountLabel,
    );
  if (provider !== "codex" && provider !== "opencode") return apiKeySupport(provider);
  try {
    const env = instanceEnv(instance, options.env);
    const help = await probeOutput(
      status.path,
      provider === "codex" ? ["login", "--help"] : ["auth", "login", "--help"],
      { env, timeoutMs: 4000, ...(options.signal ? { signal: options.signal } : {}) },
    );
    return apiKeySupport(provider, status.version, help.code === 0 ? help.stdout : "");
  } catch {
    return apiKeySupport(provider);
  }
}
