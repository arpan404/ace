import { discoverProviders } from "@ace/provider-kit/discovery";
import {
  discoverCursorSdk,
  createCursorAdapter,
  type CursorAdapterOptions,
} from "@ace/adapter-cursor";
import { AdapterRegistry } from "./registry.ts";

/** Metadata probes only; sessions still open after committed command admission. */
export async function discoverAdapters(
  discover: typeof discoverProviders = discoverProviders,
  cursorOptions: CursorAdapterOptions = {},
  sdkDiscovery: typeof discoverCursorSdk = discoverCursorSdk,
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
    registry.registerFallback(
      createAcpAdapter(cursorQuirks, cursor.path ? { command: cursor.path } : {}),
      cursor,
      "acp",
    );
  }
  const sdk = await sdkDiscovery(cursorOptions.discovery);
  if (sdk.installed) {
    // Unsupported SDKs stay selected and fail on admission. Only absence permits ACP fallback.
    registry.register(createCursorAdapter(cursorOptions), {
      installed: true,
      auth: "unknown",
      loginHint: "Cursor SDK sign-in is separate from agent login",
      ...(sdk.version ? { version: sdk.version } : {}),
      ...(sdk.error ? { error: sdk.error } : {}),
    });
  }
  return registry;
}
