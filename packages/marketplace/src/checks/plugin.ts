import type { PluginReview } from "@ace/protocol/plugins";

type PluginExecution = PluginReview["executions"][number];
import type { MarketProblem } from "@ace/protocol/marketplace";
import { executionsOf, importPlugin, validateComponents } from "@ace/plugins/import";
import type { ArchiveFile } from "../archive.ts";
import { text } from "../listing.ts";
import { secretFileProblem } from "../secrets.ts";

/** A plugin's facts for its review: ADR 0014's executions and what it can't bring. */
export interface PluginInspection {
  type: "spade-plugin";
  pluginName: string;
  version: string;
  executions: PluginExecution[];
  unsupported: string[];
}

/** The files ADR 0014's importer reads as text. */
const importedText = /\.(?:json|md|mdc|markdown|txt)$/;

/** An ADR 0014 plugin folder, through the same importer and component check as `prepare`. */
export function checkPlugin(
  name: string,
  files: readonly ArchiveFile[],
): { inspection: PluginInspection | undefined; problems: MarketProblem[] } {
  const problems: MarketProblem[] = [];
  for (const file of files) {
    const named = secretFileProblem(file.path);
    if (named) problems.push(named);
  }
  const map: Record<string, string> = Object.create(null);
  for (const file of files) {
    if (file.path === "market.json" || !importedText.test(file.path)) continue;
    const content = text(file.content);
    if (content === undefined)
      problems.push({ path: file.path, message: `${file.path} isn't UTF-8 text` });
    else map[file.path] = content;
  }
  try {
    const imported = importPlugin(map);
    validateComponents(imported, map);
    if (imported.manifest.name !== name)
      problems.push({
        message: `The plugin's manifest names it ${imported.manifest.name}, not ${name}`,
      });
    return {
      inspection: {
        type: "spade-plugin",
        pluginName: imported.manifest.name,
        version: imported.manifest.version,
        executions: executionsOf(imported.manifest),
        unsupported: imported.unsupported,
      },
      problems,
    };
  } catch (error) {
    problems.push({
      message: error instanceof Error ? error.message.slice(0, 500) : "The plugin doesn't import",
    });
    return { inspection: undefined, problems };
  }
}
