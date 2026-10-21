import { gitPatchFiles, lineMarks, type LineMark } from "@ace/ui-core";
import { sourceHighlight } from "@ace/ui-core/source-highlight";

/*
 * What the iOS file screen draws over a file's text, pure: the web's grammar colours (shared
 * `sourceHighlight`, a light and a dark colour per token) as compact runs, and the lines changed
 * since the last commit (shared `lineMarks`) from the checkout's `git diff`.
 */

/** Text past this many UTF-16 units shows uncoloured: its runs would outweigh the text. */
export const colourLimit = 256 * 1024;
/** Runs past this many show uncoloured for the same reason. */
const runLimit = 120_000;

export interface ColourRuns {
  /** Each colour as [light, dark] hex; a run's colour 0 means the text's own colour. */
  colours: [string, string][];
  /** Flat [length, colour, length, colour, …] in UTF-16 units, covering the whole text. */
  runs: number[];
}

/** The grammar colours of `text`, or undefined when it shows plain (no grammar, too large). */
export async function colourRuns(
  text: string,
  lang: string | undefined,
): Promise<ColourRuns | undefined> {
  if (!lang || !text || text.length > colourLimit) return undefined;
  const lines = await sourceHighlight(text, lang).catch(() => undefined);
  if (!lines) return undefined;
  const colours: [string, string][] = [];
  const index = new Map<string, number>();
  const runs: number[] = [];
  let covered = 0;
  const push = (length: number, colour: number) => {
    if (!length) return;
    covered += length;
    const last = runs.length - 2;
    if (last >= 0 && runs[last + 1] === colour) runs[last] = (runs[last] ?? 0) + length;
    else runs.push(length, colour);
  };
  lines.forEach((line, at) => {
    if (at > 0) push(1, 0);
    for (const token of line) {
      let colour = 0;
      if (token.light && token.dark) {
        const key = `${token.light}${token.dark}`;
        colour = index.get(key) ?? 0;
        if (!colour) {
          colours.push([token.light, token.dark]);
          colour = colours.length;
          index.set(key, colour);
        }
      }
      push(token.text.length, colour);
    }
  });
  // Runs must spell the text exactly, or the colours would land on the wrong characters.
  if (covered !== text.length || runs.length / 2 > runLimit) return undefined;
  return { colours, runs };
}

/** Lines of `path` changed since the last commit, as [line, mark] pairs (1-based lines). */
export function changedLines(patch: string, path: string): [number, LineMark][] {
  const file = gitPatchFiles(patch).find((each) => each.path === path);
  return file?.rows.length ? [...lineMarks(file.rows)] : [];
}
