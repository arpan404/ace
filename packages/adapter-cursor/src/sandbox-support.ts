import type { AgentOptions } from "@cursor/sdk";

export type SandboxAdmission =
  | { supported: false }
  | { supported: true; release: () => Promise<void> };

/** Public SDK executor admission checks the installed helper and host support without a turn. */
export async function probeCursorSandbox(
  sdk: {
    ConfigurationError: typeof import("@cursor/sdk").ConfigurationError;
    createAgentPlatform(
      options: import("@cursor/sdk").CursorAgentPlatformOptions,
    ): Promise<Pick<import("@cursor/sdk").CursorAgentPlatform, "prewarmLocalWorkspace">>;
  },
  options: AgentOptions,
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
    )
      return { supported: false };
    throw error;
  }
}
