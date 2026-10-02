import { discoverProviders } from "@ace/provider-kit/discovery";
import { AdapterRegistry } from "./registry.ts";

/** Metadata probes only; sessions still open after committed command admission. */
export async function discoverAdapters(
  discover: typeof discoverProviders = discoverProviders,
): Promise<AdapterRegistry> {
  const registry = new AdapterRegistry();
  const { claude, codex, opencode, cursor } = await discover();
  if (claude.installed) {
    const { createClaudeAdapter } = await import("@ace/adapter-claude");
    registry.register(createClaudeAdapter(claude.path ? { executable: claude.path } : {}), claude);
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
  return registry;
}
