import { unwrapShellCommand } from "@ace/provider-kit/shell-command";
import { realpathSync, statSync } from "node:fs";
import { resolve, relative, dirname, basename, isAbsolute } from "node:path";
import { containsSecretReference, inspectionCommand, type PathRisk } from "@ace/core";
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
export function permissionPaths(
  workspace: string,
  target?: ApprovalTarget,
  attachmentRead: (path: string) => boolean = () => false,
): PathRisk[] {
  if (!target) return [];
  const inspection = target.command ? inspectionCommand(target.command) : undefined;
  const paths = inspection?.paths ?? target.paths ?? [];
  const cwd = resolve(workspace, target.cwd ?? ".");
  // Command cwd is checked independently; file path results retain their one-to-one ordering.
  const check = (path: string): PathRisk => {
    if (containsSecretReference(path)) return "secret";
    try {
      const root = realpathSync(workspace);
      const destination = physical(resolve(cwd, path));
      if (containsSecretReference(destination)) return "secret";
      if (target.access === "read" && attachmentRead(destination)) return "workspace";
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
  const results = paths.map((path) => {
    const risk = check(path);
    if (risk !== "workspace") return risk;
    if (target.access === "write") {
      try {
        return statSync(resolve(cwd, path)).isFile() ? "workspace" : "unknown";
      } catch (error) {
        return error instanceof Error && "code" in error && error.code === "ENOENT"
          ? "workspace"
          : "unknown";
      }
    }
    if (target.access !== "read" && !inspection?.regularFiles) return risk;
    try {
      return statSync(resolve(cwd, path)).isFile() ? "workspace-file" : "workspace";
    } catch {
      return "unknown";
    }
  });
  if (inspection) {
    for (const path of target.paths ?? []) {
      if (paths.includes(path)) continue;
      const risk = check(path);
      if (risk === "outside" || risk === "secret" || risk === "unknown") results.push(risk);
    }
  }
  const cwdRisk = check(cwd);
  if (cwdRisk !== "workspace") results.push(cwdRisk);
  return results;
}

/** Only root-owned, non-writable system shells outside the workspace can shed their wrapper. */
export function permissionShells(workspace: string, target?: ApprovalTarget): string[] {
  const wrapper = target?.command && unwrapShellCommand(target.command);
  if (!wrapper || !/^\/(?:usr\/)?bin\/(?:sh|bash|zsh|dash|fish)$/.test(wrapper.shell)) return [];
  try {
    const path = realpathSync(wrapper.shell);
    if (!/^\/(?:usr\/)?bin\/(?:sh|bash|zsh|dash|fish)$/.test(path)) return [];
    const root = realpathSync(workspace);
    const diff = relative(root, path);
    if (diff === "" || (!isAbsolute(diff) && diff !== ".." && !diff.startsWith("../"))) return [];
    if (!statSync(path).isFile()) return [];
    for (let cursor = path; ; cursor = dirname(cursor)) {
      const info = statSync(cursor);
      if (info.uid !== 0 || (info.mode & 0o022) !== 0) return [];
      if (dirname(cursor) === cursor) break;
    }
    return [wrapper.shell];
  } catch {
    return [];
  }
}

/** Resolve the command through the launch PATH and trust only immutable system utilities. */
export function permissionCommands(
  workspace: string,
  target?: ApprovalTarget,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const inspection = target?.command && inspectionCommand(target.command);
  if (!inspection || inspection.executable === "pwd") return [];
  for (const directory of (env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    const candidate = resolve(workspace, directory, inspection.executable);
    try {
      const info = statSync(candidate);
      if (!info.isFile() || !(info.mode & 0o111)) continue;
      const path = realpathSync(candidate);
      if (
        !new Set([`/bin/${inspection.executable}`, `/usr/bin/${inspection.executable}`]).has(path)
      )
        return [];
      for (let cursor = path; ; cursor = dirname(cursor)) {
        const stat = statSync(cursor);
        if (stat.uid !== 0 || stat.mode & 0o022) return [];
        if (dirname(cursor) === cursor) break;
      }
      return [inspection.executable];
    } catch {
      /* Missing PATH entry. */
    }
  }
  return [];
}
