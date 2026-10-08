import { ClaudePermissionMode } from "@ace/provider-kit/permission-modes";
import { z } from "zod";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

const PermissionMode = ClaudePermissionMode;
export const ClaudeConfiguration = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("coding"),
    settingSources: z.array(z.enum(["user", "project", "local"])).max(3),
    permissionMode: PermissionMode.optional(),
  }),
  z.object({ kind: z.literal("isolated"), permissionMode: PermissionMode.optional() }),
]);
export type ClaudeConfiguration = z.infer<typeof ClaudeConfiguration>;
export const codingConfiguration: ClaudeConfiguration = {
  kind: "coding",
  settingSources: ["user", "project", "local"],
};
export const isolatedConfiguration: ClaudeConfiguration = {
  kind: "isolated",
};
export function configurationOptions(
  value: ClaudeConfiguration,
): Pick<Options, "systemPrompt" | "settingSources" | "permissionMode" | "strictMcpConfig"> {
  const config = ClaudeConfiguration.parse(value);
  return config.kind === "coding"
    ? {
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: config.settingSources,
        ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}),
      }
    : {
        settingSources: [],
        ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}),
        strictMcpConfig: true,
      };
}
