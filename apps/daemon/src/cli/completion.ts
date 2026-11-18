import { globalFlags } from "./commands/globals.ts";
import type { FlagSpec, RefKind } from "./commands/spec.ts";
import type { CommandTable, Route } from "./commands/table.ts";
import { visibleWords } from "./parse.ts";

/**
 * Tab completion (ADR 0178 §6). The shell scripts call the hidden `ace __complete WORDS… :CUR`,
 * the last word being what's typed so far behind a `:` so it is never empty. The answer is one
 * candidate per line, `value` or `value<TAB>description`; each shell's script shows the
 * description where the shell can. The table answers nouns, verbs, flags and choices; a slot the
 * table marks with a `ref` is also offered live from the daemon (`completion-live.ts`).
 */
export type Shell = "bash" | "zsh" | "fish" | "powershell";
export const shells: readonly Shell[] = ["bash", "zsh", "fish", "powershell"];

export interface Candidate {
  readonly value: string;
  readonly description?: string;
}

/** The word being completed, what the table offers for it, and what it names. */
export interface Slot {
  /** What's typed of the word so far. */
  readonly current: string;
  /** What the table alone offers, already narrowed to `current`. */
  readonly candidates: readonly Candidate[];
  /** The kind of reference the word names, when the daemon may be asked for live ones. */
  readonly ref?: RefKind;
}

/** What the table says about the word being typed. Pure. */
export function completionSlot(table: CommandTable, input: readonly string[]): Slot {
  const last = input.at(-1) ?? ":";
  const current = last.startsWith(":") ? last.slice(1) : last;
  const typed = last.startsWith(":") ? input.slice(0, -1) : input;
  const positional: string[] = [];
  let pending: FlagSpec | undefined;
  let remote = false;
  for (const word of typed) {
    if (pending) {
      pending = undefined;
      continue;
    }
    if (word.startsWith("-") && word !== "-") {
      const flag = findFlag(routeOf(table, positional), word);
      if (flag?.name === "remote") remote = true;
      if (flag?.value && !word.includes("=")) pending = flag;
      continue;
    }
    positional.push(word);
  }
  // Live references come from this machine's daemon, so a line aimed at a remote gets none.
  const live = (ref: RefKind | undefined) => (ref && !remote ? { ref } : {});
  if (pending)
    return {
      current,
      candidates: narrow(pending.choices ?? [], current),
      ...live(pending.ref),
    };
  const depth = commandDepth(table, positional);
  const prefix = positional.slice(0, depth).join(" ");
  const route = table.routes.get(prefix);
  if (current.startsWith("-")) {
    const seen = new Set<string>();
    const candidates = [...(route?.command.flags ?? []), ...globalFlags].flatMap((flag) => {
      const value = `--${flag.name}`;
      if (flag.hidden || seen.has(value) || !value.startsWith(current)) return [];
      seen.add(value);
      return [{ value, description: flag.summary }];
    });
    return { current, candidates: candidates.toSorted((a, b) => (a.value < b.value ? -1 : 1)) };
  }
  if (depth === positional.length && table.next.has(prefix))
    return { current, candidates: narrow(visibleWords(table, prefix), current) };
  return { current, candidates: [], ...live(route && argRef(route, positional.length - depth)) };
}

/** The table's candidates alone: what completion offers with no daemon. Pure. */
export function complete(table: CommandTable, input: readonly string[]): string[] {
  return completionSlot(table, input).candidates.map((candidate) => candidate.value);
}

/**
 * Candidates as `ace __complete` prints them: `value` or `value<TAB>description`, one a line.
 * A value that would break a line or the tab split is left out; a description is kept to one
 * short line. Pure.
 */
export function candidateLines(candidates: readonly Candidate[]): string {
  const seen = new Set<string>();
  let out = "";
  for (const { value, description } of candidates) {
    if (!value || /[\t\n\r]/.test(value) || seen.has(value)) continue;
    seen.add(value);
    const said = (description ?? "").replace(/\s+/g, " ").trim();
    out += said ? `${value}\t${said.length > 80 ? `${said.slice(0, 79)}…` : said}\n` : `${value}\n`;
  }
  return out;
}

/** The longest run of typed words that names a command or a noun. */
function commandDepth(table: CommandTable, words: readonly string[]): number {
  for (let k = words.length; k > 0; k--) {
    const key = words.slice(0, k).join(" ");
    if (table.routes.has(key) || table.next.has(key)) return k;
  }
  return 0;
}

function routeOf(table: CommandTable, words: readonly string[]): Route | undefined {
  return table.routes.get(words.slice(0, commandDepth(table, words)).join(" "));
}

function findFlag(route: Route | undefined, word: string): FlagSpec | undefined {
  const flags = [...(route?.command.flags ?? []), ...globalFlags];
  if (!word.startsWith("--")) return flags.find((flag) => flag.short === word.slice(1));
  const typed = word.slice(2).split("=")[0] ?? "";
  const name = route?.alias?.renameFlags?.[typed] ?? typed;
  return flags.find((flag) => flag.name === name);
}

/** What the `index`th positional word after a route's own names, mirroring the parser. */
function argRef(route: Route, index: number): RefKind | undefined {
  const { command, alias } = route;
  const at = (alias?.insertWords?.length ?? 0) + index;
  const asFlags = alias?.wordsAs ?? [];
  if (at < asFlags.length) return command.flags?.find((flag) => flag.name === asFlags[at])?.ref;
  const args = command.args ?? [];
  const last = args.at(-1);
  return (args[at - asFlags.length] ?? (last?.variadic ? last : undefined))?.ref;
}

function narrow(words: readonly string[], current: string): Candidate[] {
  return words.filter((word) => word.startsWith(current)).map((value) => ({ value }));
}

/**
 * The script for `ace completion SHELL`. bash shows values only; zsh, fish and PowerShell show
 * each candidate's description beside it.
 */
export function completionScript(shell: Shell): string {
  if (shell === "bash")
    return `# ace completion for bash
_ace() {
  local line tab=$'\\t'
  COMPREPLY=()
  while IFS= read -r line; do
    [[ -n $line ]] && COMPREPLY+=("\${line%%"$tab"*}")
  done < <(ace __complete -- "\${COMP_WORDS[@]:1:$((COMP_CWORD-1))}" ":\${COMP_WORDS[COMP_CWORD]}" 2>/dev/null)
}
complete -o default -F _ace ace
`;
  if (shell === "zsh")
    return `#compdef ace
# ace completion for zsh
_ace() {
  local -a described
  local line value tab=$'\\t'
  for line in "\${(@f)$(ace __complete -- "\${(@)words[2,CURRENT-1]}" ":\${words[CURRENT]}" 2>/dev/null)}"; do
    [[ -z $line ]] && continue
    value=\${line%%$tab*}
    value=\${value//:/\\\\:}
    if [[ $line == *$tab* ]]; then
      described+=("$value:\${line#*$tab}")
    else
      described+=("$value")
    fi
  done
  _describe 'ace' described
}
compdef _ace ace
`;
  if (shell === "fish")
    return `# ace completion for fish
complete -c ace -f -a '(ace __complete -- (commandline -opc)[2..-1] ":"(commandline -ct) 2>/dev/null)'
`;
  return `# ace completion for PowerShell
Register-ArgumentCompleter -Native -CommandName ace -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.ToString() })
  if ($wordToComplete -ne '' -and $words.Count -gt 0) { $words = @($words | Select-Object -SkipLast 1) }
  ace __complete -- @words ":$wordToComplete" 2>$null | Where-Object { $_ } | ForEach-Object {
    $value, $description = $_ -split "\`t", 2
    if (-not $description) { $description = $value }
    [System.Management.Automation.CompletionResult]::new($value, $value, 'ParameterValue', $description)
  }
}
`;
}

/** Where `ace completion install` puts the script, and what the person still has to do. */
export function installPlan(
  shell: Shell,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): { path: string; next?: string } {
  if (shell === "bash")
    return {
      path: `${env.XDG_DATA_HOME ?? `${home}/.local/share`}/bash-completion/completions/ace`,
    };
  if (shell === "zsh")
    return {
      path: `${env.ZDOTDIR ?? home}/.zfunc/_ace`,
      next: "Add fpath=(~/.zfunc $fpath) before compinit in your .zshrc, then open a new shell.",
    };
  if (shell === "fish")
    return { path: `${env.XDG_CONFIG_HOME ?? `${home}/.config`}/fish/completions/ace.fish` };
  return {
    path: `${home}/.config/powershell/ace-completion.ps1`,
    next: "Add `. ~/.config/powershell/ace-completion.ps1` to your $PROFILE.",
  };
}

/** The person's shell from $SHELL, or PowerShell on Windows. */
export function currentShell(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): Shell | undefined {
  if (platform === "win32") return "powershell";
  const name = (env.SHELL ?? "").split("/").at(-1) ?? "";
  return shells.find((shell) => shell === name || (shell === "powershell" && name === "pwsh"));
}
