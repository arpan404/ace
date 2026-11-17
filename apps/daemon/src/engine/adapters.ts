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
  // The CLI probes, the Cursor SDK and the additional providers are independent: read together,
  // and every one settles before this returns. A failed branch never cuts the others short, so
  // nothing registers after the caller has bound sessions and let them open.
  const [clis, sdkRead, extra] = await Promise.allSettled([
    discover(),
    sdkDiscovery(cursorOptions.discovery),
    additional ? additional(registry) : registerPi(registry),
  ]);
  const failures = [clis, sdkRead, extra].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (clis.status === "fulfilled") await registerClis(registry, clis.value, claudeAdapter);
  if (sdkRead.status === "fulfilled")
    await registerCursorSdk(registry, sdkRead.value, cursorOptions);
  if (failures.length) throw discoveryFailure(failures);
  return registry;
}

/** Waits for every task, then throws what failed: one failure as is, several together. */
export async function settleAll(tasks: readonly Promise<unknown>[]): Promise<void> {
  const failures = (await Promise.allSettled(tasks)).flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length) throw discoveryFailure(failures);
}

function discoveryFailure(failures: readonly unknown[]): unknown {
  const reasons = failures.flatMap((failure) =>
    failure instanceof AggregateError ? failure.errors : [failure],
  );
  if (reasons.length === 1) return reasons[0];
  const messages = reasons.map((reason) =>
    reason instanceof Error ? reason.message : String(reason),
  );
  return new AggregateError(reasons, messages.join("; "));
}

async function registerClis(
  registry: AdapterRegistry,
  { claude, codex, opencode }: Awaited<ReturnType<typeof discoverProviders>>,
  claudeAdapter?: (cli: DiscoveryResult) => ProviderAdapter | Promise<ProviderAdapter>,
): Promise<void> {
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
}

async function registerCursorSdk(
  registry: AdapterRegistry,
  sdk: Awaited<ReturnType<typeof discoverCursorSdk>>,
  cursorOptions: CursorAdapterOptions,
): Promise<void> {
  if (
    sdk.installed &&
    (!registry.has("cursor") || registry.get("cursor").adapter.backend !== "cursor-sdk")
  ) {
    // Unsupported SDKs fail on admission; Cursor has no alternate runtime.
    const { createCursorAdapter } = await import("@ace/adapter-cursor/adapter");
    registry.register(createCursorAdapter(cursorOptions), {
      installed: true,
      auth: "unknown",
      loginHint: "Sign in to Cursor",
      ...(sdk.version ? { version: sdk.version } : {}),
      ...(sdk.error ? { error: sdk.error } : {}),
    });
  }
}

async function registerPi(registry: AdapterRegistry): Promise<void> {
  const pi = await discoverPi();
  if (!pi.installed) return;
  const { createPiAdapter } = await import("@ace/adapter-pi/adapter");
  const { piProfile } = await import("@ace/adapter-pi/capabilities");
  if (piProfile(pi).supported) registry.register(createPiAdapter({ cli: pi }), pi);
}
