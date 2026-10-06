import type { Intake } from "./folder-files.ts";

export type { Intake };

/*
 * Files a drop or paste carries. Entries are read while the event lasts (the browser empties
 * the transfer afterwards); a dropped folder is walked after it, by code loaded only then.
 */

/** Hand `take` the transfer's files, a dropped folder's contained files included. */
export function takeTransfer(data: DataTransfer, take: (intake: Intake) => void): void {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(data.items ?? [])) {
    const entry = item.kind === "file" ? item.webkitGetAsEntry?.() : null;
    if (entry) entries.push(entry);
  }
  if (!entries.some((entry) => entry.isDirectory)) {
    if (data.files.length) take({ files: [...data.files] });
    return;
  }
  void import("./folder-files.ts")
    .then(({ filesIn }) => filesIn(entries))
    .then(take, () => take({ files: [], note: "Couldn't read that folder." }));
}

/** Whether a drag carries files (a dragged link or text selection doesn't). */
export function carriesFiles(data: DataTransfer | null): boolean {
  return !!data && Array.from(data.types).includes("Files");
}
