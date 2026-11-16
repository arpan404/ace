import { lstat, opendir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { maxArchiveBytes, previewBytes, writeArchive, type ArchiveFile } from "@ace/marketplace";
import type { MarketDraftSource } from "@ace/protocol/marketplace";
import { Refused } from "./prepare.ts";

/*
 * A draft's bytes from what the app sends (ADR 0173 §5): a folder on this machine read as the
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

/** A folder's own regular files, stopping once they pass the market's archive cap. */
export async function readFolder(root: string): Promise<ArchiveFile[]> {
  if (!isAbsolute(root)) throw new Refused("A draft's folder is named by its full path");
  const files: ArchiveFile[] = [];
  let total = 0;
  const walk = async (folder: string, depth: number) => {
    if (depth > 32) throw new Refused(`${folder} is nested too deep`);
    for await (const entry of await opendir(folder)) {
      const path = join(folder, entry.name);
      const name = relative(root, path).split(sep).join("/");
      if (entry.name === ".git") continue;
      if (entry.isSymbolicLink())
        throw new Refused(`${name} is a link; an entry holds only its own files`);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile()) {
        const info = await lstat(path);
        total += info.size;
        if (total > maxArchiveBytes)
          throw new Refused(`The folder is larger than the market takes (40 MB)`);
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
  return files;
}

/** The canonical archive a draft uploads, capped at what the Worker takes. */
export async function draftArchive(source: MarketDraftSource): Promise<Uint8Array> {
  const archive =
    source.kind === "folder"
      ? writeArchive(await readFolder(source.path))
      : decoded(source.archive, archiveSourceBytes, "archive");
  if (archive.byteLength > maxArchiveBytes)
    throw new Refused("The draft is larger than the market takes (40 MB)");
  return archive;
}

/** An avatar or listing picture's bytes and their type, by their first bytes. */
export function pictureBytes(base64: string): { bytes: Uint8Array; type: string } {
  const bytes = decoded(base64, previewBytes, "picture");
  const starts = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte);
  const type = starts(0x89, 0x50, 0x4e, 0x47)
    ? "image/png"
    : starts(0xff, 0xd8, 0xff)
      ? "image/jpeg"
      : starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45
        ? "image/webp"
        : "application/octet-stream";
  return { bytes, type };
}
