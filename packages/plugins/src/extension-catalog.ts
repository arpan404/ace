import { projectionName } from "./project-shared.ts";
import type { CatalogEntry, ProviderKind } from "@ace/protocol";
import type { PluginSnapshot } from "./types.ts";
/** Names match the existing provider projection. No templates or executable configuration leave here. */
export function pluginCatalog(
  provider: ProviderKind,
  snapshots: readonly PluginSnapshot[],
): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const snapshot of snapshots) {
    const plugin = snapshot.install.name;
    const source = { provider: "ace" as const, scope: "ace" as const, plugin };
    entries.push({
      id: `ace:plugin:${plugin}`,
      kind: "plugin",
      name: plugin,
      description: snapshot.manifest.description ?? "",
      source,
      invocation: { type: "plugin", name: plugin },
    });
    for (const [kind, components] of [
      ["skill", snapshot.manifest.skills],
      ["command", snapshot.manifest.commands],
      ["agent", snapshot.manifest.agents],
    ] as const) {
      for (const component of components) {
        if (entries.length >= 512) return entries;
        const name =
          provider === "opencode" || provider === "codex"
            ? projectionName(plugin, component.name)
            : `${plugin}:${component.name}`;
        entries.push({
          id: `ace:plugin:${plugin}:${kind}:${component.name}`,
          kind,
          name: `${plugin}:${component.name}`,
          description: component.description ?? "",
          source,
          invocation:
            provider === "acp" || provider === "antigravity" || provider === "pi"
              ? {
                  type: "unavailable",
                  reason: "This provider cannot load portable plugin components",
                }
              : provider === "opencode" && kind === "skill"
                ? {
                    type: "unavailable",
                    reason:
                      "Use the native skill ID advertised by the server after session startup",
                  }
                : kind === "agent"
                  ? { type: "agent", name }
                  : provider === "codex"
                    ? {
                        type: "unavailable",
                        reason: "Use the skill advertised by the app-server after session startup",
                      }
                    : { type: "slash", name },
        });
      }
    }
  }
  return entries;
}
