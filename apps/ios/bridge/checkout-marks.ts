import { fileLanguage, gitPatchFiles, lineMarks, pathParts, type LineMark } from "@ace/ui-core";

/*
 * What the iOS file screen draws beside and over a file's text, pure: the lines changed since the
 * last commit (shared `lineMarks`) from the checkout's `git diff`, and the language the phone
 * colours the text in (markit, natively, off the main thread).
 */

/** Lines of `path` changed since the last commit, as [line, mark] pairs (1-based lines). */
export function changedLines(patch: string, path: string): [number, LineMark][] {
  const file = gitPatchFiles(patch).find((each) => each.path === path);
  return file?.rows.length ? [...lineMarks(file.rows)] : [];
}

/**
 * The language markit colours `path` in: the shared highlighter's name for its extension, else
 * the extension itself (markit reads names such as `yaml`, `md`, `css` and `toml`, and shows a
 * language it doesn't know plain). Undefined for a file without one.
 */
export function highlightLanguage(path: string): string | undefined {
  const known = fileLanguage(path);
  if (known) return known;
  const name = pathParts(path).name.toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : undefined;
}
