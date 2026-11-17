import { globalFlags } from "./commands/globals.ts";
import type { CommandTable } from "./commands/table.ts";
import { visibleWords } from "./parse.ts";

/**
 * Tab completion (ADR 0176 §6). The shell scripts call the hidden `ace __complete WORDS… :CUR`,
 * the last word being what's typed so far behind a `:` so it is never empty. Completion reads
 * only the command table: it never starts the daemon, never prompts and never writes.
 */
export type Shell = "bash" | "zsh" | "fish" | "powershell";
export const shells: readonly Shell[] = ["bash", "zsh", "fish", "powershell"];

/** Candidates for the word being typed. Pure. */
export function complete(table: CommandTable, input: readonly string[]): string[] {
  const last = input.at(-1) ?? ":";
  const current = last.startsWith(":") ? last.slice(1) : last;
  const before = (last.startsWith(":") ? input.slice(0, -1) : input).filter(
    (word) => !word.startsWith("-"),
  );
  // The longest run of typed words that names a command or a noun.
  let depth = 0;
  for (let k = before.length; k > 0; k--) {
    const key = before.slice(0, k).join(" ");
    if (table.routes.has(key) || table.next.has(key)) {
      depth = k;
      break;
    }
  }
  const prefix = before.slice(0, depth).join(" ");
  const route = table.routes.get(prefix);
  if (current.startsWith("-")) {
    const flags = [...(route?.command.flags ?? []), ...globalFlags].filter((flag) => !flag.hidden);
    return [...new Set(flags.map((flag) => `--${flag.name}`))]
      .filter((flag) => flag.startsWith(current))
      .toSorted();
  }
  // After a command's own words, only its arguments follow, which the table can't name.
  if (depth < before.length) return [];
  const words = table.next.has(prefix) ? visibleWords(table, prefix) : [];
  return words.filter((word) => word.startsWith(current));
}

export function completionScript(shell: Shell): string {
  if (shell === "bash")
    return `# ace completion for bash
_ace() {
  local IFS=$'\\n'
  COMPREPLY=($(ace __complete -- "\${COMP_WORDS[@]:1:$((COMP_CWORD-1))}" ":\${COMP_WORDS[COMP_CWORD]}" 2>/dev/null))
}
complete -o default -F _ace ace
`;
  if (shell === "zsh")
    return `#compdef ace
# ace completion for zsh
_ace() {
  local -a candidates
  candidates=("\${(@f)$(ace __complete -- "\${(@)words[2,CURRENT-1]}" ":\${words[CURRENT]}" 2>/dev/null)}")
  compadd -a candidates
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
  ace __complete -- @words ":$wordToComplete" 2>$null | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
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
