//! Which shell commands run without asking (ADR 0130): a few read-only commands, with no shell
//! syntax that could make them do more and no argument that reaches outside the workspace.
//! Everything else asks. Pure, so the rules are tested as a table.

/// Characters that let a command do more than its program: redirection, chaining, substitution,
/// expansion of variables, subshells, escapes and line breaks.
const SHELL_SYNTAX: &[char] = &[
    ';', '&', '|', '<', '>', '$', '`', '(', ')', '{', '}', '\\', '\n', '\r',
];

/// Programs that only read, with the options that would make each write or run something.
const READ_ONLY: &[(&str, &[&str])] = &[
    ("ls", &[]),
    ("cat", &[]),
    ("head", &[]),
    ("tail", &[]),
    ("wc", &[]),
    ("grep", &[]),
    ("pwd", &[]),
    ("echo", &[]),
    ("stat", &[]),
    ("du", &[]),
    ("diff", &[]),
    ("tree", &["-o"]),
    ("date", &["-s", "--set"]),
    (
        "find",
        &[
            "-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf",
            "-fls",
        ],
    ),
];

/// Git subcommands that only read, and the options that would write a file.
const GIT_READS: &[&str] = &["status", "log", "diff", "show"];
const GIT_WRITES: &[&str] = &["--output", "-o", "--ext-diff", "--textconv"];

/// Whether `command` may run without asking on a POSIX shell. Windows always asks.
pub fn reads_only(command: &str) -> bool {
    if cfg!(windows) || command.contains(SHELL_SYNTAX) {
        return false;
    }
    let Some(words) = split(command) else {
        return false;
    };
    let Some((program, args)) = words.split_first() else {
        return false;
    };
    if args.iter().any(|arg| reaches_out(arg)) {
        return false;
    }
    if program == "git" {
        return match args.split_first() {
            Some((sub, rest)) => {
                GIT_READS.contains(&sub.as_str())
                    && !rest.iter().any(|arg| {
                        GIT_WRITES
                            .iter()
                            .any(|bad| arg == bad || arg.starts_with(&format!("{bad}=")))
                    })
            }
            None => false,
        };
    }
    let Some((_, refused)) = READ_ONLY.iter().find(|(name, _)| name == program) else {
        return false;
    };
    !args.iter().any(|arg| {
        refused
            .iter()
            .any(|bad| arg == bad || arg.starts_with(&format!("{bad}=")))
    })
}

/// An argument naming something outside the workspace: absolute, from home, or through `..`.
fn reaches_out(arg: &str) -> bool {
    let value = arg.split_once('=').map_or(arg, |(_, value)| value);
    arg.starts_with('/')
        || arg.starts_with('~')
        || value.starts_with('/')
        || value.starts_with('~')
        || arg.split('/').any(|part| part == "..")
        || value.split('/').any(|part| part == "..")
}

/// Words as `sh` splits them, for commands without escapes: spaces separate, quotes group.
/// `None` for an unclosed quote.
fn split(command: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for c in command.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => word.push(c),
            None if c == '\'' || c == '"' => {
                quote = Some(c);
                started = true;
            }
            None if c.is_whitespace() => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            None => {
                word.push(c);
                started = true;
            }
        }
    }
    if quote.is_some() {
        return None;
    }
    if started {
        words.push(word);
    }
    Some(words)
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;

    #[test]
    fn plain_reads_inside_the_workspace_run_without_asking() {
        for command in [
            "ls -la",
            "cat notes.md",
            "grep -rn \"todo list\" src",
            "head -n 20 data/out.csv",
            "find . -name '*.md'",
            "git status",
            "git log --oneline -5",
            "wc -l *.txt",
            "pwd",
        ] {
            assert!(reads_only(command), "{command} should run without asking");
        }
    }

    #[test]
    fn anything_that_could_write_run_more_or_read_outside_asks() {
        for command in [
            "rm notes.md",
            "cat notes.md > copy.md",
            "ls; rm -rf .",
            "ls && touch x",
            "cat $(echo x)",
            "cat `echo x`",
            "echo $HOME",
            "cat /etc/passwd",
            "cat ~/.ssh/id_ed25519",
            "cat ../other-bot/notes.md",
            "grep --file=/etc/hosts x",
            "find . -delete",
            "find . -exec rm {} +",
            "git diff --output=x.patch",
            "git -c core.pager=x log",
            "git push",
            "tree -o out.txt",
            "date -s 2020-01-01",
            "python3 -c 'print(1)'",
            "cat 'unclosed",
            "cat a\\ b",
            "",
        ] {
            assert!(!reads_only(command), "{command} should ask");
        }
    }
}
