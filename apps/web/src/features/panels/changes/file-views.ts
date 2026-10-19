import type { FileDiff } from "@ace/ui-core";
import { useState } from "react";
import { freshView, type FileView } from "./file-view.ts";

/** A file viewed at its current version starts folded; one object, so its block stays memoized. */
const foldedView: FileView = { ...freshView, open: false };
const noVersions: ReadonlyMap<string, string> = new Map();

/**
 * How each file shows (open, folds expanded), kept by path and version so a file scrolled out
 * of a long list and back keeps it, and a new version of the file starts fresh. Files in
 * `folded` start collapsed; anything opened by hand stays as left.
 */
export function useFileViews(
  files: readonly FileDiff[],
  versions: ReadonlyMap<string, string> = noVersions,
  folded?: ReadonlySet<string>,
) {
  const [views, setViews] = useState<ReadonlyMap<string, { version: string; view: FileView }>>(
    () => new Map(),
  );
  const versionOf = (path: string) => versions.get(path) ?? "";
  const viewOf = (file: FileDiff): FileView => {
    const kept = views.get(file.path);
    if (kept && kept.version === versionOf(file.path)) return kept.view;
    return folded?.has(file.path) ? foldedView : freshView;
  };
  const setView = (path: string, next: FileView) =>
    setViews((previous) => new Map(previous).set(path, { version: versionOf(path), view: next }));
  const allCollapsed = files.length > 0 && files.every((file) => !viewOf(file).open);
  const collapseAll = (fold: boolean) =>
    setViews(
      new Map(
        files.map((file) => [
          file.path,
          { version: versionOf(file.path), view: { ...viewOf(file), open: !fold } },
        ]),
      ),
    );
  return { viewOf, setView, allCollapsed, collapseAll };
}
