import { renderRunbook } from "./html.ts";
import { paths } from "./registry.ts";
import { renderMarkdown, renderOutreach, slackManifest } from "./render.ts";
import type { Registry } from "./types.ts";

/** Every file `render` writes, by repository path. Only the checklist is committed. */
export function artefacts(registry: Registry): Map<string, string> {
  const files = new Map<string, string>([
    [paths.doc, renderMarkdown(registry)],
    [`${paths.out}/runbook.html`, renderRunbook(registry)],
    [`${paths.out}/slack-manifest.json`, `${JSON.stringify(slackManifest(registry), null, 2)}\n`],
  ]);
  for (const entry of registry.registrations)
    if (entry.kind === "approval")
      files.set(`${paths.out}/outreach/${entry.id}.md`, renderOutreach(entry, registry.app));
  return files;
}
