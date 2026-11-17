import type { MarketScanFinding } from "@ace/protocol/marketplace";
import { readsAsAce, skeleton } from "../profile.ts";
import { distance } from "../search.ts";
import type { ScanContext, ScanInput } from "./index.ts";
import { hasBidi, hasInvisible, mixedScriptWord } from "./text.ts";

/*
 * The `hidden` check (ADR 0173 §8): characters and names that hide what an entry is. Bidirectional
 * controls anywhere, and zero-width or tag characters in code and names, block (an emoji joiner
 * between emoji is fine). A word that mixes scripts in a title or display name is a finding, as is
 * a name whose confusable skeleton collides with another publisher's or a verified publisher's
 * (a typosquat), and a title that reads as "ace" or "By ace" from anyone but the official
 * publisher blocks. Pure.
 */

const finding = (
  rule: string,
  level: MarketScanFinding["level"],
  message: string,
  path?: string,
  line?: number,
): MarketScanFinding => ({
  check: "hidden",
  rule,
  level,
  ...(path ? { path } : {}),
  ...(line ? { line } : {}),
  message,
});

/** Bidirectional controls and hidden characters in one text file's bytes, by line. */
export function hiddenFileFindings(path: string, text: string): MarketScanFinding[] {
  const findings: MarketScanFinding[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (hasBidi(line))
      findings.push(
        finding(
          "bidi-control",
          "block",
          `${path} line ${index + 1} holds a bidirectional control character that can reorder its text`,
          path,
          index + 1,
        ),
      );
    if (hasInvisible(line))
      findings.push(
        finding(
          "invisible-character",
          "block",
          `${path} line ${index + 1} holds a zero-width or hidden character`,
          path,
          index + 1,
        ),
      );
    if (findings.length >= 50) break;
  }
  return findings;
}

/** A display string (title, name): hidden characters block, a mixed-script word warns. */
function hiddenInName(what: string, value: string): MarketScanFinding[] {
  const findings: MarketScanFinding[] = [];
  if (hasBidi(value))
    findings.push(
      finding("bidi-name", "block", `The ${what} holds a bidirectional control character`),
    );
  if (hasInvisible(value))
    findings.push(finding("invisible-name", "block", `The ${what} holds a hidden character`));
  const mixed = mixedScriptWord(value);
  if (mixed)
    findings.push(
      finding(
        "mixed-script",
        "warn",
        `The ${what} word "${mixed}" mixes letters from more than one script`,
      ),
    );
  return findings;
}

/**
 * The whole-entry `hidden` findings: the title and name read for hidden characters and mixed
 * scripts, a title reading as "ace" from a non-official publisher, and the name against existing
 * and verified publishers' skeletons for typosquats.
 */
export function hiddenEntryFindings(input: ScanInput): MarketScanFinding[] {
  const findings: MarketScanFinding[] = [];
  const { context } = input;
  findings.push(...hiddenInName("title", input.listing.title));
  findings.push(...hiddenInName("name", input.name));

  if (!context.publisher?.official) {
    const titleSkeleton = skeleton(input.listing.title.replace(/^by\s+/i, ""));
    if (readsAsAce(skeleton(input.listing.title)) || readsAsAce(titleSkeleton))
      findings.push(
        finding(
          "reads-as-ace",
          "block",
          'The title reads as "ace", which only the official publisher may use',
        ),
      );
  }

  findings.push(...typosquatFindings(input.name, context));
  return findings;
}

/** A name whose skeleton collides with another publisher's entry or a verified publisher. */
function typosquatFindings(name: string, context: ScanContext): MarketScanFinding[] {
  const mine = skeleton(name);
  if (!mine) return [];
  const own = context.publisher?.handle;

  for (const verified of context.verified) {
    const target = skeleton(verified.handle);
    if (!target || verified.handle === own) continue;
    if (target === mine || distance(mine, target, 1) <= 1)
      return [
        finding(
          "typosquat-verified",
          "block",
          `"${name}" reads almost the same as the verified publisher "${verified.handle}"`,
        ),
      ];
  }

  for (const entry of context.entries) {
    if (entry.publisher === own) continue;
    const target = skeleton(entry.name);
    if (!target) continue;
    if (target === mine || distance(mine, target, 1) <= 1)
      return [
        finding(
          "typosquat-entry",
          "warn",
          `"${name}" reads almost the same as "${entry.name}" by another publisher`,
        ),
      ];
  }
  return [];
}
