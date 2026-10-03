import { realpathSync } from "node:fs";
import { resolve, relative, dirname, basename, isAbsolute } from "node:path";
import { containsSecretReference, type PathRisk } from "@ace/core";
import type { ApprovalTarget } from "@ace/protocol";

/** Resolve the closest existing ancestor for a new file; symlinks never grant lexical containment. */
function physical(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(physical(parent), basename(path));
  }
}
export function permissionPaths(workspace: string, target?: ApprovalTarget): PathRisk[] {
  if (!target) return [];
  const paths = target.paths ?? [];
  const cwd = resolve(workspace, target.cwd ?? ".");
  // Command cwd is checked independently; file path results retain their one-to-one ordering.
  const check = (path: string): PathRisk => {
    if (containsSecretReference(path)) return "secret";
    try {
      const root = realpathSync(workspace);
      const destination = physical(resolve(cwd, path));
      if (containsSecretReference(destination)) return "secret";
      const diff = relative(root, destination);
      return diff === "" ||
        (!isAbsolute(diff) &&
          diff !== ".." &&
          !diff.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
        ? "workspace"
        : "outside";
    } catch {
      return "unknown";
    }
  };
  const results = paths.map(check);
  const cwdRisk = check(cwd);
  if (cwdRisk !== "workspace") results.push(cwdRisk);
  return results;
}
