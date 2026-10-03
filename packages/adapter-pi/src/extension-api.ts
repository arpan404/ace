/** Structural subset of the version-pinned public Pi extension API. No provider internals. */
export interface PiExtensionApi {
  registerCommand(
    name: string,
    command: {
      description: string;
      handler: (
        args: string,
        ctx: {
          ui: { notify(message: string, type: "info" | "error"): void };
          waitForIdle(): Promise<void>;
          navigateTree(id: string, options: { summarize: false }): Promise<{ cancelled: boolean }>;
        },
      ) => Promise<void>;
    },
  ): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    parameters: Record<string, unknown>;
    execute: (
      id: string,
      params: unknown,
      signal: AbortSignal | undefined,
    ) => Promise<{ content: unknown[]; details: unknown }>;
  }): void;
  on(event: "session_shutdown", handler: () => Promise<void>): void;
  on(
    event: "tool_result",
    handler: (event: { toolName: string; details: unknown }) => { isError: boolean } | undefined,
  ): void;
}
