import { z } from "zod";
import { MarketHash } from "./marketplace-base.ts";

/*
 * The scan report (ADR 0173 §8): what `@ace/marketplace`'s scanner says about an entry's bytes or
 * a listing edit, on the Worker, in the signer and on the device. Each check answers pass, warn
 * or block from its findings; each finding is one plain sentence. Schema only.
 */

/** The scanner's checks, in the order a report lists them. */
export const MarketScanCheckId = z.enum([
  "files",
  "scripts",
  "scene",
  "plugin",
  "recipe",
  "secrets",
  "hidden",
  "known-bad",
]);
export type MarketScanCheckId = z.infer<typeof MarketScanCheckId>;

/** A finding's weight. A `note` is shown and never holds, except a `strict` one for a new publisher. */
export const MarketScanLevel = z.enum(["note", "warn", "block"]);
export type MarketScanLevel = z.infer<typeof MarketScanLevel>;
export const MarketScanVerdict = z.enum(["pass", "warn", "block"]);
export type MarketScanVerdict = z.infer<typeof MarketScanVerdict>;

export const MarketScanFinding = z.strictObject({
  check: MarketScanCheckId,
  /** The rule that found it, such as `download-exec` or `bidi-control`. */
  rule: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  level: MarketScanLevel,
  path: z.string().max(512).optional(),
  line: z.number().int().positive().optional(),
  /** One sentence the publisher and the person read. */
  message: z.string().min(1).max(500),
  /** Holds a new publisher's version even as a note (ADR 0173 §9). */
  strict: z.boolean().optional(),
});
export type MarketScanFinding = z.infer<typeof MarketScanFinding>;

export const MarketScanCheck = z.strictObject({
  id: MarketScanCheckId,
  verdict: MarketScanVerdict,
  /** The check in one sentence: "No programs or archives inside." or why not. */
  sentence: z.string().min(1).max(500),
  findings: z.number().int().nonnegative(),
});
export type MarketScanCheck = z.infer<typeof MarketScanCheck>;

/** The scanner's own version: a report from an older scanner is scanned again. */
export const marketScannerVersion = 1;

export const MarketScanReport = z.strictObject({
  format: z.literal("ace-market-scan"),
  scanner: z.number().int().positive(),
  /** The content hash scanned; absent for a listing edit. */
  hash: MarketHash.optional(),
  verdict: MarketScanVerdict,
  checks: z.array(MarketScanCheck).max(16),
  findings: z.array(MarketScanFinding).max(500),
  /** More findings than a report keeps; the verdict counts them all. */
  truncated: z.boolean(),
  /** How much was read, for the sentence "Read 12 files, 40 KB of text." */
  read: z.strictObject({
    files: z.number().int().nonnegative(),
    textBytes: z.number().int().nonnegative(),
  }),
});
export type MarketScanReport = z.infer<typeof MarketScanReport>;

/** A scan as a draft carries it: still running in steps, or done with its report. */
export const MarketScanState = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("scanning"),
    /** Files read so far, of `files`. */
    read: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
  }),
  z.strictObject({ state: z.literal("done"), report: MarketScanReport }),
]);
export type MarketScanState = z.infer<typeof MarketScanState>;
