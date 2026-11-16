import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { pluginSpadeFileLimits, type PluginSpadeFile } from "@ace/protocol/plugins";
import { assertNoSymlinks } from "./files.ts";
import { normalizePath } from "./manifest.ts";
import type { PackageFile, PluginSnapshot } from "./types.ts";

/** The skill folders of an accepted plugin, each as its path in the plugin. */
function skillFolders(snapshot: PluginSnapshot): string[] {
  return snapshot.manifest.skills.map((entry) => normalizePath(entry.path));
}

const hidden = (path: string) => path.split("/").some((part) => part.startsWith("."));

/**
 * A plugin skill's files besides SKILL.md, by their path in its folder (ADR 0151). Hidden
 * entries and files past the limits are left out. Pure: from the accepted snapshot alone.
 */
export function skillFiles(snapshot: PluginSnapshot, folder: string): PluginSpadeFile[] {
  const prefix = `${folder}/`;
  return [...snapshot.files]
    .filter(
      (file) =>
        file.path.startsWith(prefix) &&
        file.path !== `${prefix}SKILL.md` &&
        !hidden(file.path.slice(prefix.length)) &&
        file.bytes <= pluginSpadeFileLimits.bytes,
    )
    .toSorted((a, b) => a.path.localeCompare(b.path))
    .slice(0, pluginSpadeFileLimits.files)
    .map((file) => ({
      path: file.path.slice(prefix.length),
      bytes: file.bytes,
      hash: file.hash,
      executable: file.executable,
    }));
}

/** The accepted file at `path` in the plugin when it is one of a skill's files Spade is told about. */
function skillFile(snapshot: PluginSnapshot, path: string): PackageFile | undefined {
  const wanted = normalizePath(path);
  const folder = skillFolders(snapshot).find((each) => wanted.startsWith(`${each}/`));
  if (folder === undefined) return undefined;
  const listed = skillFiles(snapshot, folder).some((file) => `${folder}/${file.path}` === wanted);
  return listed ? snapshot.files.find((file) => file.path === wanted) : undefined;
}

/**
 * One file of an accepted plugin's skill, read through a handle that follows no link and checked
 * against the size and hash the person accepted.
 */
export async function readSpadeFile(snapshot: PluginSnapshot, path: string) {
  const file = skillFile(snapshot, path);
  if (!file) throw new Error("Not a file of this plugin's skills");
  const absolute = join(snapshot.root, file.path);
  await assertNoSymlinks(absolute);
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Special file forbidden");
    if (info.size !== file.bytes) throw new Error("Integrity mismatch");
    const bytes = Buffer.alloc(file.bytes);
    let read = 0;
    while (read < file.bytes) {
      const { bytesRead } = await handle.read(bytes, read, file.bytes - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, read);
    if (read !== file.bytes || extra.bytesRead !== 0) throw new Error("Integrity mismatch");
    if (createHash("sha256").update(bytes).digest("hex") !== file.hash)
      throw new Error("Integrity mismatch");
    return {
      path: file.path,
      hash: file.hash,
      executable: file.executable,
      content: bytes.toString("base64"),
    };
  } finally {
    await handle.close();
  }
}
