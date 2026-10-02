import { z } from "zod";
import { parseJson } from "./manifest.ts";

const configSchema = z
  .object({
    mcp: z.record(z.string(), z.unknown()).optional(),
    command: z.record(z.string(), z.unknown()).optional(),
    agent: z.record(z.string(), z.unknown()).optional(),
    instructions: z.array(z.string()).max(2048).optional(),
    skills: z
      .object({ paths: z.array(z.string()).max(2048).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
function decode(value: string) {
  if (Buffer.byteLength(value) > 64 * 1024) throw new Error("Provider override exceeds byte limit");
  return configSchema.parse(parseJson(value));
}
/** Compose native inline overrides without losing the daemon MCP configuration. */
export function launchEnvironment(
  base: NodeJS.ProcessEnv,
  plugins: Record<string, string>,
): NodeJS.ProcessEnv {
  const env = { ...base, ...plugins };
  if (base.OPENCODE_CONFIG_CONTENT && plugins.OPENCODE_CONFIG_CONTENT) {
    const previous = decode(base.OPENCODE_CONFIG_CONTENT);
    const next = decode(plugins.OPENCODE_CONFIG_CONTENT);
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      ...previous,
      ...next,
      mcp: { ...previous.mcp, ...next.mcp },
      command: { ...previous.command, ...next.command },
      agent: { ...previous.agent, ...next.agent },
      instructions: [...(previous.instructions ?? []), ...(next.instructions ?? [])],
      skills: {
        ...previous.skills,
        ...next.skills,
        paths: [...(previous.skills?.paths ?? []), ...(next.skills?.paths ?? [])],
      },
    });
    if (Buffer.byteLength(env.OPENCODE_CONFIG_CONTENT) > 64 * 1024)
      throw new Error("Provider override exceeds byte limit");
  }
  return env;
}
