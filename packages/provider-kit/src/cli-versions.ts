import type { CliVersionCheck } from "@ace/protocol";
export type { CliVersionCheck } from "@ace/protocol";

/*
 * Reading and comparing external CLI versions. Pure, and portable to browser bundles: no Node
 * built-ins. Every minimum-version decision in ace goes through `checkCliVersion`.
 */

export interface CliVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers ("beta.1"); empty for a release. */
  prerelease: readonly string[];
}

/**
 * The first `major.minor[.patch][-prerelease]` in a CLI's version output, wherever it sits:
 * "2.1.286 (Claude Code)", "codex-cli 0.159.1", "opencode v2.0.22", "agy 1.2.1".
 * A missing patch reads as 0 ("1.2"). Build metadata is
 * ignored. Undefined when the output holds no version at all.
 */
export function parseCliVersion(text: string | undefined): CliVersion | undefined {
  if (!text) return undefined;
  const match =
    /(?:^|[^\w.])v?(\d{1,9})\.(\d{1,9})(?:\.(\d{1,9}))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?(?![\w.]*\d)/.exec(
      text.slice(0, 4096),
    );
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/** The version as ace writes it: "2.1.286", "0.86.0-beta.1". */
export function formatCliVersion(version: CliVersion): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease.length ? `${base}-${version.prerelease.join(".")}` : base;
}

function compareIdentifiers(a: string, b: string): number {
  const numeric = /^\d+$/;
  if (numeric.test(a) && numeric.test(b)) return Number(a) - Number(b);
  if (numeric.test(a)) return -1;
  if (numeric.test(b)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semantic-version order: a prerelease sorts before its own release, after the one before. */
export function compareCliVersions(a: CliVersion, b: CliVersion): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core) return Math.sign(core);
  if (!a.prerelease.length || !b.prerelease.length)
    return a.prerelease.length ? -1 : b.prerelease.length ? 1 : 0;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const order = compareIdentifiers(left, right);
    if (order) return Math.sign(order);
  }
  return 0;
}

/**
 * Where an installed CLI stands against ace's minimum. Only a version below the minimum is
 * `too_old`: a newer one is always `ok` here, whatever else ace later checks about its API.
 * `unreadable` means the version output held no version; callers don't block on it.
 */
export function checkCliVersion(minimum: string, output: string | undefined): CliVersionCheck {
  const required = parseCliVersion(minimum);
  if (!required) throw new Error(`Invalid minimum version ${minimum}`);
  const installed = parseCliVersion(output);
  const requiredText = formatCliVersion(required);
  if (!installed) return { status: "unreadable", required: requiredText };
  return {
    status: compareCliVersions(installed, required) < 0 ? "too_old" : "ok",
    installed: formatCliVersion(installed),
    required: requiredText,
  };
}
