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
    /// A script file, as the command names it.
    File(String),
    /// A make target: the makefile (`-f`, else the usual names) in `dir`.
    Make { dir: String, file: Option<String> },
    /// A `just` recipe: the justfile (`-f`, else the usual names) in `dir`.
    Just { dir: String, file: Option<String> },
    /// A `package.json` script, run by npm, pnpm, yarn or bun, from `dir`.
    Package { dir: String, target: String },
}

/// What one simple command does.
#[derive(Debug, Default)]
pub(super) struct Effect {
    pub sensitive: Option<Sensitive>,
    pub runs: Vec<Run>,
}

impl Effect {
    fn kind(kind: Sensitive) -> Self {
        Self {
            sensitive: Some(kind),
            runs: Vec::new(),
        }
    }

    fn run(run: Run) -> Self {
        Self {
            sensitive: None,
            runs: vec![run],
        }
    }

    fn maybe(kind: Option<Sensitive>) -> Self {
        Self {
            sensitive: kind,
            runs: Vec::new(),
        }
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

pub(super) fn classify(simple: &Simple, place: &dyn Place) -> Effect {
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
        return Effect::run(Run::File(first.clone()));
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
        "git" => {
            let Some((_, sub)) = subcommand(words, &["-C", "-c", "--git-dir", "--work-tree"])
            else {
                return Effect::default();
            };
            match sub {
                "push" => Some(Sensitive::Publish),
                "send-email" | "imap-send" => Some(Sensitive::MessageAsPerson),
                _ => None,
            }
        }
        "gh" => gh(words),
        "npm" | "pnpm" | "yarn" | "bun" => return package(program, words),
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
        "make" | "gmake" => {
            return Effect::run(Run::Make {
                dir: flag_value(words, "-C", "--directory").unwrap_or_else(|| ".".to_owned()),
                file: flag_value(words, "-f", "--file")
                    .or_else(|| flag_value(words, "-f", "--makefile")),
            });
        }
        "just" => {
            return Effect::run(Run::Just {
                dir: flag_value(words, "-d", "--working-directory")
                    .unwrap_or_else(|| ".".to_owned()),
                file: flag_value(words, "-f", "--justfile"),
            });
        }
        "source" | "." => {
            return match operands(words).first() {
                Some(file) => Effect::run(Run::File((*file).to_owned())),
                None => Effect::kind(Sensitive::Unclear),
            };
        }
        "go" if subcommand(words, &[]).is_some_and(|(_, s)| s == "run") => {
            return Effect {
                sensitive: None,
                runs: operands(words)
                    .iter()
                    .filter(|w| w.ends_with(".go"))
                    .map(|w| Run::File((*w).to_owned()))
                    .collect(),
            };
        }
        "tsx" | "ts-node" => {
            return operands(words)
                .first()
                .map_or_else(Effect::default, |f| Effect::run(Run::File((*f).to_owned())));
        }
        _ if SHELLS.contains(&program) => {
            // `sh -c` was read already; `sh file` runs the file.
            return operands(words)
                .first()
                .map_or_else(Effect::default, |f| Effect::run(Run::File((*f).to_owned())));
        }
        _ => return super::scripts::interpreter(program, words),
    };
    Effect::maybe(kind)
}

/// `npm`, `pnpm`, `yarn` and `bun`: publishing goes to the person; running a script shows it.
fn package(program: &str, words: &[String]) -> Effect {
    let Some((at, sub)) = subcommand(words, &["--prefix", "-C", "--dir", "--cwd"]) else {
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
    let next = || {
        words[at + 1..]
            .iter()
            .find(|w| !w.starts_with('-'))
            .cloned()
    };
    let target = match sub {
        "run" | "run-script" | "rum" | "urn" => next(),
        "test" | "t" | "tst" | "start" | "stop" | "restart" => Some(sub.to_owned()),
        // `yarn build` and `bun build-docs` run the package's script of that name.
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
