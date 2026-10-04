import type { AgentOptions } from "@cursor/sdk";

/** Public SDK executor admission checks the installed helper and host support without a turn. */
export async function probeCursorSandbox(
  sdk: {
    ConfigurationError: typeof import("@cursor/sdk").ConfigurationError;
    createAgentPlatform(
      options: import("@cursor/sdk").CursorAgentPlatformOptions,
    ): Promise<Pick<import("@cursor/sdk").CursorAgentPlatform, "prewarmLocalWorkspace">>;
  },
  options: AgentOptions,
): Promise<boolean> {
  const store = options.local?.store;
  if (!store) throw new Error("Sandbox admission requires the owned checkpoint store");
  const platform = await sdk.createAgentPlatform({ localStore: store });
  try {
    const release = await platform.prewarmLocalWorkspace(options);
    await release();
    return true;
  } catch (error) {
    if (
      error instanceof sdk.ConfigurationError &&
      /sandboxing is not supported|sandbox.*(?:not supported|unavailable|missing)/i.test(
        error.message,
      )
    )
      return false;
    throw error;
  }
}
