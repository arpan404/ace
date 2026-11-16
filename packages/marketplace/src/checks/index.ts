import type { MarketEntryType, MarketProblem } from "@ace/protocol/marketplace";
import { ArchiveError, readArchive, type ArchiveFile } from "../archive.ts";
import { hashFiles, contentHash, type HashedFile } from "../hash.ts";
import { typeLimits } from "../limits.ts";
import { describeEntry, type Listing } from "../listing.ts";
import { checkBot, type BotInspection } from "./bot.ts";
import { checkPlugin, type PluginInspection } from "./plugin.ts";
import { checkSkill, type SkillInspection } from "./skill.ts";
import { checkSuit, type SuitInspection } from "./suit.ts";

export { flaggedFile } from "./skill.ts";
export type { BotInspection, PluginInspection, SkillInspection, SuitInspection };
export type Inspection = SuitInspection | SkillInspection | PluginInspection | BotInspection;

/*
 * The checks every version passes (ADR 0168 §7), the same on the Worker before anything is
 * listed, on the signer before it signs, in `ace marketplace check` and on the device before a
 * review: format and paths, the type's limits, its own schema and static checks, and no secrets.
 */

export interface CheckedEntry {
  /** Empty when the version may be listed and installed. */
  problems: MarketProblem[];
  files: ArchiveFile[];
  hashed: HashedFile[];
  hash: string;
  size: number;
  listing: Listing;
  inspection: Inspection | undefined;
}

/** Checks a folder's files as an entry of `type` named `name`. */
export function checkFiles(
  type: MarketEntryType,
  name: string,
  files: readonly ArchiveFile[],
): CheckedEntry {
  const problems: MarketProblem[] = [];
  const limits = typeLimits[type];
  if (files.length > limits.files)
    problems.push({ message: `an entry of this type holds at most ${limits.files} files` });
  const size = files.reduce((sum, file) => sum + file.content.byteLength, 0);
  if (size > limits.totalBytes)
    problems.push({ message: `the files come to over ${limits.totalBytes} bytes, the limit` });
  const map = new Map(files.map((file) => [file.path, file.content]));
  const described = describeEntry(type, name, map);
  problems.push(...described.problems);
  let inspection: Inspection | undefined;
  switch (type) {
    case "suit":
      inspection = checkSuit(name, files);
      problems.push(...inspection.problems);
      break;
    case "spade-skill": {
      const checked = checkSkill(
        name,
        files.filter((file) => file.path !== "market.json"),
      );
      problems.push(...checked.problems);
      inspection = checked.inspection;
      break;
    }
    case "spade-plugin": {
      const checked = checkPlugin(name, files);
      problems.push(...checked.problems);
      inspection = checked.inspection;
      break;
    }
    case "spade-bot": {
      const checked = checkBot(files);
      problems.push(...checked.problems);
      inspection = checked.inspection;
      break;
    }
    case "ace-plugin":
      problems.push({
        message: "ace plugins need their own decision before the market takes them",
      });
  }
  const hashed = hashFiles(files);
  return {
    problems: problems.slice(0, 200),
    files: [...files],
    hashed,
    hash: contentHash(hashed),
    size,
    listing: described.listing,
    inspection,
  };
}

/** Reads `archive` and checks it; an archive that doesn't read is one problem. */
export function checkArchive(
  type: MarketEntryType,
  name: string,
  archive: Uint8Array,
): CheckedEntry {
  try {
    return checkFiles(type, name, readArchive(archive, typeLimits[type]));
  } catch (error) {
    if (!(error instanceof ArchiveError)) throw error;
    return {
      problems: [
        { ...(error.path ? { path: error.path } : {}), message: error.message.slice(0, 500) },
      ],
      files: [],
      hashed: [],
      hash: "",
      size: 0,
      listing: { title: name, line: "", description: "", categories: [], keywords: [] },
      inspection: undefined,
    };
  }
}
