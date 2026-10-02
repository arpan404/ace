import { lstat, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { SettingsError } from "./validation.ts";

export async function workspaceGuard(root: string): Promise<() => Promise<void>> {
  const canonical = await realpath(root);
  return async () => {
    if ((await realpath(root)) !== canonical)
      throw new SettingsError("validation", "Workspace root changed during settings access");
    for (const path of [resolve(canonical, ".ace"), resolve(canonical, ".ace", "settings.json")]) {
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink())
          throw new SettingsError("validation", "Workspace settings cannot use symlink components");
        const actual = await realpath(path);
        const inside = relative(canonical, actual);
        if (inside.startsWith("..") || isAbsolute(inside))
          throw new SettingsError(
            "validation",
            "Workspace settings must stay within the workspace",
          );
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        break;
      }
    }
  };
}
