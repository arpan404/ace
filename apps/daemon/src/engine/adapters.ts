import { createClaudeAdapter } from "@ace/adapter-claude";
import { discoverProviders } from "@ace/provider-kit/discovery";
import { AdapterRegistry } from "./registry.ts";

/** Metadata probes only; sessions still open after committed command admission. */
export async function discoverAdapters(
  discover: typeof discoverProviders = discoverProviders,
): Promise<AdapterRegistry> {
  const registry = new AdapterRegistry();
  const { claude } = await discover();
  if (claude.installed) {
    registry.register(createClaudeAdapter(claude.path ? { executable: claude.path } : {}), claude);
  }
  return registry;
}
