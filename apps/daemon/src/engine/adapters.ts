import { discoverProviders, discoverPi } from "@ace/provider-kit/discovery";
import type { ProviderAdapter } from "@ace/engine-api";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import { AdapterRegistry } from "./registry.ts";

/** Metadata probes only; sessions still open after committed command admission. */
export async function discoverAdapters(
  discover: typeof discoverProviders = discoverProviders,
  claudeAdapter?: (cli: DiscoveryResult) => ProviderAdapter,
  additional?: (registry: AdapterRegistry) => Promise<void>,
): Promise<AdapterRegistry> {
  const registry = new AdapterRegistry();
  const { claude, codex, opencode, cursor } = await discover();
  if (claude.installed) {
    const { createClaudeAdapter } = await import("@ace/adapter-claude");
    registry.register(
      claudeAdapter?.(claude) ??
        createClaudeAdapter(claude.path ? { executable: claude.path } : {}),
      claude,
    );
  }
  if (codex.installed) {
    const { createCodexAdapter } = await import("@ace/adapter-codex");
    registry.register(createCodexAdapter({ cli: codex }), codex);
  }
  if (opencode.installed) {
    const { createOpenCodeAdapter } = await import("@ace/adapter-opencode");
    registry.register(
      createOpenCodeAdapter({
        discovery: opencode.path ? { overrides: { opencode: opencode.path } } : {},
      }),
      opencode,
    );
  }
  if (cursor.installed) {
    const { createAcpAdapter, cursorQuirks } = await import("@ace/adapter-acp");
    registry.register(
      createAcpAdapter(cursorQuirks, cursor.path ? { command: cursor.path } : {}),
      cursor,
    );
  }
  if (additional) await additional(registry);
  else {
    const pi = await discoverPi();
    if (pi.installed) {
      const { createPiAdapter, piProfile } = await import("@ace/adapter-pi");
      if (piProfile(pi).supported) registry.register(createPiAdapter({ cli: pi }), pi);
    }
  }
  return registry;
}
