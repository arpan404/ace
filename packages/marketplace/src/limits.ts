import type { MarketEntryType } from "@ace/protocol/marketplace";
import type { ArchiveLimits } from "./archive.ts";

const MiB = 1024 * 1024;

/**
 * Each type's caps (ADR 0168 §5): a Suit's are ADR 0150's, a skill's ADR 0103's, a plugin's
 * ADR 0014's. One more file than the type's own allows for `market.json`.
 */
export const typeLimits: Readonly<Record<MarketEntryType, ArchiveLimits>> = {
  suit: { files: 513, fileBytes: 20 * MiB, totalBytes: 21 * MiB, depth: 8 },
  "spade-skill": { files: 513, fileBytes: 4 * MiB, totalBytes: 16 * MiB, depth: 16 },
  "spade-plugin": { files: 2049, fileBytes: 4 * MiB, totalBytes: 32 * MiB, depth: 32 },
  "spade-bot": { files: 513, fileBytes: 4 * MiB, totalBytes: 16 * MiB, depth: 16 },
  "ace-plugin": { files: 2049, fileBytes: 4 * MiB, totalBytes: 32 * MiB, depth: 32 },
};

/** The largest archive the Worker takes: the biggest type's files plus tar's framing. */
export const maxArchiveBytes = 40 * MiB;
/** `market.json`, the listing's words. */
export const listingBytes = 16 * 1024;
/** A Suit's listing picture (`assets/preview.png`). */
export const previewBytes = MiB;
