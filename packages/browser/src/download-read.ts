import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { browserDownloadChunkMax } from "@ace/protocol";
import type { DownloadSource } from "./backend.ts";

/** One chunk of a download's quarantined copy, and what the file is now. */
export interface DownloadRead {
  bytes: Uint8Array;
  size: number;
  validator: string;
}

/**
 * Reads `length` bytes from `offset` of a finished download's quarantined copy. A copy that is
 * no longer the file the download wrote (replaced, grown, a link) is refused, and so is a read
 * against another `validator` than the file has now: a resumed transfer never splices two files.
 */
export async function readDownload(
  source: DownloadSource,
  offset: number,
  length: number,
  validator?: string,
): Promise<DownloadRead> {
  // O_NOFOLLOW: a link put in place of the copy is never followed out of the session's folder.
  const file = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new Error("The download is no longer on the daemon");
  });
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== source.bytes)
      throw new Error("The download is no longer on the daemon");
    const current = `${stat.size}-${stat.ino}-${Math.trunc(stat.mtimeMs)}`;
    if (validator !== undefined && validator !== current)
      throw new Error("The download changed; start it again");
    if (offset > stat.size) throw new Error("Past the file's end");
    const want = Math.min(length, browserDownloadChunkMax, stat.size - offset);
    const bytes = new Uint8Array(want);
    let read = 0;
    while (read < want) {
      const { bytesRead } = await file.read(bytes, read, want - read, offset + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    if (read !== want) throw new Error("The download changed");
    return { bytes, size: stat.size, validator: current };
  } finally {
    await file.close();
  }
}
