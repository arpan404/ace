import type { discoverProviders } from "@ace/provider-kit/discovery";

const absent = { installed: false, auth: "unknown" as const, loginHint: "Not installed" };

/**
 * Engine options for a daemon whose test needs no provider CLI. Startup otherwise probes the
 * CLIs installed on this machine, which costs about a second and depends on the machine.
 */
export const noProviderDiscovery: { adapterDiscovery: typeof discoverProviders } = {
  adapterDiscovery: async () => ({
    claude: absent,
    codex: absent,
    opencode: absent,
    cursor: absent,
  }),
};
