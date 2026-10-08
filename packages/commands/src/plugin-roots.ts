import { join } from "node:path";
import { z } from "zod";
import type { DiscoveryRoot } from "./roots.ts";
import type { CatalogEntry } from "@ace/protocol";
const init = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  plugins: z
    .array(z.object({ name: z.string().min(1).max(128), path: z.string().min(1).max(4096) }))
    .max(128),
});
/** Only plugins confirmed by the harness registry are scanned. No settings or auth files are read. */
export function loadedPluginRoots(input: unknown, instance: string): DiscoveryRoot[] | undefined {
  const parsed = init.safeParse(input);
  if (!parsed.success) return undefined;
  return componentRoots(parsed.data.plugins, instance);
}
export function installedPluginRoots(
  entries: readonly CatalogEntry[],
  instance: string,
): DiscoveryRoot[] {
  return componentRoots(
    entries.flatMap((entry) =>
      entry.source.provider === "claude" &&
      entry.kind === "plugin" &&
      entry.source.path &&
      entry.invocation.type === "unavailable" &&
      entry.invocation.reason === "Not yet advertised as loaded by the provider session"
        ? [{ name: entry.name, path: entry.source.path }]
        : [],
    ),
    instance,
  );
}
function componentRoots(
  plugins: readonly { name: string; path: string }[],
  instance: string,
): DiscoveryRoot[] {
  return plugins.slice(0, 8).flatMap((plugin) => [
    {
      path: join(plugin.path, "skills"),
      trustedRoot: plugin.path,
      instance,
      scope: "user" as const,
      format: "claude" as const,
      skill: true,
      plugin: plugin.name,
    },
    {
      path: join(plugin.path, "commands"),
      trustedRoot: plugin.path,
      instance,
      scope: "user" as const,
      format: "claude" as const,
      plugin: plugin.name,
    },
    {
      path: join(plugin.path, "agents"),
      trustedRoot: plugin.path,
      instance,
      scope: "user" as const,
      format: "claude" as const,
      kind: "agent" as const,
      plugin: plugin.name,
    },
  ]);
}
