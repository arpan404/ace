import { createClaudeAdapter } from "@ace/adapter-claude";
import { createCodexAdapter } from "@ace/adapter-codex";
import { createOpenCodeAdapter } from "@ace/adapter-opencode";
import { createAcpAdapter, cursorQuirks } from "@ace/adapter-acp";
import { discoverProviders } from "@ace/provider-kit/discovery";
import { AdapterRegistry } from "./registry.ts";

/** Metadata probes only; sessions still open after committed command admission. */
export async function discoverAdapters(
  discover: typeof discoverProviders = discoverProviders,
): Promise<AdapterRegistry> {
  const registry = new AdapterRegistry();
  const { claude, codex, opencode, cursor } = await discover();
  if (claude.installed) {
    registry.register(createClaudeAdapter(claude.path ? { executable: claude.path } : {}), claude);
  }
  if (codex.installed) registry.register(createCodexAdapter({ cli: codex }), codex);
  if (opencode.installed)
    registry.register(
      createOpenCodeAdapter({
        discovery: opencode.path ? { overrides: { opencode: opencode.path } } : {},
      }),
      opencode,
    );
  if (cursor.installed)
    registry.register(
      createAcpAdapter(cursorQuirks, cursor.path ? { command: cursor.path } : {}),
      cursor,
    );
  return registry;
}
