import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { decode } from "./document.ts";
import { atomicWrite, readBounded } from "./io.ts";
import type { SettingsService } from "./service.ts";

/*
 * Settings › Beta (ADR 0139, amended): features a machine turns on for itself, each one global
 * setting that defaults off. Spade's switch replaces the `features.json` flag a daemon used to
 * read; that file is folded into the setting once and then has no `spade` key.
 */

export const betaKeys = { spade: "beta.spade", marketplace: "beta.marketplace" } as const;
export type BetaFeature = keyof typeof betaKeys;

/** The old file in ace's home that showed Spade with `{"spade": true}`. */
export const legacyFeaturesFile = "features.json";

interface LegacyFlag {
  /** `spade` as the file holds it; undefined with no file, no key or a value that isn't a boolean. */
  spade: boolean | undefined;
  /** The file holds a `spade` key, of any value, still to be folded in. */
  present: boolean;
  /** The file's other keys, kept when `spade` is taken out. */
  rest: Record<string, unknown>;
}

const noLegacy: LegacyFlag = { spade: undefined, present: false, rest: {} };

async function readLegacy(home: string): Promise<LegacyFlag> {
  let text: string;
  try {
    text = await readFile(join(home, legacyFeaturesFile), "utf8");
  } catch {
    return noLegacy;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return noLegacy;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return noLegacy;
  const { spade, ...rest } = Object.fromEntries(Object.entries(parsed));
  return {
    spade: typeof spade === "boolean" ? spade : undefined,
    present: Object.hasOwn(parsed, "spade"),
    rest,
  };
}

/**
 * Whether `feature` is on in `home`, read from the files without a settings service and without
 * writing anything: the global `settings.json`, else (Spade only) a `features.json` that hasn't
 * been folded in yet. For readers that must not change a home: `ace doctor` and the updater's
 * service guard. A settings file that can't be read counts as off.
 */
export async function betaOnAtRest(home: string, feature: BetaFeature): Promise<boolean> {
  const key = betaKeys[feature];
  try {
    const text = await readBounded(resolve(home, "settings.json"));
    if (text !== undefined) {
      const stored = decode(text).document.settings[key];
      if (typeof stored === "boolean") return stored;
    }
  } catch {
    return false;
  }
  return feature === "spade" && (await readLegacy(home)).spade === true;
}

/**
 * Folds `features.json`'s `spade` into `beta.spade`, once: `true` turns the setting on unless the
 * person already set it, then the key leaves the file (the file goes when nothing else is in
 * it), so turning Spade off later is never undone. Bounded: one small file and one setting, so a
 * daemon can run it at start without waiting on history. Returns whether it turned Spade on.
 */
export async function foldLegacySpadeFlag(
  settings: SettingsService,
  home: string,
): Promise<boolean> {
  const legacy = await readLegacy(home);
  if (!legacy.present) return false;
  let turnedOn = false;
  if (legacy.spade === true) {
    const entry = await settings.get(betaKeys.spade);
    if (entry.provenance === "defaults") {
      await settings.set(betaKeys.spade, true, { kind: "global" });
      turnedOn = true;
    }
  }
  const path = join(home, legacyFeaturesFile);
  if (Object.keys(legacy.rest).length === 0) await rm(path, { force: true });
  else await atomicWrite(path, `${JSON.stringify(legacy.rest, null, 2)}\n`);
  return turnedOn;
}
