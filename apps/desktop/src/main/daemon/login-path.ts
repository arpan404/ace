import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";

/**
 * The login shell's PATH saved by the last launch (`spawn-path.ts`), in the app's data folder.
 * Undefined when there is none or it is unreadable: the launch then waits for the shell.
 */
export function readSavedPath(file: string): string | undefined {
  try {
    const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof saved !== "object" || saved === null || !("path" in saved)) return undefined;
    return typeof saved.path === "string" && saved.path ? saved.path : undefined;
  } catch {
    return undefined;
  }
}

/** Saves the login shell's PATH for the next launch; a crash mid-write leaves the old file. */
export async function writeSavedPath(file: string, path: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ path })}\n`);
  await rename(temporary, file);
}
