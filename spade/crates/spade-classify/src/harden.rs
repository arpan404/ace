//! The form a settled command runs in (ADR 0172, amendment 3). A command the classifier settles
//! must run in a form that ignores configuration that could make a program run another one,
//! whatever the files say when it launches: Spade sets these variables on it at launch, and they
//! take precedence over every configuration file. So a command may be settled only when every
//! program in it either reads no such configuration ([`PLAIN`]) or is neutralised by these
//! variables, and only for the uses where they cover everything it can reach (git's reads that
//! never run a diff, filter or merge driver). Anything else stays with the reviewer.
//!
//! Pure: the same command always gives the same [`Hardening`], so the gate can record it with the
//! verdict and the launch can check it again.

use spade_core::autonomy::shell::{self, Simple};

/// The variables a settled command runs with, in a fixed order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hardening {
    pub env: Vec<(String, String)>,
}

impl Hardening {
    /// A short name for the overrides, recorded with the verdict and checked at launch.
    pub fn digest(&self) -> String {
        let mut h: u32 = 0x811c_9dc5;
        for (name, value) in &self.env {
            for b in name.bytes().chain([0]).chain(value.bytes()).chain([0]) {
                h ^= u32::from(b);
                h = h.wrapping_mul(0x0100_0193);
            }
        }
        format!("h{:08x}", h)
    }
}

/// Programs that read no configuration (file or variable) that can make them run a program, as
/// their documentation describes them (the audit, with the line each rests on, is in
/// `spade/docs/autonomy.md`, "Programs a settled command may run"). Each option that runs, pipes
/// to or loads a program is refused in [`settleable`].
const PLAIN: &[&str] = &[
    // Shell builtins (bash(1) "SHELL BUILTIN COMMANDS"): no configuration.
    "echo",
    "printf",
    "true",
    "false",
    "test",
    "[",
    "pwd",
    "type",
    "cd",
    "pushd",
    "popd",
    "exit",
    "return",
    "shift",
    "wait",
    "umask",
    // GNU coreutils: their variables set formats and locales only (ls(1) TIME_STYLE, LS_COLORS;
    // du(1)/df(1) BLOCK_SIZE; sort(1) TMPDIR); none names a program.
    "cat",
    "head",
    "tail",
    "wc",
    "ls",
    "sleep",
    "date",
    "basename",
    "dirname",
    "realpath",
    "readlink",
    "stat",
    "du",
    "df",
    "sort",
    "uniq",
    "cut",
    "tr",
    "comm",
    "join",
    "paste",
    "nl",
    "fold",
    "fmt",
    "expand",
    "unexpand",
    "tac",
    "od",
    "sha256sum",
    "sha1sum",
    "sha512sum",
    "md5sum",
    "cksum",
    "b2sum",
    "seq",
    "id",
    "whoami",
    "uname",
    "nproc",
    "printenv",
    "mkdir",
    "touch",
    "cp",
    "mv",
    "rm",
    "rmdir",
    "ln",
    "chmod",
    "tee",
    "truncate",
    "base32",
    "numfmt",
    "factor",
    "expr",
    "yes",
    // GNU diffutils diff(1) and cmp(1), GNU which(1), binutils strings(1).
    "diff",
    "cmp",
    "which",
    "strings",
    // util-linux: colour schemes only (terminal-colors.d).
    "rev",
    "column",
    "hexdump",
    // procps uptime(1) and free(1).
    "uptime",
    "free",
    // findutils find(1), fd(1), jq(1) (`~/.jq` is jq code, which can't run a program), file(1).
    "find",
    "fd",
    "jq",
    "file",
];

/// Programs neutralised by [`ENV`], for the uses [`settleable`] allows.
const HARDENED: &[&str] = &[
    "git", "rg", "grep", "egrep", "fgrep", "less", "more", "tar", "awk", "gawk", "mawk", "sed",
];

/// What every settled command runs with. `GIT_CONFIG_COUNT` entries are command-line scope:
/// they win over the system, global, repository, worktree and included files.
const GIT_KEYS: &[(&str, &str)] = &[
    ("core.fsmonitor", "false"),
    ("core.hooksPath", "/dev/null"),
    ("core.pager", "cat"),
    ("core.editor", "false"),
    ("core.askPass", "false"),
    ("core.sshCommand", "false"),
    ("sequence.editor", "false"),
    ("credential.helper", ""),
    ("protocol.allow", "never"),
    ("gpg.program", "false"),
    ("gpg.ssh.program", "false"),
    ("gpg.x509.program", "false"),
    ("gpg.ssh.defaultKeyCommand", "false"),
    ("log.showSignature", "false"),
    ("core.untrackedCache", "false"),
    // Files git would read or write by a path the configuration names.
    ("core.excludesFile", "/dev/null"),
    ("core.attributesFile", "/dev/null"),
    ("mailmap.file", "/dev/null"),
    ("mailmap.blob", ""),
    ("log.mailmap", "false"),
];

const ENV: &[(&str, &str)] = &[
    ("GIT_CONFIG_NOSYSTEM", "1"),
    ("GIT_CONFIG_GLOBAL", "/dev/null"),
    ("GIT_CONFIG_PARAMETERS", ""),
    ("GIT_PAGER", "cat"),
    ("GIT_EDITOR", "false"),
    ("GIT_SEQUENCE_EDITOR", "false"),
    ("GIT_ASKPASS", "false"),
    ("SSH_ASKPASS", "false"),
    ("GIT_SSH_COMMAND", "false"),
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GIT_NO_LAZY_FETCH", "1"),
    ("GIT_OPTIONAL_LOCKS", "0"),
    ("GIT_TRACE", "0"),
    ("GIT_TRACE2", "0"),
    ("GIT_TRACE2_EVENT", "0"),
    ("GIT_TRACE2_PERF", "0"),
    ("GIT_TRACE_PACKET", "0"),
    ("GIT_TRACE_PERFORMANCE", "0"),
    ("GIT_TRACE_SETUP", "0"),
    ("PAGER", "cat"),
    ("MANPAGER", "cat"),
    ("EDITOR", "false"),
    ("VISUAL", "false"),
    ("RIPGREP_CONFIG_PATH", ""),
    ("GREP_OPTIONS", ""),
    ("LESS", ""),
    ("LESSSECURE", "1"),
    ("LESSOPEN", ""),
    ("LESSCLOSE", ""),
    ("LESSKEYIN", "/dev/null"),
    ("LESSKEY", "/dev/null"),
    ("LESSKEYIN_SYSTEM", "/dev/null"),
    ("LESSHISTFILE", "-"),
    ("MORE", ""),
    ("MORESECURE", "1"),
    ("PAGERSECURE", "1"),
    ("TAR_OPTIONS", ""),
    ("AWKPATH", ""),
    ("AWKLIBPATH", ""),
];

/// The names [`hardening`] sets: a terminal never carries them to the next command.
pub fn names() -> Vec<String> {
    let mut out: Vec<String> = ENV.iter().map(|(n, _)| (*n).to_owned()).collect();
    out.push("GIT_CONFIG_COUNT".to_owned());
    for i in 0..GIT_KEYS.len() {
        out.push(format!("GIT_CONFIG_KEY_{i}"));
        out.push(format!("GIT_CONFIG_VALUE_{i}"));
    }
    out
}

fn env() -> Hardening {
    let mut env: Vec<(String, String)> = ENV
        .iter()
        .map(|(n, v)| ((*n).to_owned(), (*v).to_owned()))
        .collect();
    env.push(("GIT_CONFIG_COUNT".to_owned(), GIT_KEYS.len().to_string()));
    for (i, (key, value)) in GIT_KEYS.iter().enumerate() {
        env.push((format!("GIT_CONFIG_KEY_{i}"), (*key).to_owned()));
        env.push((format!("GIT_CONFIG_VALUE_{i}"), (*value).to_owned()));
    }
    Hardening { env }
}

/// The form `command` must run in to be settled, or `None` when no form makes it ignore the
/// configuration it could run a program from: then it stays with the reviewer.
pub fn hardening(command: &str) -> Option<Hardening> {
    // `/dev/null` names nothing on Windows.
    if cfg!(windows) {
        return None;
    }
    // Text built at run time anywhere in it (`$(…)`, backticks, `${…}`, `$((…))`) can set
    // variables or run something, and the parser reads a substitution as a command of its own.
    if command.contains("$(") || command.contains('`') || command.contains("${") {
        return None;
    }
    let commands = shell::read(command)?;
    if commands.is_empty() {
        return None;
    }
    commands.iter().all(settleable).then(env)
}

fn base(word: &str) -> &str {
    word.rsplit('/').next().unwrap_or(word)
}

fn settleable(simple: &Simple) -> bool {
    // A variable it sets (`VAR=x cmd`, `env VAR=x cmd`, a bare `VAR=x`) can change what any
    // program reads (`TAR_OPTIONS`, `LESSOPEN`, `PATH`…): never settled.
    if simple.assigns {
        return false;
    }
    // Text built at run time (`$(…)`, backticks, `${…}`, `$((…))`) can set variables or run
    // something.
    if simple
        .words
        .iter()
        .chain(&simple.writes_to)
        .chain(&simple.reads_from)
        .any(|w| w.contains("$(") || w.contains('`') || w.contains("${"))
    {
        return false;
    }
    let Some(first) = simple.words.first() else {
        // A bare redirect.
        return true;
    };
    let program = base(first);
    let args = &simple.words[1..];
    let short = |a: &str, letters: &str| {
        a.starts_with('-') && !a.starts_with("--") && a.chars().skip(1).any(|c| letters.contains(c))
    };
    if PLAIN.contains(&program) {
        return match program {
            // find(1) ACTIONS: these run a command.
            "find" => !args
                .iter()
                .any(|a| matches!(a.as_str(), "-exec" | "-execdir" | "-ok" | "-okdir")),
            // fd(1): -x/--exec and -X/--exec-batch run a command.
            "fd" => !args.iter().any(|a| {
                a.starts_with("--exec")
                    || a == "-x"
                    || a == "-X"
                    || (short(a, "xX") && !a.contains('='))
            }),
            // sort(1) --compress-program=PROG.
            "sort" => !args.iter().any(|a| a.starts_with("--compress-program")),
            // file(1): -z/-Z run external decompressing programs; -C writes a magic file.
            "file" => !args.iter().any(|a| {
                a.starts_with("--uncompress") || a.starts_with("--compile") || short(a, "zZC")
            }),
            // printf -v sets a variable.
            "printf" => !args.iter().any(|a| a == "-v"),
            // date -s sets the clock.
            "date" => !args.iter().any(|a| a.starts_with("--set") || short(a, "s")),
            _ => true,
        };
    }
    if !HARDENED.contains(&program) {
        return false;
    }
    match program {
        "git" => git(args),
        "awk" | "gawk" | "mawk" => awk(args),
        "sed" => sed(args),
        // rg(1): --pre=COMMAND and --hostname-bin=COMMAND run a program; -z/--search-zip runs
        // decompressors.
        "rg" => !args.iter().any(|a| {
            a.starts_with("--pre")
                || a.starts_with("--hostname-bin")
                || a.starts_with("--search-zip")
                || short(a, "z")
        }),
        // tar(1): --to-command, -I/--use-compress-program, -F/--info-script,
        // --new-volume-script, --checkpoint-action, --rsh-command and --rmt-command run a
        // program; an archive name with a colon is on another machine, reached through rsh.
        "tar" => !args.iter().enumerate().any(|(i, a)| {
            a.starts_with("--to-command")
                || a.starts_with("--use-compress-program")
                || a.starts_with("--checkpoint-action")
                || a.starts_with("--info-script")
                || a.starts_with("--new-volume-script")
                || a.starts_with("--rsh-command")
                || a.starts_with("--rmt-command")
                || a.contains(':')
                || short(a, "FI")
                // The old style (`tar xFf a.tar`): a first word of option letters.
                || (i == 0 && !a.starts_with('-') && (a.contains('F') || a.contains('I')))
        }),
        // less(1) and more(1): a `+` command can run a shell (`+!cmd`), save to a file or open
        // an editor, so only a line number is allowed; LESSSECURE and MORESECURE are set too.
        "less" | "more" => !args.iter().any(|a| {
            a.starts_with("--lesskey")
                || a == "-k"
                || a.starts_with('+') && !a[1..].chars().all(|c| c.is_ascii_digit())
        }),
        // grep(1): its variables set colours and locales.
        _ => true,
    }
}

/// Git's global options a settled read may carry.
const GIT_GLOBAL: &[&str] = &[
    "--no-pager",
    "-P",
    "-p",
    "--paginate",
    "--no-optional-locks",
    "--literal-pathspecs",
    "--glob-pathspecs",
    "--noglob-pathspecs",
    "--icase-pathspecs",
    "--no-replace-objects",
];

/// Options that make a log-like command compare content (and so run diff drivers and textconv),
/// write a file, or run a program.
const GIT_CONTENT: &[&str] = &[
    "-p",
    "-u",
    "--patch",
    "--stat",
    "--numstat",
    "--shortstat",
    "--dirstat",
    "--summary",
    "--patch-with-stat",
    "--patch-with-raw",
    "-S",
    "-G",
    "--pickaxe",
    "-L",
    "--word-diff",
    "--color-words",
    "--ext-diff",
    "--textconv",
    "--cc",
    "-c",
    "-m",
    "--diff-merges",
    "--output",
    "--check",
    "--full-diff",
    "--compact-summary",
    "--binary",
    "-W",
    "--function-context",
    "--find-object",
    "-O",
    "--open-files-in-pager",
    "--filters",
    "--dirty",
    "--broken",
];

fn denied(args: &[String], denied: &[&str]) -> bool {
    args.iter().any(|a| {
        denied.iter().any(|d| {
            a == d
                || a.starts_with(&format!("{d}="))
                || (d.len() == 2
                    && !d.starts_with("--")
                    && a.starts_with(d)
                    && !a.starts_with("--"))
        })
    })
}

/// A git read whose reachable program-running configuration [`GIT_KEYS`] and [`ENV`] all cover:
/// none that compares a work tree's content or a diff's (filters, textconv, diff drivers), writes,
/// edits or reaches a remote.
fn git(args: &[String]) -> bool {
    let mut rest = args;
    while let Some(first) = rest.first() {
        if !first.starts_with('-') {
            break;
        }
        if !GIT_GLOBAL.contains(&first.as_str()) {
            return false;
        }
        rest = &rest[1..];
    }
    let Some((sub, args)) = rest.split_first() else {
        return false;
    };
    let positional = args.iter().filter(|a| !a.starts_with('-')).count();
    let has = |flags: &[&str]| args.iter().any(|a| flags.contains(&a.as_str()));
    match sub.as_str() {
        "log" | "shortlog" | "rev-list" | "reflog" | "whatchanged" => {
            let expires = sub == "reflog"
                && args
                    .first()
                    .is_some_and(|a| matches!(a.as_str(), "expire" | "delete" | "drop"));
            !denied(args, GIT_CONTENT) && !expires
        }
        "rev-parse" | "show-ref" | "for-each-ref" | "merge-base" | "name-rev" | "count-objects"
        | "ls-tree" | "check-ignore" | "check-attr" | "var" | "version" | "--version" => {
            !denied(args, GIT_CONTENT)
        }
        "describe" => !denied(args, GIT_CONTENT),
        "cat-file" => !denied(args, GIT_CONTENT),
        "ls-files" => !has(&[
            "-m",
            "--modified",
            "-d",
            "--deleted",
            "-o",
            "--others",
            "-k",
            "--killed",
            "--eol",
        ]),
        "grep" => !denied(args, GIT_CONTENT) && !has(&["--no-index", "--untracked"]),
        "branch" => {
            let writes = [
                "-d",
                "-D",
                "--delete",
                "-m",
                "-M",
                "--move",
                "-c",
                "-C",
                "--copy",
                "-f",
                "--force",
                "-u",
                "--set-upstream-to",
                "--unset-upstream",
                "--edit-description",
                "-t",
                "--track",
                "--no-track",
                "--create-reflog",
            ];
            let lists = [
                "--list",
                "-l",
                "--contains",
                "--no-contains",
                "--merged",
                "--no-merged",
                "--points-at",
                "--show-current",
            ];
            !denied(args, &writes) && (positional == 0 || has(&lists))
        }
        "tag" => {
            let writes = [
                "-a",
                "--annotate",
                "-s",
                "--sign",
                "-u",
                "--local-user",
                "-f",
                "--force",
                "-d",
                "--delete",
                "-m",
                "--message",
                "-F",
                "--file",
                "-e",
                "--edit",
            ];
            let lists = [
                "-l",
                "--list",
                "--contains",
                "--no-contains",
                "--merged",
                "--points-at",
            ];
            !denied(args, &writes) && (positional == 0 || has(&lists))
        }
        "remote" => matches!(
            args.iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .as_slice(),
            [] | ["-v"] | ["--verbose"] | ["get-url", _]
        ),
        "stash" => args.first().is_some_and(|a| a == "list") && !denied(&args[1..], GIT_CONTENT),
        "worktree" => args.first().is_some_and(|a| a == "list"),
        "config" => {
            let reads = [
                "--get",
                "--get-all",
                "--get-regexp",
                "--list",
                "-l",
                "--get-urlmatch",
                "--get-color",
                "--get-colorbool",
            ];
            let writes = [
                "--edit",
                "-e",
                "--unset",
                "--unset-all",
                "--add",
                "--replace-all",
                "--rename-section",
                "--remove-section",
            ];
            !denied(args, &writes) && (has(&reads) || positional == 1)
        }
        _ => false,
    }
}

/// An awk program that runs nothing, writes nothing and reads no other file: no `system`, no
/// pipes or redirections, no `getline`, no `@include`, no program file.
fn awk(args: &[String]) -> bool {
    let mut program_seen = false;
    let mut expect_value = false;
    for a in args {
        if expect_value {
            expect_value = false;
            continue;
        }
        if a == "-f"
            || a.starts_with("--file")
            || a == "-i"
            || a.starts_with("--include")
            || a == "-l"
            || a.starts_with("--load")
            || a == "-E"
            || a.starts_with("--exec")
            || a.starts_with("--profile")
            || a.starts_with("--dump-variables")
            || a.starts_with("--pretty-print")
        {
            return false;
        }
        if a == "-F" || a == "-v" {
            expect_value = true;
            continue;
        }
        if a.starts_with('-') {
            continue;
        }
        if !program_seen {
            program_seen = true;
            let p = a.to_ascii_lowercase();
            if [
                "system", "|", ">", "getline", "@include", "@load", "close(", "fflush",
            ]
            .iter()
            .any(|bad| p.contains(bad))
            {
                return false;
            }
        }
    }
    program_seen
}

/// A sed script that only prints or substitutes into its output: no in-place edit, no `w`, `W`,
/// `r`, `R` or `e` command or `w`/`e` flag, and nothing this reading doesn't know.
fn sed(args: &[String]) -> bool {
    let mut scripts = Vec::new();
    let mut i = 0;
    let mut has_e = false;
    while i < args.len() {
        let a = &args[i];
        if a.starts_with("-i")
            || a.starts_with("--in-place")
            || a == "-f"
            || a.starts_with("--file")
        {
            return false;
        }
        if a == "-e" || a == "--expression" {
            has_e = true;
            match args.get(i + 1) {
                Some(s) => scripts.push(s.as_str()),
                None => return false,
            }
            i += 2;
            continue;
        }
        if let Some(s) = a.strip_prefix("--expression=") {
            has_e = true;
            scripts.push(s);
        } else if a.starts_with('-') {
            // -n, -E, -r, -u, -z, -s: options without values.
            if !matches!(
                a.as_str(),
                "-n" | "-E"
                    | "-r"
                    | "-u"
                    | "-z"
                    | "-s"
                    | "--quiet"
                    | "--silent"
                    | "--regexp-extended"
                    | "--null-data"
                    | "--separate"
                    | "--posix"
                    | "--debug"
            ) && !a.chars().skip(1).all(|c| "nEruzs".contains(c))
            {
                return false;
            }
        } else if !has_e && scripts.is_empty() {
            scripts.push(a.as_str());
        }
        i += 1;
    }
    !scripts.is_empty() && scripts.iter().all(|s| sed_script(s))
}

/// Whether a sed script is only addresses with `p`, `d`, `q`, `n`, `=`, `l`, braces and `s`/`y`
/// commands whose flags are `g`, `p`, `i`, `I`, `m`, `M` or a number.
fn sed_script(script: &str) -> bool {
    let chars: Vec<char> = script.chars().collect();
    let mut i = 0;
    let n = chars.len();
    while i < n {
        let c = chars[i];
        match c {
            ' ' | '\t' | '\n' | ';' | '{' | '}' | '!' | ',' => i += 1,
            '0'..='9' | '$' | '~' | '+' => i += 1,
            '/' | '\\' => {
                // An address: /re/ or \cREc.
                let delim = if c == '\\' {
                    i += 1;
                    match chars.get(i) {
                        Some(d) => *d,
                        None => return false,
                    }
                } else {
                    '/'
                };
                i += 1;
                while i < n && chars[i] != delim {
                    if chars[i] == '\\' {
                        i += 1;
                    }
                    i += 1;
                }
                if i >= n {
                    return false;
                }
                i += 1;
                // `I` and `M` modifiers after an address.
                while i < n && matches!(chars[i], 'I' | 'M') {
                    i += 1;
                }
            }
            'p' | 'P' | 'd' | 'D' | 'q' | 'Q' | 'n' | 'N' | '=' | 'l' | 'g' | 'G' | 'h' | 'H'
            | 'x' | 'z' | 'F' => i += 1,
            's' | 'y' => {
                let Some(&delim) = chars.get(i + 1) else {
                    return false;
                };
                if delim == '\n' || delim == '\\' {
                    return false;
                }
                i += 2;
                for _ in 0..2 {
                    while i < n && chars[i] != delim {
                        if chars[i] == '\\' {
                            i += 1;
                        }
                        i += 1;
                    }
                    if i >= n {
                        return false;
                    }
                    i += 1;
                }
                if c == 's' {
                    while i < n
                        && (matches!(chars[i], 'g' | 'p' | 'i' | 'I' | 'm' | 'M')
                            || chars[i].is_ascii_digit())
                    {
                        i += 1;
                    }
                    // `w`, `e` and anything else this reading doesn't know.
                    if i < n && !matches!(chars[i], ';' | '}' | ' ' | '\t' | '\n') {
                        return false;
                    }
                }
            }
            // `a`, `i`, `c` (text), `b`, `t`, `T`, `:` (labels) read on to the line's end in ways
            // this reading keeps simple: refuse them, with `w`, `W`, `r`, `R`, `e` and `v`.
            _ => return false,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settles(command: &str) -> bool {
        hardening(command).is_some()
    }

    #[test]
    fn reads_whose_configuration_is_neutralised_or_absent_have_a_form() {
        for command in [
            "ls -la src",
            "git log --oneline -5",
            "git ls-files | wc -l",
            "git rev-parse --abbrev-ref HEAD",
            "git branch --show-current",
            "git tag --list 'v*'",
            "git config --get remote.origin.url",
            "git --no-pager log -1 --format=%H",
            "rg -n TODO src",
            "grep -rn TODO src | head",
            "sed -n '1,40p' src/lib.rs",
            "sed -e 's/a/b/g' -e '/x/d' notes.txt",
            "awk -F, '{print $2}' data.csv",
            "tar tzf out.tgz",
            "less notes.txt",
            "find . -name '*.rs' -newer Cargo.toml",
            "less +42 notes.txt",
        ] {
            assert!(settles(command), "{command}");
        }
    }

    #[test]
    fn what_no_override_covers_has_no_form() {
        for command in [
            // Git commands that compare content run filters, textconv and diff drivers by name.
            "git status --short",
            "git diff",
            "git show HEAD",
            "git log -p -1",
            "git log --stat",
            "git blame src/lib.rs",
            "git add -A",
            "git commit -m x",
            "git fetch",
            "git -c core.pager=less log",
            "git -C other log",
            "git ls-files -m",
            "git grep -O TODO",
            "git log --output=out.txt",
            "git branch -D old",
            // Tools with no hard override.
            "npm ls",
            "cargo build",
            "python3 -m pytest",
            "curl -s https://example.com",
            "make",
            "bat src/lib.rs",
            // Scripts that run, write or read elsewhere.
            "awk '{system(\"ls\")}' x",
            "awk '{print > \"out\"}' x",
            "awk '{print | \"sh\"}' x",
            "awk -f prog.awk x",
            "sed -i 's/a/b/' x",
            "sed 's/a/b/w out' x",
            "sed 'w out' x",
            "sed '1e date' x",
            "sed 's/a/date/e' x",
            "sed -f script.sed x",
            "rg --pre ./x TODO",
            "find . -exec rm {} ;",
            "less '+!rm -rf x' notes.txt",
            // Any variable it sets, and text built at run time.
            "TAR_OPTIONS='--checkpoint=1 --checkpoint-action=exec=./evil' tar -tf a.tar",
            "env TAR_OPTIONS=x tar -tf a.tar",
            "LESSOPEN='|./x %s' less notes.txt",
            "X=1",
            "X=1; ls",
            "export PATH=.:$PATH",
            "declare -x LESS=x",
            "readonly X=1",
            "typeset X=1",
            "set -a",
            "read x",
            "printf -v x '%s' y",
            "echo ${X:=y}",
            "echo $((x=1))",
            "ls $(pwd)",
            "sh -c 'X=1 ls'",
            // Programs removed by the audit.
            "cloc .",
            "tree -L 2",
            "ps aux",
            "split --filter='sh' x",
            "env",
            "file -z a.gz",
            "rg -z TODO",
            "rg --hostname-bin=./h TODO",
            "tar -xf host:/tmp/a.tar",
            "tar --rsh-command=./r -tf a.tar",
            "tar tFf ./script a.tar",
            "fd -x rm",
            "more +line notes.txt",
        ] {
            assert!(!settles(command), "{command}");
        }
    }

    #[test]
    fn the_form_overrides_every_git_program_and_is_the_same_each_time() {
        let Some(h) = hardening("git log --oneline") else {
            panic!("no form");
        };
        let get = |name: &str| {
            h.env
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(get("GIT_CONFIG_NOSYSTEM"), Some("1"));
        assert_eq!(get("GIT_CONFIG_GLOBAL"), Some("/dev/null"));
        assert_eq!(get("GIT_PAGER"), Some("cat"));
        assert_eq!(get("RIPGREP_CONFIG_PATH"), Some(""));
        let count: usize = get("GIT_CONFIG_COUNT")
            .and_then(|c| c.parse().ok())
            .unwrap_or(0);
        let keys: Vec<&str> = (0..count)
            .filter_map(|i| get(&format!("GIT_CONFIG_KEY_{i}")))
            .collect();
        for key in [
            "core.fsmonitor",
            "core.hooksPath",
            "core.pager",
            "credential.helper",
            "gpg.program",
            "protocol.allow",
        ] {
            assert!(keys.contains(&key), "{key}");
        }
        assert_eq!(hardening("ls").map(|h| h.digest()), Some(h.digest()));
        assert!(names().contains(&"GIT_CONFIG_KEY_0".to_owned()));
    }
}
