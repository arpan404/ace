import {
  discoverDescriptor,
  parseVersion,
  type DiscoveryOptions,
} from "@ace/provider-kit/discovery";

/**
 * This historical HTTP test adapter needs v1 metadata. Application provider discovery
 * deliberately admits only v2; keep the old recording fixture outside that admission path.
 */
export async function discoverLegacyOpenCode(options: DiscoveryOptions = {}) {
  const opencode = await discoverDescriptor(
    {
      command: options.overrides?.opencode ?? "opencode",
      versionArgs: ["--version"],
      version: (output) => parseVersion("opencode", output),
      loginHint: "opencode auth login",
    },
    { ...options, env: { ...process.env, ...options.env } },
  );
  return { opencode };
}
