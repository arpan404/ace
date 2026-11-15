import type { PluginAvailability, PluginSpade, PluginSpadeComponent } from "@ace/protocol/plugins";
import { componentTitle } from "./component-title.ts";
import { normalizePath } from "./manifest.ts";
import { executionsOf } from "./review.ts";
import type { PluginSnapshot } from "./types.ts";

/** The most text one component carries; a longer one is listed without it. */
const MOST_COMPONENT_TEXT = 262144;
/**
 * The most component text in one answer, leaving room under the 1 MiB wire limit for the
 * executions and JSON escaping. Components past it are listed without their text.
 */
const MOST_TEXT = 640 * 1024;

/** One accepted plugin as Spade's bots use it (ADR 0151): components with text, executions. */
export function spadeView(snapshot: PluginSnapshot, availability: PluginAvailability): PluginSpade {
  const components: PluginSpadeComponent[] = [];
  let budget = MOST_TEXT;
  for (const [kind, entries] of [
    ["skill", snapshot.manifest.skills],
    ["command", snapshot.manifest.commands],
    ["agent", snapshot.manifest.agents],
    ["rule", snapshot.manifest.rules],
  ] as const)
    for (const entry of entries) {
      const path =
        kind === "skill" ? `${normalizePath(entry.path)}/SKILL.md` : normalizePath(entry.path);
      const text = snapshot.text[path] ?? "";
      const title = componentTitle(text, entry.name);
      const bytes = Buffer.byteLength(text);
      const fits = text.length <= MOST_COMPONENT_TEXT && bytes <= budget;
      if (fits) budget -= bytes;
      components.push({
        kind,
        name: entry.name,
        path,
        description: entry.description ?? "",
        ...(title && title !== entry.name ? { title } : {}),
        ...(fits ? { text } : { omitted: "Too large to send with the plugin." }),
      });
    }
  return {
    install: snapshot.install,
    enabled: availability.enabled,
    root: snapshot.root,
    components,
    executions: executionsOf(snapshot.manifest),
    unsupported: snapshot.unsupported.slice(0, 512).map((line) => line.slice(0, 8192)),
  };
}
