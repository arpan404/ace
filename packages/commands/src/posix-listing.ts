import { z } from "zod";
import { posix, type CommandCalls } from "./posix-calls.ts";
import type { DirectoryReader } from "./posix-types.ts";
import { windowsDirectoryReader } from "./handle-paths.ts";

/** Real entries (never `.` or `..`) a directory listing reads at most: discovery's limit. */
export const listingLimit = 2048;
/** A listing had more entries than its limit; its reader has given every name it read. */
export class DirectoryListingTruncated extends Error {}
const entryName = z
  .string()
  .min(1)
  .max(1024)
  .refine((name) => !name.includes("/") && !name.includes("\0"));
const Listing = z.object({ names: z.array(entryName), truncated: z.boolean() });
/**
 * Takes `fd` over in every case and lists up to `limit` real entries in one call on its thread,
 * which closes the directory before answering, so no handle outlives the call. The reader gives
 * the names from memory, then throws `DirectoryListingTruncated` if more were left.
 */
export async function directoryReader(
  fd: number,
  owner?: CommandCalls,
  limit = listingLimit,
): Promise<DirectoryReader> {
  if (process.platform === "win32") return windowsDirectoryReader(fd);
  const value = await posix({ op: "listDirectory", fd, limit }, fd, owner);
  if (value === null) throw new Error("Cannot enumerate command directory");
  const listing = Listing.parse(value);
  return memoryReader(listing.names, listing.truncated);
}
function memoryReader(names: string[], truncated: boolean): DirectoryReader {
  let next = 0;
  return {
    async read() {
      // Each entry yields to the event loop, so a scan never runs ahead of the batch that asked.
      await new Promise((resolve) => setImmediate(resolve));
      if (next < names.length) return names[next++];
      if (truncated) throw new DirectoryListingTruncated("Directory entry limit exceeded");
      return undefined;
    },
    async close() {
      next = names.length;
      truncated = false;
    },
  };
}
