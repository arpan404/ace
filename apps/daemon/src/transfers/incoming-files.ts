import { createHash } from "node:crypto";
import { join } from "node:path";

/** What a receiving transfer holds: the code, the ignored files, the final payload and its folder. */
export type IncomingPart = "code" | "ignored" | "final" | "finalFolder";

export const incomingSuffixes: Readonly<Record<IncomingPart, string>> = {
  code: ".part",
  ignored: ".ignored.part",
  final: ".final.part",
  finalFolder: ".final.d",
};
export const incomingParts = Object.keys(incomingSuffixes) as IncomingPart[];

/**
 * A transfer's name on disk: the lowercase hex SHA-256 of its id. Ids may hold dots and differ
 * only in case, so a name made from the id could be another transfer's file (`x.ignored.part` is
 * `x`'s ignored payload; `Move-1` and `move-1` are one file on a case-insensitive volume). A
 * hash is the same width for every id, has no dot and no capital, and never collides.
 */
export function incomingStem(transferId: string): string {
  return createHash("sha256").update(transferId).digest("hex");
}

/** Where one part of a transfer waits in `directory` (`<data>/transfers/incoming`). */
export function incomingPath(directory: string, transferId: string, part: IncomingPart): string {
  return join(directory, `${incomingStem(transferId)}${incomingSuffixes[part]}`);
}

/** The name an earlier build gave that part: the id itself with the suffix. */
export function legacyIncomingName(transferId: string, part: IncomingPart): string {
  return `${transferId}${incomingSuffixes[part]}`;
}
