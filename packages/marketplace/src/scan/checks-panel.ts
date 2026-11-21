import { validateHtml } from "@ace/html";
import type { MarketScanFinding } from "@ace/protocol/marketplace";
import type { ArchiveFile } from "../archive.ts";
import { text } from "../listing.ts";
import { panelFiles } from "../surfaces.ts";

/*
 * A package's panels under the `scene` check (ADR 0200 §5.2, ADR 0174 §8): a panel is code that
 * runs only in its frame, like a Suit's scene, so a version with one is runnable and a maintainer
 * reviews it (`runnable.ts`); this is the static half. A page that reaches outside its sandbox
 * (another page, a web address, a frame, a form) is a block. The opaque-origin frame and its CSP
 * stay as the runtime boundary, so a page this misreads still can't reach the network or ace.
 */

/** The `bot.json` `surfaces` of a package's files, read leniently. */
export function declaredSurfaces(files: readonly ArchiveFile[]): unknown {
  const bot = text(files.find((file) => file.path === "bot.json")?.content);
  if (bot === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(bot);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)["surfaces"]
      : undefined;
  } catch {
    return undefined;
  }
}

/** Each declared panel's page, as its path. */
export function panelPages(files: readonly ArchiveFile[]): string[] {
  return [...panelFiles(declaredSurfaces(files)).values()];
}

/** The `scene` check over a package's panel pages. */
export function panelCheck(files: readonly ArchiveFile[]): MarketScanFinding[] {
  const findings: MarketScanFinding[] = [];
  for (const path of panelPages(files)) {
    const page = text(files.find((file) => file.path === path)?.content);
    if (page === undefined) continue;
    for (const diagnostic of validateHtml(page).diagnostics)
      findings.push({
        check: "scene",
        rule: `panel-${diagnostic.code}`,
        level: "block",
        path,
        message: `${path}: ${diagnostic.message} A panel's page stays inside its sandbox.`,
      });
  }
  return findings;
}
