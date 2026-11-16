import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/** One file of an entry's folder, with its bytes' sha256. */
export interface HashedFile {
  path: string;
  bytes: number;
  executable: boolean;
  sha256: string;
}

const encoder = new TextEncoder();

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * ADR 0014's content hash, so a marketplace entry and an accepted plugin name the same bytes the
 * same way: sha256 over one JSON line per file (`[path, bytes, executable, sha256]`) in path
 * order. Equal to `inspectPackage(folder).hash` for the same folder.
 */
export function contentHash(files: readonly HashedFile[]): string {
  const lines = files
    .toSorted(byPath)
    .map((file) => JSON.stringify([file.path, file.bytes, file.executable, file.sha256]) + "\n")
    .join("");
  return sha256Hex(encoder.encode(lines));
}

/** The archive's files with their hashes, in path order. */
export function hashFiles(
  files: readonly { path: string; executable: boolean; content: Uint8Array }[],
): HashedFile[] {
  return files
    .map((file) => ({
      path: file.path,
      bytes: file.content.byteLength,
      executable: file.executable,
      sha256: sha256Hex(file.content),
    }))
    .toSorted(byPath);
}
