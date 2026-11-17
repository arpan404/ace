import { lstat, opendir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  credentialFile,
  maxArchiveBytes,
  pluginManifests,
  previewBytes,
  writeArchive,
  type ArchiveFile,
} from "@ace/marketplace";
import type { MarketDraftSource } from "@ace/protocol/marketplace";
import { Refused } from "./prepare.ts";
import { pictureType } from "./pictures.ts";

/*
 * A draft's bytes from what the app sends (ADR 0174 §5): a folder on this machine read as the
 * CLI reads one (regular files only, no links, `.git` left out) and written as the canonical
 * archive, or an archive the app made, decoded with a cap. Pictures are base64 decoded, capped.
 */

/** An archive the app sends is at most 6 MB (`MarketDraftSource`). */
const archiveSourceBytes = 6 * 1024 * 1024;

function decoded(text: string, limit: number, what: string): Uint8Array {
  const clean = text.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1)
    throw new Refused(`The ${what} isn't base64`, { code: "refused" });
  if (Math.floor((clean.length * 3) / 4) > limit + 2)
    throw new Refused(`The ${what} is larger than ${Math.round(limit / 1024)} KB`);
  const bytes = new Uint8Array(Buffer.from(clean, "base64"));
  if (bytes.byteLength > limit)
    throw new Refused(`The ${what} is larger than ${Math.round(limit / 1024)} KB`);
  return bytes;
}

/** How much a draft folder may hold: files, bytes in one file, bytes in all. */
export interface FolderLimits {
  files: number;
  fileBytes: number;
  totalBytes: number;
}
const anyEntry: FolderLimits = {
  files: 1024,
  fileBytes: maxArchiveBytes,
  totalBytes: maxArchiveBytes,
};

/** The hidden folders a plugin keeps its manifest in (`.claude-plugin/plugin.json`): kept. */
export const manifestFolders: ReadonlySet<string> = new Set(
  pluginManifests.filter((path) => path.includes("/")).map((path) => path.split("/")[0] ?? ""),
);

/** Whether a hidden name at `depth` (0 at the top) is left out. */
export const leftHome = (name: string, depth: number) =>
  name.startsWith(".") && !(depth === 0 && manifestFolders.has(name));

/** What a folder's read left out, and why: hidden, or named like a credential. */
export interface LeftOut {
  path: string;
  reason: "hidden" | "credential";
}

/**
 * A folder's own regular files. Hidden files and folders and files named like credentials are
 * left out before they are read, and said so; links and special files refuse the folder, as do
 * more files or bytes than `limits`.
 */
export async function readFolder(
  root: string,
  limits: FolderLimits = anyEntry,
): Promise<{ files: ArchiveFile[]; excluded: LeftOut[] }> {
  if (!isAbsolute(root)) throw new Refused("A draft's folder is named by its full path");
  const files: ArchiveFile[] = [];
  const excluded: LeftOut[] = [];
  let total = 0;
  const walk = async (folder: string, depth: number) => {
    if (depth > 32) throw new Refused(`${folder} is nested too deep`);
    for await (const entry of await opendir(folder)) {
      const path = join(folder, entry.name);
      const name = relative(root, path).split(sep).join("/");
      if (leftHome(entry.name, depth)) {
        if (entry.name !== ".git") excluded.push({ path: name, reason: "hidden" });
        continue;
      }
      if (entry.isSymbolicLink())
        throw new Refused(`${name} is a link; an entry holds only its own files`);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile()) {
        if (credentialFile(entry.name)) {
          excluded.push({ path: name, reason: "credential" });
          continue;
        }
        if (files.length >= limits.files)
          throw new Refused(`The folder holds more than ${limits.files} files`);
        const info = await lstat(path);
        if (info.size > limits.fileBytes)
          throw new Refused(`${name} is larger than ${Math.round(limits.fileBytes / 1024)} KB`);
        total += info.size;
        if (total > limits.totalBytes)
          throw new Refused(
            `The folder is larger than ${Math.round(limits.totalBytes / (1024 * 1024))} MB`,
          );
        files.push({
          path: name,
          executable: (info.mode & 0o111) !== 0,
          content: new Uint8Array(await readFile(path)),
        });
      } else throw new Refused(`${name} isn't a regular file`);
    }
  };
  try {
    await walk(root, 0);
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused(`The folder can't be read: ${error instanceof Error ? error.message : ""}`);
  }
  return { files, excluded };
}

/** The canonical archive a draft uploads, capped at what the Worker takes. */
export async function draftArchive(source: MarketDraftSource): Promise<Uint8Array> {
  if (source.kind !== "folder" && source.kind !== "archive")
    throw new Refused("What was picked is read by the daemon first");
  const archive =
    source.kind === "folder"
      ? writeArchive((await readFolder(source.path)).files)
      : decoded(source.archive, archiveSourceBytes, "archive");
  if (archive.byteLength > maxArchiveBytes)
    throw new Refused("The draft is larger than the market takes (40 MB)");
  return archive;
}

/** An avatar or listing picture's bytes and their type, by their first bytes. */
export function pictureBytes(base64: string): { bytes: Uint8Array; type: string } {
  const bytes = decoded(base64, previewBytes, "picture");
  const type = pictureType(bytes) ?? "application/octet-stream";
  return { bytes, type };
}
