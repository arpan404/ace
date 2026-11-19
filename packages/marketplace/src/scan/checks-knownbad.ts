import type { MarketBlocklist, MarketScanFinding } from "@ace/protocol/marketplace";
import type { ArchiveFile } from "../archive.ts";
import { sha256Hex } from "../hash.ts";
import { text as decodeText } from "../listing.ts";
import { normaliseText } from "./text.ts";

/*
 * The `known-bad` check (ADR 0174 §8): the maintainers' signed blocklist, run on the same bytes
 * everywhere. A whole version by its content `hash`, a single file by its sha256, and a literal
 * pattern matched case-insensitively over each text file after the scanner's unicode folding. Any
 * match blocks. Pure.
 */

const finding = (
  rule: string,
  message: string,
  path?: string,
  line?: number,
): MarketScanFinding => ({
  check: "known-bad",
  rule,
  level: "block",
  ...(path ? { path } : {}),
  ...(line ? { line } : {}),
  message,
});

/** The `known-bad` findings for `files` whose content hash is `hash`, against `blocklist`. */
export function knownBadFindings(
  files: readonly ArchiveFile[],
  hash: string,
  blocklist: MarketBlocklist,
): MarketScanFinding[] {
  const findings: MarketScanFinding[] = [];

  for (const blocked of blocklist.hashes)
    if (hash && blocked.hash === hash)
      return [finding("blocked-content", `This version is on the blocklist: ${blocked.reason}`)];

  for (const file of files) {
    const sha = sha256Hex(file.content);
    for (const blocked of blocklist.files)
      if (blocked.sha256 === sha)
        findings.push(
          finding("blocked-file", `${file.path} is on the blocklist: ${blocked.reason}`, file.path),
        );
  }

  const patterns = blocklist.patterns.map((pattern) => ({
    id: pattern.id,
    needle: normaliseText(pattern.text).toLowerCase(),
    reason: pattern.reason,
  }));
  if (patterns.length > 0)
    for (const file of files) {
      const source = decodeText(file.content);
      if (source === undefined) continue;
      const folded = normaliseText(source).toLowerCase();
      for (const pattern of patterns)
        if (pattern.needle && folded.includes(pattern.needle)) {
          const line = lineOf(folded, pattern.needle);
          findings.push(
            finding(
              `blocked-pattern-${pattern.id}`,
              `${file.path} matches a blocked pattern: ${pattern.reason}`,
              file.path,
              line,
            ),
          );
        }
    }

  return findings.slice(0, 200);
}

/** The 1-based line where `needle` first appears in `folded`. */
function lineOf(folded: string, needle: string): number {
  const at = folded.indexOf(needle);
  if (at < 0) return 1;
  let line = 1;
  for (let i = 0; i < at; i++) if (folded[i] === "\n") line++;
  return line;
}
