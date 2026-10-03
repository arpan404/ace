import { PluginReview } from "@ace/protocol/plugins";
import { normalizePath } from "./manifest.ts";
import type { ImportedPlugin } from "./types.ts";

export function reviewPlugin(
  imported: ImportedPlugin,
  pin: { id: string; commit: string; hash: string },
): PluginReview {
  const { manifest } = imported;
  return PluginReview.parse({
    ...pin,
    name: manifest.name,
    version: manifest.version,
    unsupported: imported.unsupported,
    executions: [
      ...manifest.hooks.map((hook) => Object.assign({ kind: "hook" }, hook)),
      ...Object.entries(manifest.mcpServers).map(([name, server]) =>
        server.type === "stdio"
          ? {
              kind: "stdio",
              name,
              command: server.command,
              args: server.args,
              env: server.env,
              cwd: server.cwd,
            }
          : { kind: "remote", name, type: server.type, url: server.url, headers: server.headers },
      ),
    ],
  });
}
export function validateComponents(imported: ImportedPlugin, text: Record<string, string>): void {
  const { manifest } = imported;
  for (const entry of manifest.skills)
    if (text[`${normalizePath(entry.path)}/SKILL.md`] === undefined)
      throw new Error(`Skill missing: ${entry.name}`);
  for (const entry of [...manifest.commands, ...manifest.agents, ...manifest.rules]) {
    const path = normalizePath(entry.path);
    if (text[path] === undefined && imported.inlineFiles[path] === undefined)
      throw new Error(`Component missing: ${path}`);
  }
}
