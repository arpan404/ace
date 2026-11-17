/**
 * The shape of the command table (ADR 0176 §5). The table is data: the parser, help,
 * suggestions, completions, `ace help --json` and the generated docs page all read it, so help
 * can't drift from behaviour. Files under `commands/` import nothing but these types, which
 * keeps them safe to load on the rescue path (ADR 0092).
 */

/** Where a command sits in `ace help`. */
export type CommandGroup =
  | "basics"
  | "work"
  | "machine"
  | "providers"
  | "spade-market"
  | "agent-tools";

export interface FlagSpec {
  readonly name: string;
  /** One letter, used as `-x`. */
  readonly short?: string;
  /** The placeholder shown in help (`ID`, `DURATION`); a flag without one is a switch. */
  readonly value?: string;
  readonly summary: string;
  /** May be given more than once; values collect in `Args.lists`. */
  readonly repeat?: boolean;
  readonly choices?: readonly string[];
  /** Accepted, never shown: old spellings kept for the deprecation window. */
  readonly hidden?: boolean;
}

export interface ArgSpec {
  readonly name: string;
  readonly summary: string;
  readonly required?: boolean;
  /** Takes every remaining word. */
  readonly variadic?: boolean;
  /** `-` reads this argument from stdin. */
  readonly stdin?: boolean;
}

export interface Example {
  readonly command: string;
  readonly summary: string;
}

/**
 * Another spelling of a command. Without `deprecatedSince` it is a permanent shortcut
 * (`ace run`); with it, it is an old spelling on its way out (ADR 0176 decision 6).
 */
export interface AliasSpec {
  readonly words: readonly string[];
  readonly deprecatedSince?: string;
  /** Words put before the positional ones (`login codex` → `provider login codex`). */
  readonly insertWords?: readonly string[];
  /** Positional words become these flags, in order (`thread approve ID` → `--thread ID`). */
  readonly wordsAs?: readonly string[];
  /** Old flag name → new flag name. */
  readonly renameFlags?: Readonly<Record<string, string>>;
  /** Switches the alias turns on (`task wait` → `--tree`). */
  readonly setFlags?: readonly string[];
  /** A flag that, when given, sends the alias to another command (`clean --compact`). */
  readonly byFlag?: Readonly<Record<string, string>>;
  /** Never listed as a shortcut in help (plural nouns). */
  readonly quiet?: boolean;
}

export interface CommandSpec {
  /** Dotted words: `thread.list`, `market.maintainer.sign`. */
  readonly id: string;
  readonly words: readonly string[];
  readonly summary: string;
  readonly description?: string;
  readonly group: CommandGroup;
  readonly args?: readonly ArgSpec[];
  readonly flags?: readonly FlagSpec[];
  readonly examples?: readonly Example[];
  readonly aliases?: readonly AliasSpec[];
  /** Exit codes this command uses beyond the usual ones, with when. */
  readonly exits?: readonly { readonly code: number; readonly when: string }[];
  readonly seeAlso?: readonly string[];
  /** Key into `cliOutputs` (`@ace/protocol/cli-outputs`) for `--json` and `--schema`. */
  readonly output?: string;
  readonly mutates?: boolean;
  /** Works with the daemon down: help, version, completion, doctor, triage (ADR 0092). */
  readonly offline?: boolean;
  /** Not in `ace help` or completions (maintainer tools, the release runtime, `__complete`). */
  readonly hidden?: boolean;
  /** What a bare noun runs: `ace thread` is `ace thread list`. */
  readonly nounDefault?: boolean;
  /** Every word after the command's own goes to it unparsed (the release runtime's commands). */
  readonly passthrough?: boolean;
}

export interface NounSpec {
  readonly name: string;
  readonly summary: string;
  readonly group: CommandGroup;
  readonly hidden?: boolean;
}

export interface TopicSpec {
  readonly name: string;
  readonly summary: string;
  readonly text: string;
}
