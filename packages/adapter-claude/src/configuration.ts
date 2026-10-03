import { z } from "zod";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

const PermissionMode = z.enum(["default", "acceptEdits", "plan", "dontAsk", "auto"]);
export const ClaudeConfiguration = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("coding"),
    settingSources: z.array(z.enum(["user", "project", "local"])).max(3),
    permissionMode: PermissionMode,
  }),
  z.object({ kind: z.literal("isolated"), permissionMode: PermissionMode }),
]);
export type ClaudeConfiguration = z.infer<typeof ClaudeConfiguration>;
export const codingConfiguration: ClaudeConfiguration = {
  kind: "coding",
  settingSources: ["user", "project", "local"],
  permissionMode: "default",
};
export const isolatedConfiguration: ClaudeConfiguration = {
  kind: "isolated",
  permissionMode: "default",
};
export function configurationOptions(
  value: ClaudeConfiguration,
): Pick<Options, "systemPrompt" | "settingSources" | "permissionMode" | "strictMcpConfig"> {
  const config = ClaudeConfiguration.parse(value);
  return config.kind === "coding"
    ? {
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: config.settingSources,
        permissionMode: config.permissionMode,
      }
    : { settingSources: [], permissionMode: config.permissionMode, strictMcpConfig: true };
}
