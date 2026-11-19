import { randomUUID } from "node:crypto";
import { link, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { decode } from "./document.ts";
import { atomicWrite, readBounded } from "./io.ts";
import type { SettingsKey } from "@ace/protocol";
import type { SettingsService } from "./service.ts";

/*
 * Settings › Beta (ADR 0139, amended): features a machine turns on for itself, each one global
 * setting that defaults off. Spade's switch replaces the `features.json` flag a daemon used to
 * read; that file is folded into the setting once and then has no `spade` key.
 */

export const betaKeys = { spade: "beta.spade", marketplace: "beta.marketplace" } as const;

/**
 * Whether this release lets a machine turn Spade on at all. The 0.0.24 stable release ships
 * Spade's binary but keeps it off everywhere: the daemon treats `beta.spade` as off whatever it
 * holds, the CLI refuses to turn it on, and Settings › Beta has no Spade switch. The rail keeps
 * its coming-soon mark.
 */
export const spadeInThisRelease = false;
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return noLegacy;
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
  if (feature === "spade" && !spadeInThisRelease) return false;
  const stored = await booleanAtRest(home, betaKeys[feature]);
  if (stored !== undefined) return stored;
  return feature === "spade" && (await readLegacy(home)).spade === true;
}

/**
 * A boolean the global `settings.json` holds for `key`, read without a settings service; undefined
 * when it holds none or can't be read.
 */
export async function booleanAtRest(home: string, key: SettingsKey): Promise<boolean | undefined> {
  try {
    const text = await readBounded(resolve(home, "settings.json"));
    const stored = text === undefined ? undefined : decode(text).document.settings[key];
    return typeof stored === "boolean" ? stored : undefined;
  } catch {
    return undefined;
  }
}

/** A snapshot of `features.json` a fold has claimed; a crash leaves it for the next fold. */
const claimedPrefix = `${legacyFeaturesFile}.folding-`;

const code = (error: unknown) =>
  error instanceof Error && "code" in error ? String(error.code) : undefined;

/** Renames `from` to a name only this fold holds; undefined when someone else got it first. */
async function claim(home: string, from: string): Promise<string | undefined> {
  const to = join(home, `${claimedPrefix}${randomUUID()}`);
  try {
    await rename(join(home, from), to);
    return to;
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** Snapshots earlier folds left behind (a crash between claiming and finishing). */
async function leftovers(home: string): Promise<string[]> {
  try {
    return (await readdir(home)).filter((name) => name.startsWith(claimedPrefix));
  } catch {
    return [];
  }
}

/**
 * Puts `rest` back as `features.json` without replacing one another writer made meanwhile: it is
 * linked into place, which fails when a file is there. Then the newer file is kept and only the
 * keys it lacks are added, through a temporary file and a rename.
 */
async function putBack(home: string, rest: Record<string, unknown>): Promise<void> {
  const path = join(home, legacyFeaturesFile);
  const temporary = join(home, `.${legacyFeaturesFile}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(rest, null, 2)}\n`, { mode: 0o600 });
  try {
    await link(temporary, path);
  } catch (error) {
    if (code(error) !== "EEXIST") throw error;
    const newer = parseFeatures(await readFile(path, "utf8").catch(() => ""));
    // A file that isn't a JSON object was the other writer's choice; it stays as it is.
    if (newer) await atomicWrite(path, `${JSON.stringify({ ...rest, ...newer }, null, 2)}\n`);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseFeatures(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Folds `features.json`'s `spade` into `beta.spade`, once: `true` turns the setting on unless it
 * is already saved (checked and written as one step, so an "off" saved meanwhile wins), then the
 * key leaves the file, so turning Spade off later is never undone. The file is first claimed by
 * renaming it away, so this fold acts on exactly what it read and a writer adding keys meanwhile
 * makes a new file; what is left is put back without replacing that file, and a file holding
 * other keys is never deleted. Bounded: one small file and one setting, so a daemon can run it at
 * start without waiting on history. Returns whether it turned Spade on.
 */
export async function foldLegacySpadeFlag(
  settings: SettingsService,
  home: string,
): Promise<boolean> {
  const left = await leftovers(home);
  if (left.length === 0 && !(await readLegacy(home)).present) return false;
  const claimed: string[] = [];
  for (const name of left) {
    const path = await claim(home, name);
    if (path) claimed.push(path);
  }
  const current = await claim(home, legacyFeaturesFile);
  if (current) claimed.push(current);
  let turnedOn = false;
  for (const path of claimed) {
    const text = await readFile(path, "utf8");
    const parsed = parseFeatures(text);
    if (!parsed) {
      // Not ours to read: put back as it was, unless another writer made a new file meanwhile.
      await link(path, join(home, legacyFeaturesFile)).catch((error: unknown) => {
        if (code(error) !== "EEXIST") throw error;
      });
    } else {
      const { spade, ...rest } = parsed;
      if (spade === true && (await settings.setIfAbsent(betaKeys.spade, true, { kind: "global" })))
        turnedOn = true;
      if (Object.keys(rest).length > 0) await putBack(home, rest);
    }
    await rm(path, { force: true });
  }
  return turnedOn;
}
