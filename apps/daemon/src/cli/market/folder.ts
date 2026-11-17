import { lstat, opendir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { ArchiveFile } from "@ace/marketplace";
import { CliFailure } from "../output.ts";

/** A folder's regular files, as an archive would hold them; links and other kinds refused. */
export async function readFolder(root: string): Promise<ArchiveFile[]> {
  const files: ArchiveFile[] = [];
  const walk = async (folder: string, depth: number) => {
    if (depth > 32) throw new CliFailure("refused", `${folder} is nested too deep`);
    for await (const entry of await opendir(folder)) {
      const path = join(folder, entry.name);
      const name = relative(root, path).split(sep).join("/");
      if (entry.name === ".git") continue;
      if (entry.isSymbolicLink())
        throw new CliFailure("refused", `${name} is a link; an entry holds only its own files`);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile()) {
        const info = await lstat(path);
        files.push({
          path: name,
          executable: (info.mode & 0o111) !== 0,
          content: new Uint8Array(await readFile(path)),
        });
      } else throw new CliFailure("refused", `${name} isn't a regular file`);
    }
  };
  await walk(root, 0);
  return files;
}
