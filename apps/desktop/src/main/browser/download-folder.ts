import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Throws a sentence for the person unless `path` is an existing folder this app can write. */
export async function writableFolder(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("Choose a folder with the folder picker");
  const info = await stat(path).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`${path} isn't a folder on this computer`);
  await access(path, constants.W_OK).catch(() => {
    throw new Error(`ace can't save files in ${path}`);
  });
}
