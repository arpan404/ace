import { openCodeInjection, type AceMcpConnection } from "@ace/mcp-server";

/** Preserve user JSONC configuration through the canonical MCP injection owner. */
export function mcpEnvironment(env: NodeJS.ProcessEnv, input: AceMcpConnection): NodeJS.ProcessEnv {
  return { ...env, ...openCodeInjection(input, env.OPENCODE_CONFIG_CONTENT).env };
}
