import { discoverProviders, discoverPi } from "@ace/provider-kit/discovery";
import { discoverCursorSdk } from "@ace/adapter-cursor/discovery";
import type { CursorAdapterOptions } from "@ace/adapter-cursor";
import type { ProviderAdapter } from "@ace/engine-api";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import { AdapterRegistry } from "./registry.ts";

/** Metadata probes only; sessions still open after committed command admission. */
export async function discoverAdapters(
  discover: typeof discoverProviders = discoverProviders,
  claudeAdapter?: (cli: DiscoveryResult) => ProviderAdapter | Promise<ProviderAdapter>,
  additional?: (registry: AdapterRegistry) => Promise<void>,
  cursorOptions: CursorAdapterOptions = {},
  sdkDiscovery: typeof discoverCursorSdk = discoverCursorSdk,
  registry: AdapterRegistry = new AdapterRegistry(),
): Promise<AdapterRegistry> {
  const { claude, codex, opencode, cursor } = await discover();
  if (claude.installed && !registry.has("claude")) {
    const { createClaudeAdapter } = await import("@ace/adapter-claude");
    registry.register(
      (await claudeAdapter?.(claude)) ??
        createClaudeAdapter(claude.path ? { executable: claude.path } : {}),
      claude,
    );
  }
  if (codex.installed && !registry.has("codex")) {
    const { createCodexAdapter } = await import("@ace/adapter-codex");
    registry.register(createCodexAdapter({ cli: codex }), codex);
  }
  if (opencode.installed && !registry.has("opencode")) {
    const { createOpenCodeAdapter } = await import("@ace/adapter-opencode");
    registry.register(
      createOpenCodeAdapter({
        discovery: opencode.path ? { overrides: { opencode: opencode.path } } : {},
      }),
      opencode,
    );
  }
  if (cursor.installed && !registry.has("cursor")) {
    const { createAcpAdapter, cursorQuirks } = await import("@ace/adapter-acp");
    registry.registerFallback(
      createAcpAdapter(cursorQuirks, cursor.path ? { command: cursor.path } : {}),
      cursor,
      "acp",
    );
  }
  const sdk = await sdkDiscovery(cursorOptions.discovery);
  if (
    sdk.installed &&
    (!registry.has("cursor") || registry.get("cursor").adapter.backend !== "cursor-sdk")
  ) {
    // Unsupported SDKs stay selected and fail on admission. Only absence permits ACP fallback.
    const { createCursorAdapter } = await import("@ace/adapter-cursor/adapter");
    registry.register(createCursorAdapter(cursorOptions), {
      installed: true,
      auth: "unknown",
      loginHint: "Cursor SDK sign-in is separate from agent login",
      ...(sdk.version ? { version: sdk.version } : {}),
      ...(sdk.error ? { error: sdk.error } : {}),
    });
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
