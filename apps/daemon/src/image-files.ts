import { constants } from "node:fs";
import { open, lstat, realpath, stat as pathStat } from "node:fs/promises";
import { isAbsolute, parse, join } from "node:path";
import { Agent, type ThreadId } from "@ace/protocol";
import type { Store } from "./store.ts";

/** Read exactly one regular image file of at most `maxBytes`, never following filesystem links. */
export async function readImageFile(path: string, maxBytes = 8 * 1024 * 1024): Promise<Buffer> {
  const root = parse(path).root;
  let part = root;
  for (const segment of path.slice(root.length).split("/").filter(Boolean)) {
    part = join(part, segment);
    if ((await lstat(part)).isSymbolicLink()) throw new Error("Image is a symbolic link");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    const sameFile = async () => {
      const current = await pathStat(path);
      const opened = await file.stat();
      return (
        (await realpath(path)) === path &&
        current.ino === stat.ino &&
        current.dev === stat.dev &&
        opened.size === stat.size &&
        opened.mtimeMs === stat.mtimeMs &&
        opened.ctimeMs === stat.ctimeMs &&
        current.size === stat.size &&
        current.mtimeMs === stat.mtimeMs &&
        current.ctimeMs === stat.ctimeMs
      );
    };
    if (!(await sameFile()) || !stat.isFile() || stat.size > maxBytes)
      throw new Error("Image unavailable");
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== stat.size || !(await sameFile())) throw new Error("Image changed while reading");
    return bytes.subarray(0, size);
  } finally {
    await file.close();
  }
}

/** The working directory an agent reported, when it is absolute. */
export function agentCwd(store: Store, thread: ThreadId, agentId: string): string | undefined {
  const row = store
    .statement("SELECT value FROM view_entities WHERE thread_id=? AND collection='agents' AND id=?")
    .get(thread, agentId);
  const cwd = row ? Agent.parse(JSON.parse(String(row.value))).cwd : undefined;
  return typeof cwd === "string" && isAbsolute(cwd) ? cwd : undefined;
}

/** Where an agent's relative paths start: its own folder, else the thread's ready workspace. */
export function agentDirectory(
  store: Store,
  thread: ThreadId,
  agentId: string,
): string | undefined {
  const cwd = agentCwd(store, thread, agentId);
  if (cwd) return cwd;
  const binding = store.executionWorkspace(thread);
  return binding.ready ? binding.path : undefined;
}
