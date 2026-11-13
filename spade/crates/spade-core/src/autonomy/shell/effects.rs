//! What one simple command does: the kinds a reviewer may never approve for the person, and the
//! code it runs that Spade must show the reviewer (a script, a make target, inline code).

use super::super::Sensitive;
use super::super::secrets::basename;
use super::options::{self, METHODS};
use super::parse::{SHELLS, Simple};
use super::paths::{Place, outside};

/// Code a command runs from a file or a project's task list, which the reviewer must read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Run {
    /// A file run by the interpreter the command names (`python x.py`).
    File(String),
    /// A file run directly (`./x`): its `#!` line decides, and with none a shell runs it.
    Exec(String),
    /// A file run as a shell script (`sh x`, `source x`, `sh < x`), whatever its name.
    Shell(String),
    /// Make goals (none: the default goal), from the makefile (`-f`, else the usual names) in
    /// `dir`, with variables set on the command line.
    Make {
        dir: String,
        file: Option<String>,
        goals: Vec<String>,
        vars: Vec<(String, String)>,
    },
    /// `just` recipes (none: the first), from the justfile in `dir`.
    Just {
        dir: String,
        file: Option<String>,
        recipes: Vec<String>,
    },
    /// A `package.json` script, run by npm, pnpm, yarn or bun, from `dir`.
    Package { dir: String, target: String },
    /// A git command that runs the repository's hooks, from `dir`.
    GitHooks { dir: String },
}

/// What one simple command does.
#[derive(Debug, Default)]
pub(super) struct Effect {
    pub sensitive: Option<Sensitive>,
    pub runs: Vec<Run>,
    /// Paths it writes, copies, moves, links or downloads to, as written.
    pub writes: Vec<String>,
    /// It may rewrite files it doesn't name (unpacking, a checkout, a patch).
    pub rewrites: bool,
}

impl Effect {
    fn kind(kind: Sensitive) -> Self {
        Self::maybe(Some(kind))
    }

    fn run(run: Run) -> Self {
        Self {
            runs: vec![run],
            ..Self::default()
        }
    }

    fn maybe(kind: Option<Sensitive>) -> Self {
        Self {
            sensitive: kind,
            ..Self::default()
        }
    }
}

/// What `simple` does, run from `place`: its kind, the files it runs, and what it writes.
pub(super) fn classify(simple: &Simple, place: &dyn Place) -> Effect {
    let mut effect = what(simple, place);
    effect.writes = writes(simple);
    effect.rewrites = rewrites(&simple.words);
    let program = simple.words.first().map(|w| basename(w)).unwrap_or("");
    // A shell or interpreter given no file reads its program from its input: `sh < x`.
    let inline = simple.words.iter().skip(1).any(|w| {
        matches!(
            w.as_str(),
            "-c" | "-e" | "-E" | "-r" | "-p" | "--eval" | "--print"
        )
    });
    if effect.runs.is_empty()
        && !inline
        && let Some(from) = simple.reads_from.first()
    {
        if SHELLS.contains(&program) {
            effect.runs.push(Run::Shell(from.clone()));
        } else if super::scripts::is_interpreter(program) {
            effect.runs.push(Run::File(from.clone()));
        }
    }
    effect
}

/// Paths a command writes to, as written: redirects, copy and link targets, downloads.
fn writes(simple: &Simple) -> Vec<String> {
    let words = &simple.words;
    let mut out: Vec<String> = simple.writes_to.clone();
    let Some(first) = words.first() else {
        return out;
    };
    let named = |flags: &[&str]| -> Vec<String> {
        words
            .iter()
            .enumerate()
            .filter_map(|(at, w)| {
                flags.iter().find_map(|f| {
                    if w == f {
                        words.get(at + 1).cloned()
                    } else if f.starts_with("--") {
                        w.strip_prefix(&format!("{f}=")).map(str::to_owned)
                    } else {
                        w.strip_prefix(f)
                            .filter(|v| !v.is_empty())
                            .map(str::to_owned)
                    }
                })
            })
            .collect()
    };
    // The name a download takes from its URL.
    let from_urls = || -> Vec<String> {
        operands(words)
            .iter()
            .filter(|w| w.contains("://"))
            .filter_map(|url| url.split(['?', '#']).next()?.rsplit('/').next())
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect()
    };
    match basename(first) {
        "cp" | "mv" | "ln" | "install" | "ditto" | "rsync" | "scp" => {
            out.extend(named(&["-t", "--target-directory"]));
            out.extend(operands(words).last().map(|w| (*w).to_owned()));
        }
        "tee" | "touch" | "truncate" => out.extend(operands(words).iter().map(|w| (*w).to_owned())),
        "dd" => out.extend(
            words
                .iter()
                .filter_map(|w| w.strip_prefix("of="))
                .map(str::to_owned),
        ),
        "sed" | "perl" | "ruby"
            if words.iter().any(|w| {
                w == "-i"
                    || (w.starts_with("-i") && !w.starts_with("--"))
                    || w.starts_with("--in-place")
            }) =>
        {
            out.extend(operands(words).iter().skip(1).map(|w| (*w).to_owned()));
        }
        "curl" => {
            out.extend(named(&["-o", "--output", "--output-dir"]));
            if words.iter().any(|w| {
                w == "-O"
                    || w == "--remote-name"
                    || w == "--remote-name-all"
                    || (w.starts_with('-') && !w.starts_with("--") && w.contains('O'))
            }) {
                out.extend(from_urls());
            }
        }
        "wget" => {
            let named_out = named(&["-O", "--output-document", "-P", "--directory-prefix"]);
            if named_out.is_empty() {
                out.extend(from_urls());
            }
            out.extend(named_out);
        }
        _ => {}
    }
    out
}

/// Whether a command may rewrite files it doesn't name: unpacking, checking out, patching.
fn rewrites(words: &[String]) -> bool {
    let Some(first) = words.first() else {
        return false;
    };
    match basename(first) {
        "tar" | "bsdtar" | "gtar" => words.iter().skip(1).any(|w| {
            w == "--extract"
                || w == "--get"
                || (!w.starts_with("--") && w.trim_start_matches('-').contains('x'))
        }),
        "unzip" | "patch" | "cpio" | "7z" | "unrar" | "ditto" => true,
        "git" => {
            subcommand(words, &["-C", "-c", "--git-dir", "--work-tree"]).is_some_and(|(_, s)| {
                matches!(
                    s,
                    "checkout"
                        | "switch"
                        | "pull"
                        | "reset"
                        | "restore"
                        | "apply"
                        | "am"
                        | "stash"
                        | "merge"
                        | "rebase"
                        | "cherry-pick"
                        | "revert"
                        | "clone"
                        | "worktree"
                )
            })
        }
        _ => false,
    }
}

/// Git's own commands; any other first word is an alias, which can run anything.
const GIT_OWN: &[&str] = &[
    "add",
    "am",
    "annotate",
    "apply",
    "archive",
    "bisect",
    "blame",
    "branch",
    "bundle",
    "cat-file",
    "check-attr",
    "check-ignore",
    "check-mailmap",
    "check-ref-format",
    "checkout",
    "cherry",
    "cherry-pick",
    "citool",
    "clean",
    "clone",
    "column",
    "commit",
    "commit-graph",
    "commit-tree",
    "config",
    "count-objects",
    "credential",
    "describe",
    "diff",
    "diff-files",
    "diff-index",
    "diff-tree",
    "difftool",
    "fetch",
    "fetch-pack",
    "filter-branch",
    "for-each-ref",
    "for-each-repo",
    "format-patch",
    "fsck",
    "gc",
    "grep",
    "hash-object",
    "help",
    "init",
    "instaweb",
    "interpret-trailers",
    "log",
    "ls-files",
    "ls-remote",
    "ls-tree",
    "maintenance",
    "merge",
    "merge-base",
    "merge-file",
    "merge-tree",
    "mergetool",
    "mktag",
    "mktree",
    "mv",
    "name-rev",
    "notes",
    "pack-objects",
    "pack-refs",
    "prune",
    "pull",
    "push",
    "range-diff",
    "read-tree",
    "rebase",
    "reflog",
    "remote",
    "repack",
    "replace",
    "rerere",
    "reset",
    "restore",
    "rev-list",
    "rev-parse",
    "revert",
    "rm",
    "send-email",
    "imap-send",
    "shortlog",
    "show",
    "show-branch",
    "show-ref",
    "sparse-checkout",
    "stash",
    "status",
    "stripspace",
    "submodule",
    "switch",
    "symbolic-ref",
    "tag",
    "update-index",
    "update-ref",
    "var",
    "verify-commit",
    "verify-pack",
    "verify-tag",
    "version",
    "whatchanged",
    "worktree",
    "write-tree",
    "lfs",
    "request-pull",
    "shell",
    "sparse",
    "backfill",
];

/// Git commands that run the repository's hooks.
const GIT_HOOKED: &[&str] = &[
    "commit",
    "merge",
    "pull",
    "push",
    "rebase",
    "am",
    "checkout",
    "switch",
    "clone",
    "worktree",
    "cherry-pick",
    "revert",
    "gc",
    "apply",
    "receive-pack",
    "send-email",
    "maintenance",
];

fn git(words: &[String]) -> Effect {
    let lower: Vec<String> = words.iter().map(|w| w.to_lowercase()).collect();
    // Hooks moved elsewhere, or a command given as configuration.
    if lower.iter().any(|w| {
        w.contains("hookspath")
            || w.contains("core.sshcommand")
            || w.contains("core.pager")
            || w.contains("alias.")
            || w.contains("core.fsmonitor")
    }) {
        return Effect::kind(Sensitive::Unclear);
    }
    let Some((_, sub)) = subcommand(
        words,
        &["-C", "-c", "--git-dir", "--work-tree", "--namespace"],
    ) else {
        return Effect::default();
    };
    if !GIT_OWN.contains(&sub) {
        return Effect::kind(Sensitive::Unclear);
    }
    let kind = match sub {
        "push" => Some(Sensitive::Publish),
        "send-email" | "imap-send" => Some(Sensitive::MessageAsPerson),
        _ => None,
    };
    let runs = if GIT_HOOKED.contains(&sub) {
        vec![Run::GitHooks {
            dir: flag_value(words, "-C", "-C").unwrap_or_else(|| ".".to_owned()),
        }]
    } else {
        Vec::new()
    };
    Effect {
        sensitive: kind,
        runs,
        ..Effect::default()
    }
}

/// The words after the program that aren't flags.
fn operands(words: &[String]) -> Vec<&str> {
    words
        .iter()
        .skip(1)
        .map(String::as_str)
        .filter(|w| !w.starts_with('-'))
        .collect()
}

/// The first word after the program that isn't a flag, skipping the values of `valued` flags.
fn subcommand<'a>(words: &'a [String], valued: &[&str]) -> Option<(usize, &'a str)> {
    let mut skip = false;
    for (at, word) in words.iter().enumerate().skip(1) {
        if skip {
            skip = false;
            continue;
        }
        if word.starts_with('-') {
            skip = valued.contains(&word.as_str());
            continue;
        }
        return Some((at, word));
    }
    None
}

/// The value of `-f F`, `-fF` or `--long=F` / `--long F`.
fn flag_value(words: &[String], short: &str, long: &str) -> Option<String> {
    words.iter().enumerate().find_map(|(at, w)| {
        if w == short || w == long {
            words.get(at + 1).cloned()
        } else if let Some(v) = w.strip_prefix(&format!("{long}=")) {
            Some(v.to_owned())
        } else {
            w.strip_prefix(short)
                .filter(|v| !v.is_empty() && !short.starts_with("--"))
                .map(str::to_owned)
        }
    })
}

/// Programs named by a path that are the system's own, not a script of the bot's.
fn system_program(path: &str) -> bool {
    [
        "/bin/",
        "/sbin/",
        "/usr/",
        "/opt/homebrew/",
        "/System/",
        "/nix/",
        "/snap/",
    ]
    .iter()
    .any(|dir| path.starts_with(dir))
}

fn what(simple: &Simple, place: &dyn Place) -> Effect {
    if simple.writes_to.iter().any(|t| outside(place, t)) {
        return Effect::kind(Sensitive::WriteOutside);
    }
    let words = &simple.words;
    let Some(first) = words.first() else {
        return Effect::default();
    };
    let program = basename(first);
    // A program named by its path is a script, unless it is one of the system's.
    if first.contains('/') && !system_program(first) {
        return Effect::run(Run::Exec(first.clone()));
    }
    let lower: Vec<String> = words.iter().map(|w| w.to_lowercase()).collect();
    let has = |flags: &[&str]| {
        words.iter().any(|w| {
            flags
                .iter()
                .any(|f| w == f || (f.starts_with("--") && w.starts_with(&format!("{f}="))))
        })
    };
    let kind = match program {
        "sudo" | "doas" | "su" | "pkexec" | "runuser" | "runas" | "launchctl" | "systemctl"
        | "crontab" | "reboot" | "shutdown" | "halt" | "diskutil" | "mount" | "umount"
        | "chflags" => Some(Sensitive::Admin),
        "osascript" | "automator" | "shortcuts" | "xdotool" | "ydotool" | "cliclick" | "open"
        | "xdg-open" | "start" => Some(Sensitive::Automation),
        "stripe" | "paypal" => Some(Sensitive::Payment),
        "mail" | "mailx" | "sendmail" | "mutt" | "neomutt" | "msmtp" | "swaks" => {
            Some(Sensitive::MessageAsPerson)
        }
        "nc" | "ncat" | "netcat" | "socat" | "telnet" | "ftp" | "lftp" | "sftp" | "tftp"
        | "ssh" | "mosh" => Some(Sensitive::Network),
        "curl" => options::curl(words),
        "wget" => options::wget(words),
        "http" | "https" | "xh" | "xhs" | "httpie" => {
            let method = operands(words)
                .first()
                .is_some_and(|w| METHODS.contains(&w.to_uppercase().as_str()));
            let data = operands(words).iter().any(|w| {
                !w.contains("://") && !w.contains("==") && (w.contains('=') || w.contains(":@"))
            });
            (method || data || has(&["--form", "-f", "--raw", "--multipart"]))
                .then_some(Sensitive::Network)
        }
        "scp" | "rsync" => {
            if operands(words).iter().any(|w| remote(w)) {
                Some(Sensitive::Network)
            } else {
                last_outside(words, place)
            }
        }
        "git" => return git(words),
        "npx" | "bunx" | "pnpx" => return runner(words, 1, place),
        "gh" => gh(words),
        "npm" | "pnpm" | "yarn" | "bun" => return package(program, words, place),
        "cargo" => subcommand(words, &[])
            .is_some_and(|(_, s)| matches!(s, "publish" | "yank" | "owner"))
            .then_some(Sensitive::Publish),
        "twine" | "flit" | "hatch" | "poetry" | "uv" | "gem" => subcommand(words, &[])
            .is_some_and(|(_, s)| matches!(s, "upload" | "publish" | "push" | "yank" | "owner"))
            .then_some(Sensitive::Publish),
        "docker" | "podman" | "buildah" => {
            (subcommand(words, &[]).is_some_and(|(_, s)| s == "push") || has(&["--push"]))
                .then_some(Sensitive::Publish)
        }
        "vercel" | "netlify" | "fly" | "flyctl" | "firebase" | "heroku" => lower
            .iter()
            .any(|w| matches!(w.as_str(), "deploy" | "--prod" | "release"))
            .then_some(Sensitive::Publish),
        "kubectl" | "oc" => subcommand(words, &["-n", "--namespace", "--context"])
            .is_some_and(|(_, s)| {
                matches!(
                    s,
                    "apply"
                        | "delete"
                        | "create"
                        | "replace"
                        | "patch"
                        | "scale"
                        | "edit"
                        | "rollout"
                        | "drain"
                        | "cordon"
                        | "set"
                        | "label"
                        | "annotate"
                        | "exec"
                )
            })
            .then_some(Sensitive::RemoteChange),
        "helm" => subcommand(words, &[])
            .is_some_and(|(_, s)| {
                matches!(
                    s,
                    "install" | "upgrade" | "uninstall" | "delete" | "rollback"
                )
            })
            .then_some(Sensitive::RemoteChange),
        "terraform" | "tofu" | "pulumi" | "cdk" | "serverless" | "sls" => lower
            .iter()
            .any(|w| matches!(w.as_str(), "apply" | "destroy" | "import" | "up" | "deploy"))
            .then_some(Sensitive::RemoteChange),
        "wrangler" => lower
            .iter()
            .any(|w| {
                matches!(
                    w.as_str(),
                    "deploy" | "publish" | "delete" | "secret" | "put"
                )
            })
            .then_some(Sensitive::RemoteChange),
        "aws" | "gcloud" | "az" | "gsutil" => lower
            .iter()
            .skip(1)
            .any(|w| {
                [
                    "delete", "put", "create", "update", "rm", "mv", "cp", "sync", "deploy", "set",
                ]
                .iter()
                .any(|verb| w == verb || w.starts_with(&format!("{verb}-")))
            })
            .then_some(Sensitive::RemoteChange),
        "rm" | "rmdir" | "unlink" | "shred" | "srm" | "trash" => operands(words)
            .iter()
            .any(|p| outside(place, p))
            .then_some(Sensitive::DeleteOutside),
        "mv" | "tee" | "touch" | "mkdir" | "truncate" | "chmod" | "chown" | "chgrp" | "setfacl"
        | "xattr" => operands(words)
            .iter()
            .any(|p| outside(place, p))
            .then_some(Sensitive::WriteOutside),
        "ln" => link(words, place),
        "cp" | "install" | "ditto" => last_outside(words, place),
        "dd" => words
            .iter()
            .filter_map(|w| w.strip_prefix("of="))
            .any(|p| outside(place, p))
            .then_some(Sensitive::WriteOutside),
        "find" => find(words, place),
        "make" | "gmake" => return make(words),
        "just" => {
            let valued = ["-f", "--justfile", "-d", "--working-directory", "--set"];
            return Effect::run(Run::Just {
                dir: flag_value(words, "-d", "--working-directory")
                    .unwrap_or_else(|| ".".to_owned()),
                file: flag_value(words, "-f", "--justfile"),
                recipes: plain_operands(words, &valued)
                    .into_iter()
                    .filter(|w| !w.contains('='))
                    .collect(),
            });
        }
        "source" | "." => {
            return match operands(words).first() {
                Some(file) => Effect::run(Run::Shell((*file).to_owned())),
                None => Effect::kind(Sensitive::Unclear),
            };
        }
        "go" if subcommand(words, &[]).is_some_and(|(_, s)| s == "run") => {
            return Effect {
                runs: operands(words)
                    .iter()
                    .filter(|w| w.ends_with(".go"))
                    .map(|w| Run::File((*w).to_owned()))
                    .collect(),
                ..Effect::default()
            };
        }
        "tsx" | "ts-node" => {
            return operands(words)
                .first()
                .map_or_else(Effect::default, |f| Effect::run(Run::File((*f).to_owned())));
        }
        _ if SHELLS.contains(&program) => {
            // `sh -c` was read already; `sh file` runs the file as a shell script.
            return operands(words).first().map_or_else(Effect::default, |f| {
                Effect::run(Run::Shell((*f).to_owned()))
            });
        }
        _ => return super::scripts::interpreter(program, words),
    };
    Effect::maybe(kind)
}

/// `npm`, `pnpm`, `yarn` and `bun`: publishing goes to the person; running a script shows it;
/// running a package that isn't installed here fetches and runs code Spade never sees.
fn package(program: &str, words: &[String], place: &dyn Place) -> Effect {
    let valued = [
        "--prefix",
        "-C",
        "--dir",
        "--cwd",
        "-w",
        "--workspace",
        "--filter",
    ];
    let Some((at, sub)) = subcommand(words, &valued) else {
        return Effect::default();
    };
    if matches!(
        sub,
        "publish" | "unpublish" | "deprecate" | "owner" | "dist-tag" | "access"
    ) {
        return Effect::kind(Sensitive::Publish);
    }
    let dir = flag_value(words, "--prefix", "--prefix")
        .or_else(|| flag_value(words, "-C", "--dir"))
        .or_else(|| flag_value(words, "--cwd", "--cwd"))
        .unwrap_or_else(|| ".".to_owned());
    // `npm exec x`, `pnpm dlx x`, `yarn dlx x`, `bun x x`.
    if matches!(sub, "exec" | "x" | "dlx") {
        let place = super::paths::moved(place, &dir);
        return match &place {
            Some(place) => runner(&words[at..], 1, place),
            None => Effect::kind(Sensitive::Unclear),
        };
    }
    let next = || {
        words[at + 1..]
            .iter()
            .find(|w| !w.starts_with('-'))
            .cloned()
    };
    let target = match sub {
        "run" | "run-script" | "rum" | "urn" => next(),
        "test" | "t" | "tst" => Some("test".to_owned()),
        "start" | "stop" | "restart" => Some(sub.to_owned()),
        // `yarn build` runs the package's script of that name.
        _ if program == "yarn" && !YARN_OWN.contains(&sub) => Some(sub.to_owned()),
        _ => None,
    };
    match target {
        // `bun run file.ts` runs the file.
        Some(target) if program == "bun" && (target.contains('/') || target.contains('.')) => {
            Effect::run(Run::File(target))
        }
        Some(target) => Effect::run(Run::Package { dir, target }),
        None if program == "bun" && (sub.contains('/') || sub.contains('.')) => {
            Effect::run(Run::File(sub.to_owned()))
        }
        None => Effect::default(),
    }
}

/// `npx x`, `bunx x` and the like: a package installed in the project runs its own program (as
/// any installed program does); one that isn't is fetched from the network first.
fn runner(words: &[String], from: usize, place: &dyn Place) -> Effect {
    let valued = ["-p", "--package", "-c", "--call"];
    if words.iter().any(|w| w == "-c" || w == "--call") {
        return Effect::kind(Sensitive::Unclear);
    }
    let Some(name) = plain_operands(&words[from - 1..], &valued)
        .into_iter()
        .next()
    else {
        return Effect::kind(Sensitive::Unclear);
    };
    let name = name
        .split('@')
        .find(|p| !p.is_empty())
        .unwrap_or(&name)
        .to_owned();
    let local = place
        .resolve(&format!("node_modules/.bin/{name}"))
        .is_some_and(|real| !matches!(place.read(&real, 1), Err(super::paths::Unseen::Missing)));
    let fetches = words
        .iter()
        .any(|w| w == "-p" || w.starts_with("--package"));
    if local && !fetches {
        Effect::default()
    } else {
        Effect::kind(Sensitive::Network)
    }
}

/// `make [flags] [VAR=value…] [goal…]`.
fn make(words: &[String]) -> Effect {
    let valued = [
        "-C",
        "--directory",
        "-f",
        "--file",
        "--makefile",
        "-I",
        "--include-dir",
        "-j",
        "--jobs",
        "-l",
        "--load-average",
        "-o",
        "--old-file",
        "-W",
        "--what-if",
        "--assume-new",
    ];
    // `-e` lets the environment override the makefile, `--eval` adds to it: neither is read.
    if words
        .iter()
        .any(|w| w == "-e" || w == "--environment-overrides" || w.starts_with("--eval"))
    {
        return Effect::kind(Sensitive::Unclear);
    }
    let (vars, goals): (Vec<String>, Vec<String>) = plain_operands(words, &valued)
        .into_iter()
        .partition(|w| w.contains('='));
    Effect::run(Run::Make {
        dir: flag_value(words, "-C", "--directory").unwrap_or_else(|| ".".to_owned()),
        file: flag_value(words, "-f", "--file").or_else(|| flag_value(words, "-f", "--makefile")),
        goals,
        vars: vars
            .iter()
            .filter_map(|w| {
                let (name, value) = w.split_once('=')?;
                Some((
                    name.trim_end_matches([':', '+', '?']).to_owned(),
                    value.to_owned(),
                ))
            })
            .collect(),
    })
}

/// The words after the program that aren't flags or the values of `valued` flags.
fn plain_operands(words: &[String], valued: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    let mut skip = false;
    for word in words.iter().skip(1) {
        if skip {
            skip = false;
            continue;
        }
        if word.starts_with('-') {
            skip = valued.contains(&word.as_str());
            continue;
        }
        out.push(word.clone());
    }
    out
}

/// Yarn's own commands; any other first word runs the package's script.
const YARN_OWN: &[&str] = &[
    "add",
    "audit",
    "autoclean",
    "bin",
    "cache",
    "check",
    "config",
    "create",
    "dlx",
    "exec",
    "generate-lock-entry",
    "global",
    "help",
    "import",
    "info",
    "init",
    "install",
    "licenses",
    "link",
    "list",
    "login",
    "logout",
    "node",
    "outdated",
    "owner",
    "pack",
    "plugin",
    "policies",
    "remove",
    "set",
    "team",
    "unlink",
    "unplug",
    "upgrade",
    "upgrade-interactive",
    "version",
    "versions",
    "why",
    "workspace",
    "workspaces",
    "up",
    "dedupe",
    "explain",
    "npm",
    "patch",
    "rebuild",
    "search",
    "stage",
];

/// `host:path` or `user@host:path`, not a local path or a URL.
fn remote(word: &str) -> bool {
    if word.starts_with('/') || word.starts_with("./") || word.starts_with('~') {
        return false;
    }
    if word.starts_with("rsync://") || word.contains("::") {
        return true;
    }
    match word.split_once(':') {
        Some((host, _)) => !host.is_empty() && !host.contains('/') && host.len() > 1,
        None => false,
    }
}

/// For copies: the target (the last operand, or `-t DIR`) leaves the folder.
fn last_outside(words: &[String], place: &dyn Place) -> Option<Sensitive> {
    let flagged = words.iter().enumerate().find_map(|(at, w)| {
        if w == "-t" || w == "--target-directory" {
            words.get(at + 1).map(String::as_str)
        } else {
            w.strip_prefix("--target-directory=")
        }
    });
    let last = operands(words).last().copied();
    flagged
        .into_iter()
        .chain(last)
        .any(|p| outside(place, p))
        .then_some(Sensitive::WriteOutside)
}

/// `ln`: the link's place, and for a symbolic link where it points, from the link's folder: a
/// link into somewhere else lets later writes through it leave the folder.
fn link(words: &[String], place: &dyn Place) -> Option<Sensitive> {
    if let Some(kind) = last_outside(words, place) {
        return Some(kind);
    }
    let symbolic = words.iter().skip(1).any(|w| {
        w == "--symbolic" || (w.starts_with('-') && !w.starts_with("--") && w.contains('s'))
    });
    let names = operands(words);
    if !symbolic || names.is_empty() {
        return None;
    }
    let (targets, folder) = if names.len() == 1 {
        (&names[..], ".".to_owned())
    } else {
        let link = names[names.len() - 1];
        let folder = std::path::Path::new(link)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| ".".to_owned());
        (&names[..names.len() - 1], folder)
    };
    targets
        .iter()
        .any(|target| {
            let from = if target.starts_with('/') || target.starts_with('~') {
                (*target).to_owned()
            } else {
                format!("{folder}/{target}")
            };
            outside(place, &from)
        })
        .then_some(Sensitive::WriteOutside)
}

fn gh(words: &[String]) -> Option<Sensitive> {
    let (at, sub) = subcommand(words, &["-R", "--repo"])?;
    let action = words[at + 1..]
        .iter()
        .find(|w| !w.starts_with('-'))
        .map(String::as_str);
    match (sub, action) {
        (
            "pr" | "issue" | "release" | "repo" | "gist" | "label" | "project" | "variable",
            Some(
                "create" | "merge" | "edit" | "close" | "reopen" | "comment" | "review" | "upload"
                | "delete" | "lock" | "transfer" | "ready" | "set",
            ),
        ) => Some(Sensitive::Publish),
        ("api", _) => options::gh_api_writes(words).then_some(Sensitive::Publish),
        ("workflow" | "run", Some("run" | "rerun" | "cancel" | "enable" | "disable")) => {
            Some(Sensitive::RemoteChange)
        }
        _ => None,
    }
}

/// `find` acting (`-delete`, `-exec`…) from a starting point outside the folder. What `-exec`
/// runs is unwrapped and checked as a command of its own.
fn find(words: &[String], place: &dyn Place) -> Option<Sensitive> {
    let acts = words.iter().any(|w| {
        matches!(
            w.as_str(),
            "-delete" | "-exec" | "-execdir" | "-ok" | "-okdir" | "-fprint" | "-fprintf" | "-fls"
        )
    });
    if !acts {
        return None;
    }
    let mut starts = words
        .iter()
        .skip(1)
        .take_while(|w| !w.starts_with('-') && *w != "(" && *w != "!")
        .peekable();
    // No starting point is the folder itself.
    starts.peek()?;
    starts
        .any(|p| outside(place, p))
        .then_some(Sensitive::DeleteOutside)
}
