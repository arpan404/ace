import { z } from "zod";
import { AceMcpConnectionSchema, openCodeInjection, type AceMcpConnection } from "@ace/mcp-server";

const Config = z.record(z.string(), z.unknown());
/** Pure configuration merge; preserve user servers and reserve ace's scoped connection. */
export function mcpEnvironment(env: NodeJS.ProcessEnv, input: AceMcpConnection): NodeJS.ProcessEnv {
  const connection = AceMcpConnectionSchema.parse(input);
  const prior = env.OPENCODE_CONFIG_CONTENT
    ? Config.parse(JSON.parse(env.OPENCODE_CONFIG_CONTENT))
    : {};
  const injected = Config.parse(
    JSON.parse(openCodeInjection(connection).env.OPENCODE_CONFIG_CONTENT),
  );
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...prior,
      mcp: { ...Config.parse(prior.mcp ?? {}), ...Config.parse(injected.mcp) },
    }),
  };
}
