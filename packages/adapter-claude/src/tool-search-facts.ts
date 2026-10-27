import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ClaudeToolSearchFacts } from "@ace/mcp-server";

type SettingSource = "user" | "project" | "local";
const Settings = z.looseObject({
  env: z.record(z.string(), z.unknown()).optional().catch(undefined),
  model: z.unknown().optional(),
  permissions: z
    .looseObject({ deny: z.array(z.unknown()).optional().catch(undefined) })
    .optional()
    .catch(undefined),
});
type Settings = z.infer<typeof Settings>;

/**
 * What Claude Code will see when it decides on tool search: the launch env with each loaded
 * settings file's `env` over it (local over project over user, as the CLI applies them), the
 * model (`--model`, then `ANTHROPIC_MODEL`, then settings), and whether a deny rule names
 * `ToolSearch`. A settings file that is missing or unreadable adds nothing.
 */
export async function claudeToolSearchFacts(input: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  sources: readonly SettingSource[];
  model?: string | undefined;
}): Promise<ClaudeToolSearchFacts> {
  const files = await Promise.all(
    (["user", "project", "local"] as const)
      .filter((source) => input.sources.includes(source))
      .map((source) => readSettings(settingsPath(source, input.env, input.cwd))),
  );
  const env: Record<string, string | undefined> = { ...input.env };
  let settingsModel: string | undefined;
  let toolSearchDenied = false;
  for (const settings of files) {
    for (const [key, value] of Object.entries(settings?.env ?? {}))
      if (typeof value === "string") env[key] = value;
    if (typeof settings?.model === "string") settingsModel = settings.model;
    if (settings?.permissions?.deny?.includes("ToolSearch")) toolSearchDenied = true;
  }
  return {
    env,
    model: input.model || env["ANTHROPIC_MODEL"] || settingsModel,
    toolSearchDenied,
  };
}

function settingsPath(source: SettingSource, env: NodeJS.ProcessEnv, cwd: string): string {
  if (source === "user")
    return join(
      env["CLAUDE_CONFIG_DIR"] || join(env["HOME"] || homedir(), ".claude"),
      "settings.json",
    );
  return join(cwd, ".claude", source === "local" ? "settings.local.json" : "settings.json");
}

async function readSettings(path: string): Promise<Settings | undefined> {
  try {
    const parsed = Settings.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
