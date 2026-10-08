import { z } from "zod";
import { CatalogEntry } from "@ace/protocol";
const plugins = z
  .array(
    z.object({
      id: z.string().min(1).max(128),
      scope: z.string().max(32),
      enabled: z.boolean(),
      projectEnabled: z.boolean().optional(),
      projectPath: z.string().max(4096).nullish(),
      installPath: z.string().max(4096),
    }),
  )
  .max(256);
/** Installed registry metadata from the CLI, without reading settings, marketplace code or MCP secrets. */
export function claudePluginCatalog(input: unknown, cwd: string): CatalogEntry[] {
  const parsed = plugins.safeParse(input);
  if (!parsed.success) return [];
  const entries: CatalogEntry[] = [];
  for (const plugin of parsed.data) {
    const project = plugin.scope === "project" || plugin.scope === "local";
    if (project && plugin.projectPath !== cwd) continue;
    const name = plugin.id.split("@")[0];
    if (!name) continue;
    const entry = CatalogEntry.safeParse({
      id: `claude:plugin:${plugin.id}:${plugin.scope}`,
      kind: "plugin",
      name,
      description: "Installed Claude Code plugin",
      source: {
        provider: "claude",
        scope: project ? "project" : "global",
        path: plugin.installPath,
        plugin: plugin.id,
      },
      invocation: {
        type: "unavailable",
        reason:
          !plugin.enabled || plugin.projectEnabled === false
            ? "Disabled for this project"
            : "Not yet advertised as loaded by the provider session",
      },
    });
    if (entry.success) entries.push(entry.data);
  }
  return entries;
}
