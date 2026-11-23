// SPDX-License-Identifier: Apache-2.0
//! Tab completion from the static table (ADR 0178 §6). Pure: the words typed so far in, the
//! candidates out. A slot that names a live reference is the one case the caller hands over.

use std::borrow::Cow;
use std::collections::BTreeSet;

use cli_table::{FlagSpec, RefKind, Route};

/// A shell ace can print a completion script for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompletionShell {
    Bash,
    Zsh,
    Fish,
    PowerShell,
}

/// Every shell, in the order `ace completion` names them.
pub const SHELLS: &[CompletionShell] = &[
    CompletionShell::Bash,
    CompletionShell::Zsh,
    CompletionShell::Fish,
    CompletionShell::PowerShell,
];

impl CompletionShell {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Bash => "bash",
            Self::Zsh => "zsh",
            Self::Fish => "fish",
            Self::PowerShell => "powershell",
        }
    }

    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        SHELLS.iter().copied().find(|shell| shell.as_str() == name)
    }
}

/// One offered candidate and the description a shell may show beside it.
#[derive(Debug)]
pub struct Candidate {
    pub value: Cow<'static, str>,
    pub description: Option<&'static str>,
}

/// The word being completed, what the table offers for it, and what it names.
#[derive(Debug)]
pub struct Slot {
    pub candidates: Vec<Candidate>,
    /// The kind of reference the word names, when the daemon may be asked for live ones.
    pub reference: Option<RefKind>,
}

fn narrow(words: &[&'static str], current: &str) -> Vec<Candidate> {
    words
        .iter()
        .filter(|word| word.starts_with(current))
        .map(|word| Candidate {
            value: Cow::Borrowed(word),
            description: None,
        })
        .collect()
}

fn command_depth(words: &[&str]) -> usize {
    for count in (1..=words.len()).rev() {
        let key = words[..count].join(" ");
        if cli_table::route(&key).is_some() || cli_table::has_next(&key) {
            return count;
        }
    }
    0
}

fn route_of(words: &[&str]) -> Option<Route> {
    let depth = command_depth(words);
    cli_table::route(&words[..depth].join(" "))
}

fn find_flag(route: Option<Route>, word: &str) -> Option<&'static FlagSpec> {
    let own = route.map_or(&[][..], |route| route.command.flags);
    let flags = own.iter().chain(cli_table::global_flags().iter());
    if !word.starts_with("--") {
        let short = word.strip_prefix('-')?;
        return flags.into_iter().find(|flag| flag.short == Some(short));
    }
    let typed = word[2..].split('=').next().unwrap_or("");
    let name = route
        .and_then(|route| route.alias)
        .and_then(|alias| alias.renamed(typed))
        .unwrap_or(typed);
    flags.into_iter().find(|flag| flag.name == name)
}

/// What the `index`th positional word after a route's own names holds, mirroring the parser.
fn arg_ref(route: Option<Route>, index: usize) -> Option<RefKind> {
    let route = route?;
    let at = route.alias.map_or(0, |alias| alias.insert_words.len()) + index;
    let as_flags = route.alias.map_or(&[][..], |alias| alias.words_as);
    if let Some(name) = as_flags.get(at) {
        return route
            .command
            .flags
            .iter()
            .find(|flag| flag.name == *name)
            .and_then(|flag| flag.reference);
    }
    let args = route.command.args;
    let last = args.last().filter(|arg| arg.variadic);
    args.get(at - as_flags.len())
        .or(last)
        .and_then(|arg| arg.reference)
}

/// What the table says about the word being typed. Pure.
#[must_use]
pub fn slot(input: &[&str]) -> Slot {
    let last = input.last().copied().unwrap_or(":");
    let current = last.strip_prefix(':').unwrap_or(last);
    let typed = if last.starts_with(':') {
        &input[..input.len() - 1]
    } else {
        input
    };
    let mut positional: Vec<&str> = Vec::new();
    let mut pending: Option<&'static FlagSpec> = None;
    let mut remote = false;
    for word in typed {
        if pending.is_some() {
            pending = None;
            continue;
        }
        if word.starts_with('-') && *word != "-" {
            let flag = find_flag(route_of(&positional), word);
            if flag.is_some_and(|flag| flag.name == "remote") {
                remote = true;
            }
            if let Some(flag) = flag
                && flag.value.is_some()
                && !word.contains('=')
            {
                pending = Some(flag);
            }
            continue;
        }
        positional.push(word);
    }
    // Live references come from this machine's daemon, so a line aimed at a remote gets none.
    let live = |reference: Option<RefKind>| if remote { None } else { reference };
    if let Some(pending) = pending {
        return Slot {
            candidates: narrow(pending.choices, current),
            reference: live(pending.reference),
        };
    }
    let depth = command_depth(&positional);
    let prefix = positional[..depth].join(" ");
    let route = cli_table::route(&prefix);
    if current.starts_with('-') {
        let mut seen = BTreeSet::new();
        let mut candidates = Vec::new();
        let own = route.map_or(&[][..], |route| route.command.flags);
        for flag in own.iter().chain(cli_table::global_flags().iter()) {
            let value = format!("--{}", flag.name);
            if flag.hidden || !value.starts_with(current) || !seen.insert(value.clone()) {
                continue;
            }
            candidates.push(Candidate {
                value: Cow::Owned(value),
                description: Some(flag.summary),
            });
        }
        candidates.sort_by(|left, right| left.value.cmp(&right.value));
        return Slot {
            candidates,
            reference: None,
        };
    }
    if depth == positional.len() && cli_table::has_next(&prefix) {
        return Slot {
            candidates: narrow(&cli_table::visible_words(&prefix), current),
            reference: None,
        };
    }
    Slot {
        candidates: Vec::new(),
        reference: live(arg_ref(route, positional.len() - depth)),
    }
}

/// Candidates as `ace __complete` prints them: `value` or `value<TAB>description`, one a line.
/// A value that would break a line or the tab split is left out. Pure.
#[must_use]
pub fn candidate_lines(candidates: &[Candidate]) -> String {
    let mut seen = BTreeSet::new();
    let mut out = String::new();
    for candidate in candidates {
        let value = candidate.value.as_ref();
        if value.is_empty() || value.contains(['\t', '\n', '\r']) || !seen.insert(value.to_owned())
        {
            continue;
        }
        out.push_str(value);
        let said = candidate
            .description
            .map(|description| description.split_whitespace().collect::<Vec<_>>().join(" "))
            .unwrap_or_default();
        if !said.is_empty() {
            out.push('\t');
            if said.chars().count() > 80 {
                out.extend(said.chars().take(79));
                out.push('…');
            } else {
                out.push_str(&said);
            }
        }
        out.push('\n');
    }
    out
}

/// The script for `ace completion SHELL`. bash shows values only; the others show descriptions.
#[must_use]
pub fn script(shell: CompletionShell) -> &'static str {
    match shell {
        CompletionShell::Bash => {
            r#"# ace completion for bash
_ace() {
  local line tab=$'\t'
  COMPREPLY=()
  while IFS= read -r line; do
    [[ -n $line ]] && COMPREPLY+=("${line%%"$tab"*}")
  done < <(ace __complete -- "${COMP_WORDS[@]:1:$((COMP_CWORD-1))}" ":${COMP_WORDS[COMP_CWORD]}" 2>/dev/null)
}
complete -o default -F _ace ace
"#
        }
        CompletionShell::Zsh => {
            r#"#compdef ace
# ace completion for zsh
_ace() {
  local -a described
  local line value tab=$'\t'
  for line in "${(@f)$(ace __complete -- "${(@)words[2,CURRENT-1]}" ":${words[CURRENT]}" 2>/dev/null)}"; do
    [[ -z $line ]] && continue
    value=${line%%$tab*}
    value=${value//:/\\:}
    if [[ $line == *$tab* ]]; then
      described+=("$value:${line#*$tab}")
    else
      described+=("$value")
    fi
  done
  _describe 'ace' described
}
compdef _ace ace
"#
        }
        CompletionShell::Fish => {
            r#"# ace completion for fish
complete -c ace -f -a '(ace __complete -- (commandline -opc)[2..-1] ":"(commandline -ct) 2>/dev/null)'
"#
        }
        CompletionShell::PowerShell => {
            r#"# ace completion for PowerShell
Register-ArgumentCompleter -Native -CommandName ace -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.ToString() })
  if ($wordToComplete -ne '' -and $words.Count -gt 0) { $words = @($words | Select-Object -SkipLast 1) }
  ace __complete -- @words ":$wordToComplete" 2>$null | Where-Object { $_ } | ForEach-Object {
    $value, $description = $_ -split "`t", 2
    if (-not $description) { $description = $value }
    [System.Management.Automation.CompletionResult]::new($value, $value, 'ParameterValue', $description)
  }
}
"#
        }
    }
}

/// The person's shell from `$SHELL`, or PowerShell on Windows.
#[must_use]
pub fn current_shell(shell: Option<&str>, platform: &str) -> Option<CompletionShell> {
    if platform == "win32" {
        return Some(CompletionShell::PowerShell);
    }
    let name = shell?.rsplit('/').next().unwrap_or("");
    SHELLS.iter().copied().find(|candidate| {
        candidate.as_str() == name || (*candidate == CompletionShell::PowerShell && name == "pwsh")
    })
}

/// Where `ace completion install` puts the script, and what the person still has to do.
pub struct InstallPlan {
    pub path: String,
    pub next: Option<String>,
}

/// The install location, from the person's home and their shell's own variables. Pure.
#[must_use]
pub fn install_plan(
    shell: CompletionShell,
    home: &str,
    data_home: Option<&str>,
    config_home: Option<&str>,
    zdot: Option<&str>,
) -> InstallPlan {
    match shell {
        CompletionShell::Bash => InstallPlan {
            path: format!(
                "{}/bash-completion/completions/ace",
                data_home.map_or_else(|| format!("{home}/.local/share"), str::to_owned)
            ),
            next: None,
        },
        CompletionShell::Zsh => InstallPlan {
            path: format!(
                "{}/.zfunc/_ace",
                zdot.map_or_else(|| home.to_owned(), str::to_owned)
            ),
            next: Some(
                "Add fpath=(~/.zfunc $fpath) before compinit in your .zshrc, then open a new shell."
                    .to_owned(),
            ),
        },
        CompletionShell::Fish => InstallPlan {
            path: format!(
                "{}/fish/completions/ace.fish",
                config_home.map_or_else(|| format!("{home}/.config"), str::to_owned)
            ),
            next: None,
        },
        CompletionShell::PowerShell => InstallPlan {
            path: format!("{home}/.config/powershell/ace-completion.ps1"),
            next: Some(
                "Add `. ~/.config/powershell/ace-completion.ps1` to your $PROFILE.".to_owned(),
            ),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{CompletionShell, install_plan};

    #[test]
    fn install_locations_follow_each_shells_own_variables() {
        let bash = install_plan(CompletionShell::Bash, "/Users/me", None, None, None);
        assert_eq!(
            bash.path,
            "/Users/me/.local/share/bash-completion/completions/ace"
        );
        assert!(bash.next.is_none());

        let zsh = install_plan(
            CompletionShell::Zsh,
            "/Users/me",
            None,
            None,
            Some("/Users/me/.config/zsh"),
        );
        assert_eq!(zsh.path, "/Users/me/.config/zsh/.zfunc/_ace");
        assert!(zsh.next.is_some_and(|next| next.contains("fpath")));

        let fish = install_plan(
            CompletionShell::Fish,
            "/Users/me",
            None,
            Some("/tmp/config"),
            None,
        );
        assert_eq!(fish.path, "/tmp/config/fish/completions/ace.fish");

        let powershell = install_plan(CompletionShell::PowerShell, "/Users/me", None, None, None);
        assert_eq!(
            powershell.path,
            "/Users/me/.config/powershell/ace-completion.ps1"
        );
        assert!(powershell.next.is_some());
    }
}
