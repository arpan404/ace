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
    // Shell builtins that only read (bash(1) "SHELL BUILTIN COMMANDS").
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
    // GNU coreutils that read and write only standard output; their variables set formats and
    // locales only (ls(1) TIME_STYLE, LS_COLORS; du(1)/df(1) BLOCK_SIZE).
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
    // findutils find(1) and fd(1) (reads only; write and exec actions refused), jq(1) (`~/.jq` is
    // jq code, which can neither write nor run a program), file(1).
    "find",
    "fd",
    "jq",
    "file",
];

/// Programs neutralised by [`ENV`], for the uses [`settleable`] allows.
const HARDENED: &[&str] = &["git", "rg", "grep", "egrep", "fgrep"];

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

/// Redirect targets that write nothing real: a settled command may write only to these.
fn nowhere(target: &str) -> bool {
    matches!(
        target,
        "/dev/null" | "/dev/stdout" | "/dev/stderr" | "/dev/stdin"
    ) || target.starts_with("/dev/fd/")
        || target.starts_with('&')
}

fn settleable(simple: &Simple) -> bool {
    // A variable it sets (`VAR=x cmd`, `env VAR=x cmd`, a bare `VAR=x`) can change what any
    // program reads (`TAR_OPTIONS`, `LESSOPEN`, `PATH`, `GAWK_PERSIST_FILE`…): never settled.
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
    // It writes a real file (a redirect `>`/`>>`/`&>`): the destination could be a symlink out of
    // the folder, so a settled command writes nowhere real (ADR 0172, amendment 4). A read's
    // `2>/dev/null` and stream dups (`2>&1`) are fine.
    if simple.writes_to.iter().any(|t| !nowhere(t)) {
        return false;
    }
    let Some(first) = simple.words.first() else {
        // A bare redirect to nowhere.
        return true;
    };
    let program = base(first);
    let args = &simple.words[1..];
    let short = |a: &str, letters: &str| {
        a.starts_with('-') && !a.starts_with("--") && a.chars().skip(1).any(|c| letters.contains(c))
    };
    let operands = args.iter().filter(|a| !a.starts_with('-')).count();
    if PLAIN.contains(&program) {
        return match program {
            // find(1) ACTIONS: these run a command, write a file or delete.
            "find" => !args.iter().any(|a| {
                matches!(
                    a.as_str(),
                    "-exec"
                        | "-execdir"
                        | "-ok"
                        | "-okdir"
                        | "-delete"
                        | "-fprint"
                        | "-fprint0"
                        | "-fprintf"
                        | "-fls"
                )
            }),
            // fd(1): -x/--exec and -X/--exec-batch run a command.
            "fd" => !args.iter().any(|a| {
                a.starts_with("--exec")
                    || a == "-x"
                    || a == "-X"
                    || (short(a, "xX") && !a.contains('='))
            }),
            // sort(1): -o/--output writes a file; --compress-program=PROG runs a program.
            "sort" => !args.iter().any(|a| {
                a == "-o"
                    || a.starts_with("--output")
                    || a.starts_with("--compress-program")
                    || short(a, "o")
            }),
            // uniq(1): a second operand is the output file.
            "uniq" => operands < 2,
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
        // rg(1): --pre=COMMAND and --hostname-bin=COMMAND run a program; -z/--search-zip runs
        // decompressors.
        "rg" => !args.iter().any(|a| {
            a.starts_with("--pre")
                || a.starts_with("--hostname-bin")
                || a.starts_with("--search-zip")
                || short(a, "z")
        }),
        // grep(1): its variables set colours and locales only, and it writes only standard output.
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
            "cat README.md",
            "git log --oneline -5",
            "git ls-files | wc -l",
            "git rev-parse --abbrev-ref HEAD",
            "git branch --show-current",
            "git tag --list 'v*'",
            "git config --get remote.origin.url",
            "git --no-pager log -1 --format=%H",
            "rg -n TODO src",
            "grep -rn TODO src | head",
            "find . -name '*.rs' -newer Cargo.toml",
            "cat notes.txt 2>/dev/null",
            "wc -l src/*.rs | sort -n",
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
            "find . -delete",
            "find . -fprint out",
            "less '+!rm -rf x' notes.txt",
            // Script languages and archives never settle now (ADR 0172, amendment 4).
            "awk -F, '{print $2}' data.csv",
            "sed -n '1,40p' src/lib.rs",
            r#"gawk -e '{print}' -e 'END{system("id")}' x"#,
            "tar tzf out.tgz",
            "less notes.txt",
            "more notes.txt",
            // Any write to a real file, by a program or a redirect.
            "cat a > b",
            "cat a >> b",
            "echo hi > out.txt",
            "grep foo file > out",
            "cp a b",
            "mv a b",
            "mkdir build",
            "touch x",
            "tee out.txt",
            "rm -rf x",
            "ln -sf a b",
            "sort -o out in",
            "uniq in out",
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
