import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Throws a sentence for the person unless `path` is an existing folder this app can write. */
export async function writableFolder(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("Choose a folder with the folder picker");
  const info = await stat(path).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`${path} isn't a folder on this computer`);
  if (process.platform === "win32") return windowsWritable(path);
  await access(path, constants.W_OK).catch(() => {
    throw new Error(`ace can't save files in ${path}`);
  });
}

/** Windows `access` ignores a folder's ACLs: only creating a file there proves it is writable. */
async function windowsWritable(path: string): Promise<void> {
  const { randomUUID } = await import("node:crypto");
  const { open, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const probe = join(path, `.ace-write-check-${randomUUID()}`);
  const file = await open(probe, "wx").catch(() => {
    throw new Error(`ace can't save files in ${path}`);
  });
  await file.close();
  await rm(probe, { force: true });
}
