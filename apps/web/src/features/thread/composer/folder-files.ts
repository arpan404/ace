/*
 * The files inside dropped folders, breadth first and bounded: at most 50 files, skipping
 * hidden entries (`.git`, `.DS_Store`), and at most 2,000 entries looked at, so a dropped
 * `node_modules` costs a moment rather than the tab.
 */

/** What arrived: the files, and a note when a folder held more than was attached. */
export interface Intake {
  files: File[];
  note?: string | undefined;
}

/** Files one dropped folder (or several) can add to a message. */
export const folderFileLimit = 50;
const visitLimit = 2_000;

const isFile = (entry: FileSystemEntry): entry is FileSystemFileEntry => entry.isFile;
const isDirectory = (entry: FileSystemEntry): entry is FileSystemDirectoryEntry =>
  entry.isDirectory;

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** A folder's entries; the reader hands them out in batches until an empty one. */
function childrenOf(folder: FileSystemDirectoryEntry, budget: number): Promise<FileSystemEntry[]> {
  const reader = folder.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    const next = () =>
      reader.readEntries((batch) => {
        all.push(...batch);
        if (!batch.length || all.length >= budget) resolve(all);
        else next();
      }, reject);
    next();
  });
}

/** The files of dropped entries: loose files as they are, folders walked within the limits. */
export async function filesIn(entries: readonly FileSystemEntry[]): Promise<Intake> {
  const files: File[] = [];
  const queue = [...entries];
  let visited = 0;
  let more = false;
  for (let at = 0; at < queue.length; at++) {
    const entry = queue[at];
    if (!entry) continue;
    if (++visited > visitLimit) {
      more = true;
      break;
    }
    if (isFile(entry)) {
      if (files.length === folderFileLimit) {
        more = true;
        break;
      }
      files.push(await fileOf(entry));
    } else if (isDirectory(entry))
      for (const child of await childrenOf(entry, visitLimit))
        if (!child.name.startsWith(".")) queue.push(child);
  }
  return {
    files,
    note: more
      ? `Attached the first ${folderFileLimit} files. A dropped folder adds up to ${folderFileLimit}; hidden files are skipped.`
      : files.length
        ? undefined
        : "That folder has no files to attach.",
  };
}
