/*
 * `features.json` in ace's home (ADR 0139): which parts of ace this machine shows. Releases carry
 * everything; this file decides at run time. Today it holds one flag, `spade`: Spade is shown
 * only when it is `true`. Read leniently: a missing file is the defaults, unknown keys are kept,
 * and a file that can't be read as a JSON object counts as the defaults with a problem to report.
 * Pure: no I/O.
 */

/** The file's name in ace's home. */
export const featuresFileName = "features.json";

export interface FeatureFlags {
  /** Spade is shown on this machine; hidden unless the file says `"spade": true`. */
  spade: boolean;
}

export const defaultFeatures: FeatureFlags = { spade: false };

export interface FeaturesRead {
  flags: FeatureFlags;
  /** Everything the file holds, unknown keys included, so writing one flag keeps the rest. */
  values: Record<string, unknown>;
  /** Why the file (or part of it) was ignored, in words a person can act on. */
  problem?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `features.json`'s text, or undefined when there is no file. */
export function readFeatures(text: string | undefined): FeaturesRead {
  if (text === undefined || text.trim() === "") return { flags: defaultFeatures, values: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      flags: defaultFeatures,
      values: {},
      problem: `${featuresFileName} isn't valid JSON, so Spade stays hidden until it's fixed.`,
    };
  }
  if (!isRecord(parsed))
    return {
      flags: defaultFeatures,
      values: {},
      problem: `${featuresFileName} should hold a JSON object such as {"spade": true}.`,
    };
  const spade = parsed["spade"];
  if (spade !== undefined && typeof spade !== "boolean")
    return {
      flags: defaultFeatures,
      values: parsed,
      problem: `"spade" in ${featuresFileName} should be true or false, so Spade stays hidden.`,
    };
  return { flags: { spade: spade === true }, values: parsed };
}

/**
 * The file's new text with `spade` set, keeping every other key. A file that couldn't be read is
 * replaced by one that can.
 */
export function withSpadeShown(current: FeaturesRead, shown: boolean): string {
  return `${JSON.stringify({ ...current.values, spade: shown }, null, 2)}\n`;
}
