import type { CommandCalls } from "./posix-calls.ts";

/** Opens one child of a pinned directory, never following a link; tests wrap it. */
export type OpenCommandChild = (
  directory: number,
  name: string,
  flags: number,
  owner?: CommandCalls,
) => Promise<number>;
export interface DirectoryReader {
  read(): Promise<string | undefined>;
  close(): Promise<void>;
}
export class EntryUnavailable extends Error {}
