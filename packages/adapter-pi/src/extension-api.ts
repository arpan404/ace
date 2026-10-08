/** Structural subset of the version-pinned public Pi extension API. No provider internals. */
export interface PiExtensionApi {
  sendMessage?(
    message: { customType: string; content: string; display: boolean; details: unknown },
    options: { triggerTurn: boolean; deliverAs: "followUp" },
  ): void;
  appendEntry(customType: string, data: unknown): void;
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
  on(
    event: "tool_call",
    handler: (
      event: { toolName: string; toolCallId: string; input: unknown },
      ctx: {
        cwd: string;
        hasUI: boolean;
        ui: { confirm(title: string, message: string): Promise<boolean> };
      },
    ) => Promise<{ block: true; reason: string } | undefined>,
  ): void;
  on(
    event: "session_start" | "turn_end" | "model_select" | "session_compact",
    handler: (
      event: unknown,
      ctx: {
        getContextUsage(): unknown;
        sessionManager?: { getLeafId(): string | null };
        model?: { provider: string; id: string };
        ui: { notify(message: string, type: "info" | "error"): void };
      },
    ) => void,
  ): void;
  on(event: "session_shutdown", handler: () => Promise<void>): void;
  on(
    event: "tool_result",
    handler: (event: { toolName: string; details: unknown }) => { isError: boolean } | undefined,
  ): void;
}
