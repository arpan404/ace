import { constants } from "node:fs";
import { chmod, copyFile } from "node:fs/promises";
import { extname, join } from "node:path";

/** "report.pdf", then "report (1).pdf", "report (2).pdf", … as a browser names a taken file. */
export function numberedName(filename: string, attempt: number): string {
  if (attempt === 0) return filename;
  const extension = extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  return `${stem} (${attempt})${extension}`;
}

/**
 * Saves a finished download into the person's folder under its own name, never over an
 * existing file: the first free numbered name. A clone where the filesystem can (APFS, btrfs),
 * a copy elsewhere. Readable like any file the person saves. Returns the saved path.
 */
export async function saveInFolder(
  source: string,
  folder: string,
  filename: string,
): Promise<string> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const path = join(folder, numberedName(filename, attempt));
    try {
      await copyFile(source, path, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      await chmod(path, 0o644).catch(() => {});
      return path;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  throw new Error("No free name for the download");
}
