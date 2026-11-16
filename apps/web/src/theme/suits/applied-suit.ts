import type { SuitDetail, SuitId, SuitSummary } from "@ace/protocol/suits";

/*
 * Which Suit the page shows (ADR 0150). A Suit applies only when this device picked it, Suits
 * aren't turned off for the session, and the daemon lists it with no problems; anything else
 * falls back to the chosen theme. Until the daemon has answered, the Suit the boot cache last
 * applied stands in, so a reload keeps its look. Pure.
 */
/**
 * The Suit this device asks for: an agent's preview while one runs (undefined when none does),
 * else the device setting.
 */
export const wantedSuit = (setting: SuitId | null, preview: SuitId | null | undefined) =>
  preview === undefined ? setting : preview;

export interface SuitInputs {
  /** The Suit this device asks for (`wantedSuit`). */
  setting: SuitId | null;
  /** `?suit=off` this session (`suits-off.ts`). */
  off: boolean;
  /** The daemon's list; undefined until it has answered. */
  summaries: readonly SuitSummary[] | undefined;
  /** The picked Suit's detail as read from the daemon, once read. */
  detail: SuitDetail | undefined;
  /** The Suit the boot cache applied last launch. */
  cached: SuitDetail | undefined;
}

const sameVersion = (a: SuitSummary, b: SuitSummary) =>
  a.id === b.id && a.contentHash === b.contentHash;

export function appliedSuit(inputs: SuitInputs): SuitDetail | null {
  const { setting, off, summaries, detail, cached } = inputs;
  if (off || setting === null) return null;
  const fromCache = cached?.summary.id === setting ? cached : undefined;
  if (summaries === undefined) return fromCache ?? null;
  const listed = summaries.find((summary) => summary.id === setting);
  if (!listed || listed.problems.length > 0) return null;
  if (detail && sameVersion(detail.summary, listed)) return detail;
  // A newer version is still being read: the last one shown holds until it arrives.
  return fromCache ?? null;
}

/** Whether a listed Suit can be picked: it passes every check. */
export const suitReady = (summary: SuitSummary): boolean => summary.problems.length === 0;
