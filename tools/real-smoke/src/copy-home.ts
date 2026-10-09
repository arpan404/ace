import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { backupStore } from "./backup.ts";
import { inside } from "./paths.ts";
import { z } from "zod";

// Deliberately no directory traversal or glob. Credential stores never enter this list.
const stores = [
  "events.sqlite",
  "models.sqlite",
  "accounts.sqlite",
  "automations.sqlite",
  "onboarding.sqlite",
  "history/index.sqlite",
];
async function regular(path: string) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Safe state must be a regular file");
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
/** SQLite backup includes committed WAL data without copying live lock/token files. */
export async function copyHome(source: string, scratch: string): Promise<string[]> {
  const root = await realpath(source);
  const dest = await realpath(scratch);
  if (inside(root, dest)) throw new Error("Scratch must be outside source home");
  const copied: string[] = [];
  for (const name of ["settings.json", ...stores]) {
    const path = join(root, name);
    if (!(await regular(path))) continue;
    // A nested history directory may not redirect into credentials via a symlink.
    if ((await realpath(path)) !== resolve(path)) throw new Error("Safe state path is redirected");
    const target = join(dest, name);
    await mkdir(dirname(target), { recursive: true });
    if (name === "settings.json") {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (stat.size > 1024 * 1024) throw new Error("Settings exceed smoke copy budget");
        const settings = z
          .object({
            version: z.number(),
            settings: z.record(z.string(), z.json()).optional(),
            values: z.record(z.string(), z.json()).optional(),
          })
          .parse(JSON.parse(await file.readFile("utf8")));
        const values = settings.settings ?? settings.values ?? {};
        await writeFile(
          target,
          JSON.stringify({
            version: 2,
            settings: { ...values, "automations.enabled": false, "remote.enabled": false },
          }),
          { mode: 0o600 },
        );
      } finally {
        await file.close();
      }
    } else {
      try {
        await backupStore(path, target);
      } catch (error) {
        throw new Error(`Could not back up ${name}`, { cause: error });
      }
    }
    copied.push(name);
  }
  // An absent settings file must also disable scheduled execution.
  if (!copied.includes("settings.json"))
    await writeFile(
      join(dest, "settings.json"),
      JSON.stringify({ version: 2, settings: { "automations.enabled": false } }),
      { mode: 0o600 },
    );
  return copied;
}
