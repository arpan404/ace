import type { AgentOptions } from "@cursor/sdk";

export type SandboxAdmission =
  /** `reason`: what the person can do about it, when ace could find out why. */
  { supported: false; reason?: string } | { supported: true; release: () => Promise<void> };

/**
 * Public SDK executor admission checks the installed helper and host support without a turn.
 * `explain` says why when the SDK refuses its sandbox (sandbox-helper.ts on Linux).
 */
export async function probeCursorSandbox(
  sdk: {
    ConfigurationError: typeof import("@cursor/sdk").ConfigurationError;
    createAgentPlatform(
      options: import("@cursor/sdk").CursorAgentPlatformOptions,
    ): Promise<Pick<import("@cursor/sdk").CursorAgentPlatform, "prewarmLocalWorkspace">>;
  },
  options: AgentOptions,
  explain?: () => Promise<string>,
): Promise<SandboxAdmission> {
  const store = options.local?.store;
  if (!store) throw new Error("Sandbox admission requires the owned checkpoint store");
  const platform = await sdk.createAgentPlatform({ localStore: store });
  try {
    const release = await platform.prewarmLocalWorkspace(options);
    return { supported: true, release };
  } catch (error) {
    if (
      error instanceof sdk.ConfigurationError &&
      /sandboxing is not supported|sandbox.*(?:not supported|unavailable|missing)/i.test(
        error.message,
      )
    ) {
      const reason = await explain?.().catch(() => undefined);
      return reason ? { supported: false, reason } : { supported: false };
    }
    throw error;
  }
}
