import type { AliasSpec, CommandSpec } from "./commands/spec.ts";

/**
 * Where an old spelling is in its retirement (ADR 0176 decision 6): a notice in the release the
 * new spelling ships in and the two after it, a usage error naming the new command in the third
 * release after, then gone. While ace is `0.0.N`, every release counts as a minor release.
 */
export type AliasPhase = "current" | "notice" | "error" | "removed";

/** Releases from `since` to `version`, or undefined when either isn't a release number. */
function release(value: string): number[] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match ? match.slice(1, 4).map(Number) : undefined;
}

export function releasesSince(since: string, version: string): number | undefined {
  const from = release(since);
  const to = release(version);
  if (!from || !to) return undefined;
  const [fromMajor = 0, fromMinor = 0, fromPatch = 0] = from;
  const [toMajor = 0, toMinor = 0, toPatch = 0] = to;
  if (toMajor !== fromMajor) return toMajor > fromMajor ? Number.POSITIVE_INFINITY : -1;
  // 0.0.N counts patches; anything later counts minors.
  if (fromMajor === 0 && fromMinor === 0 && toMinor === 0) return toPatch - fromPatch;
  return toMinor - fromMinor;
}

export function aliasPhase(alias: AliasSpec | undefined, version: string): AliasPhase {
  if (!alias?.deprecatedSince) return "current";
  // A development build, or one older than the alias: keep it working, with its notice.
  const count = releasesSince(alias.deprecatedSince, version);
  if (count === undefined || count <= 2) return "notice";
  return count === 3 ? "error" : "removed";
}

/** The one line a person reads about an old spelling. */
export function aliasNotice(typed: readonly string[], command: CommandSpec): string {
  return `ace ${typed.join(" ")} is now ace ${command.words.join(" ")}.`;
}

/** What happens when an alias is typed: nothing, a notice on stderr, or a usage failure. */
export type AliasOutcome =
  | { readonly kind: "run" }
  | { readonly kind: "notice"; readonly text: string }
  | {
      readonly kind: "refuse";
      readonly code: "retired_command" | "unknown_command";
      readonly text: string;
      readonly hint: string;
    };

/**
 * Pure. The notice shows only to a person at a terminal: never in `--json` or `--quiet`
 * output, and never into a pipe (ADR 0176 §8).
 */
export function aliasOutcome(
  alias: AliasSpec | undefined,
  typed: readonly string[],
  command: CommandSpec,
  version: string,
  at: { readonly human: boolean; readonly stderrTTY: boolean },
): AliasOutcome {
  const phase = aliasPhase(alias, version);
  if (phase === "current") return { kind: "run" };
  const now = `ace ${command.words.join(" ")}`;
  if (phase === "notice")
    return at.human && at.stderrTTY
      ? { kind: "notice", text: aliasNotice(typed, command) }
      : { kind: "run" };
  return phase === "error"
    ? {
        kind: "refuse",
        code: "retired_command",
        text: aliasNotice(typed, command),
        hint: `Run ${now} instead.`,
      }
    : {
        kind: "refuse",
        code: "unknown_command",
        text: `ace has no command ${typed.join(" ")}.`,
        hint: `Did you mean ${now}?`,
      };
}
