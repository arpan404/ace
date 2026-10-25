import { realpath } from "node:fs/promises";
import { PinnedDirectory } from "@ace/workspace/pinned-directory";
import { validMemberName } from "./folder-link.ts";
import {
  FolderReader,
  type FolderMember,
  type FolderPrune,
  type FolderWalk,
} from "./folder-walk.ts";

/**
 * Members for chosen paths of a folder, in sorted preorder: each path's parent directories once,
 * then the path itself, and a path ending in `/` with everything under it. Every step opens one
 * name from the pinned parent without following links, so a parent that is a link, or a path
 * that climbs out, is skipped and nothing outside the folder is read.
 */
export async function walkSelected(
  root: string,
  paths: readonly string[],
  options: { signal?: AbortSignal; prune?: FolderPrune } = {},
): Promise<FolderWalk> {
  const reader = new FolderReader(await realpath(root), options.signal, options.prune);
  const wanted = [...new Set(paths)].toSorted();
  async function* one(top: PinnedDirectory, entry: string, emitted: Set<string>) {
    const whole = entry.endsWith("/");
    const path = whole ? entry.slice(0, -1) : entry;
    if (!validMemberName(path)) {
      reader.skipped++;
      return;
    }
    const parts = path.split("/");
    const open: PinnedDirectory[] = [];
    let directory = top;
    try {
      for (const [index, name] of parts.entries()) {
        const relative = parts.slice(0, index + 1).join("/");
        const member = await reader.member(directory, name, relative);
        if (!member) return;
        const last = index === parts.length - 1;
        if (!last && member.kind !== "directory") {
          reader.skipped++;
          return;
        }
        if (member.kind !== "directory") {
          if (!emitted.has(relative) && !(await reader.pruned(member))) {
            emitted.add(relative);
            yield member;
          }
          return;
        }
        const child = reader.open(member);
        open.push(child);
        // A directory is judged once; its entry names are read only the first time.
        if (!emitted.has(relative)) {
          if (await reader.pruned(member, child)) return;
          emitted.add(relative);
          yield member;
        }
        if (last && whole) {
          for await (const inner of reader.descend(child, relative)) {
            emitted.add(inner.path);
            yield inner;
          }
        }
        directory = child;
      }
    } finally {
      for (const child of open) child.closeSync();
    }
  }
  async function* members(): AsyncGenerator<FolderMember> {
    const top = PinnedDirectory.open(reader.canonical);
    const emitted = new Set<string>();
    try {
      for (const entry of wanted) yield* one(top, entry, emitted);
    } finally {
      top.closeSync();
    }
  }
  return { members: members(), skipped: () => reader.skipped };
}
