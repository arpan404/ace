import type { MarketScanCheckId, MarketScanFinding } from "@ace/protocol/marketplace";

/*
 * The scanner fails closed (ADR 0173 §8): anything executable or instructional it can't fully
 * resolve is held, never passed. This module gives the two findings every check reaches for, so
 * the levels are the same everywhere:
 *
 *   - `held(...)` — a `warn`, which holds the version for a maintainer. For code or a command the
 *     scanner can't resolve to something it understands.
 *   - `truncated(...)` — a `block`. For executable or instructional content a cap dropped without
 *     reading it whole; the entry can't be listed until it is read whole.
 *
 * A rule proves a thing safe, not that it is dangerous: when it can't, it holds.
 */

export const HELD_LEVEL = "warn" as const;
export const TRUNCATED_LEVEL = "block" as const;

const finding = (
  check: MarketScanCheckId,
  rule: string,
  level: MarketScanFinding["level"],
  message: string,
  path?: string,
  line?: number,
  strict?: boolean,
): MarketScanFinding => ({
  check,
  rule,
  level,
  ...(path ? { path } : {}),
  ...(line ? { line } : {}),
  message,
  ...(strict ? { strict: true } : {}),
});

/** Held for a maintainer: the scanner couldn't resolve this executable or instructional content. */
export const held = (
  check: MarketScanCheckId,
  rule: string,
  message: string,
  path?: string,
  line?: number,
): MarketScanFinding => finding(check, rule, HELD_LEVEL, message, path, line);

/** Blocked: a cap dropped executable or instructional content without reading it whole. */
export const truncated = (
  check: MarketScanCheckId,
  message: string,
  path?: string,
  line?: number,
): MarketScanFinding => finding(check, "scan-truncated", TRUNCATED_LEVEL, message, path, line);

/** Whether a scanner file path names instructional or script-like content (never a data blob). */
export const executableOrInstructional =
  /\.(?:sh|bash|zsh|ksh|dash|py|pyw|js|mjs|cjs|ts|jsx|tsx|rb|pl|pm|ps1|psm1|applescript|command|md|mdc|markdown|txt|prompt)$/i;
