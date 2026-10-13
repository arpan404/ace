import { realpath, stat } from "node:fs/promises";
import { join, parse, sep } from "node:path";
import { ProjectName } from "@ace/protocol";
import { PinnedDirectory } from "@ace/workspace";
import { ProjectError, absoluteProjectPath } from "./project-policy.ts";

/*
 * `mkdir -p` for a project folder: find the deepest folder that exists, then make the rest one
 * name at a time through descriptors, so a symlink swapped in mid-way can't redirect them.
 * Folders made here can be removed again while they are still empty.
 */

/** A folder to make: the deepest existing folder above it and the names still missing. */
export interface FolderPlan {
  /** Canonical path of the folder once made. */
  path: string;
  /** The deepest existing folder on the way, canonical. */
  base: string;
  missing: readonly string[];
}

/** Folders made for a plan, kept open so they can be removed again. */
export interface MadeFolders {
  /** Remove the folders this made, deepest first, wherever they are still empty. */
  undo(): void;
  close(): Promise<void>;
}

const refused = new Set(["EACCES", "EPERM", "EROFS"]);
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

/**
 * What making `input` takes. Refuses a relative path or one with `..` (`invalid_path`), a file
 * at the path or on the way to it (`blocked_by_file`), and a place it can't look into
 * (`permission_denied`). Policy (allowed roots, system folders) is the caller's.
 */
export async function planFolders(input: string): Promise<FolderPlan> {
  absoluteProjectPath(input);
  const { root } = parse(input);
  const names = input
    .slice(root.length)
    .split(sep === "\\" ? /[\\/]/ : "/")
    .filter((name) => name !== "" && name !== ".");
  for (let depth = names.length; depth >= 0; depth--) {
    const candidate = join(root, ...names.slice(0, depth));
    let directory: boolean;
    let base: string;
    try {
      directory = (await stat(candidate)).isDirectory();
      base = await realpath(candidate);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      if (code && refused.has(code)) throw new ProjectError("permission_denied");
      throw new ProjectError("directory_unavailable");
    }
    if (!directory) throw new ProjectError("blocked_by_file");
    const missing = names.slice(depth);
    if (missing.some((name) => !ProjectName.safeParse(name).success))
      throw new ProjectError("invalid_path");
    return { base, missing, path: join(base, ...missing) };
  }
  throw new ProjectError("directory_unavailable");
}

/** Make a plan's missing folders. A folder that appears meanwhile is used as it is. */
export async function makeFolders(plan: FolderPlan): Promise<MadeFolders> {
  const opened: PinnedDirectory[] = [];
  const made: { parent: PinnedDirectory; name: string }[] = [];
  const undo = () => {
    for (const { parent, name } of made.toReversed()) {
      try {
        parent.removeDirectory(name);
      } catch {
        /* Something was put inside it, or it's gone: leave it. */
      }
    }
    made.length = 0;
  };
  const close = async () => {
    await Promise.all(opened.map((handle) => handle.close()));
  };
  try {
    let parent: PinnedDirectory;
    try {
      parent = PinnedDirectory.open(plan.base);
    } catch {
      throw new ProjectError("project_path_changed");
    }
    opened.push(parent);
    for (const name of plan.missing) {
      let child: PinnedDirectory;
      try {
        child = parent.mkdir(name);
        made.push({ parent, name });
      } catch (error) {
        const code = errorCode(error);
        if (code && refused.has(code)) throw new ProjectError("permission_denied");
        if (code !== "EEXIST") throw error;
        try {
          child = parent.child(name);
        } catch {
          throw new ProjectError("blocked_by_file");
        }
      }
      opened.push(child);
      parent = child;
    }
  } catch (error) {
    undo();
    await close();
    throw error;
  }
  return { undo, close };
}
