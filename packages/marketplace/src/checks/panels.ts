import { validateHtml } from "@ace/html";
import type { MarketProblem } from "@ace/protocol/marketplace";
import type { ArchiveFile } from "../archive.ts";
import { text } from "../listing.ts";
import { panelFiles } from "../surfaces.ts";

/*
 * A package's panel pages (ADR 0200 §5.2): each panel `surfaces` declares is one self-contained
 * page, `panels/<id>/index.html`, its scripts and styles inline and its images `data:` URLs, as
 * ace's sandboxed pages are (ADR 0077). Its frame's CSP loads nothing else, so any other file
 * under `panels/` would never be served and is refused rather than shipped unused. Pure.
 */

/** A panel page's largest size, as Spade keeps it (`spade_core::panel::MOST_PAGE_BYTES`). */
export const mostPanelBytes = 2 * 1024 * 1024;

/** What's wrong with the panel pages of a package whose `bot.json` declares `surfaces`. */
export function panelProblems(surfaces: unknown, files: readonly ArchiveFile[]): MarketProblem[] {
  const pages = new Set(panelFiles(surfaces).values());
  const problems: MarketProblem[] = [];
  for (const file of files)
    if (file.path.startsWith("panels/") && !pages.has(file.path))
      problems.push({
        path: file.path,
        message: `${file.path} isn't a declared panel's page: a panel is one page, panels/<id>/index.html, with its styles, scripts and images inline`,
      });
  for (const path of pages) {
    const file = files.find((entry) => entry.path === path);
    const page = file && text(file.content);
    if (page === undefined) {
      problems.push({
        path,
        message: file
          ? `${path} isn't text`
          : `${path} is declared in surfaces but isn't in the package`,
      });
      continue;
    }
    if (file && file.content.byteLength > mostPanelBytes) {
      problems.push({ path, message: `${path} is larger than 2 MB` });
      continue;
    }
    for (const diagnostic of validateHtml(page).diagnostics)
      problems.push({ path, message: `${path}: ${diagnostic.message}` });
  }
  return problems;
}
