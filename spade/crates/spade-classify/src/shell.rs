//! A shell command's features, from Spade's own shell parser (`spade_core::autonomy::shell`):
//! each simple command's program, subcommands, flags, the shapes of its arguments (URLs and their
//! hosts, paths against the bot's folder), its redirects, what it is piped into, here-document
//! text, and the words of inline code. Then markers of hiding (`$(…)`, backticks, `eval`, a
//! pipe into a shell, escapes, look-alike letters) and character n-grams of the whole text, so an
//! obfuscated command still lands near what it hides.

use spade_core::autonomy::shell::{self, Simple};

use crate::hash::Bag;
use crate::shape;
use crate::text;

/// The most of a command read; past it the rest is cut, and that is a feature.
const LONGEST: usize = 8 * 1024;
/// The most of a command's text n-grams are taken from.
const GRAMS: usize = 1024;
/// The most simple commands read.
const MOST_COMMANDS: usize = 32;
/// The most words read from one simple command, and tokens taken from its words.
const MOST_WORDS: usize = 64;
const MOST_TOKENS: usize = 96;

/// Programs that run text they are given as code or as a command.
const SHELLS: &[&str] = &[
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "fish",
    "python",
    "python3",
    "node",
    "perl",
    "ruby",
    "php",
    "osascript",
    "deno",
    "bun",
    "pwsh",
    "powershell",
    "lua",
    "tclsh",
    "awk",
];

/// What reading a command found besides its features, for whether it may ever be settled.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct Found {
    /// An argument may point outside the bot's folders.
    pub outside: bool,
    /// It hides what it runs: decoded or built text run as code, `eval`, a program from a
    /// variable, escapes, look-alike or invisible letters, or text the parser can't read.
    pub hides: bool,
    /// Some structural input was past a feature bound (too long, too many commands or words), so
    /// part of it was not examined: it is never settled, since what was dropped could be an
    /// outside path or an unknown program.
    pub dropped: bool,
    /// It may reach another machine: a program that can, or an argument naming a place on the
    /// network (a URL, a host, an address). Never settled while untrusted content is in view.
    pub network: bool,
}

/// Programs that can reach another machine, whatever their arguments say. With untrusted content
/// in view a command running one is never settled, so text it read can't be sent anywhere
/// without a review. This list only ever makes the model more careful; it routes nothing.
const NETWORK: &[&str] = &[
    "curl",
    "wget",
    "http",
    "https",
    "xh",
    "httpie",
    "aria2c",
    "ssh",
    "scp",
    "sftp",
    "rsync",
    "nc",
    "ncat",
    "netcat",
    "socat",
    "telnet",
    "ftp",
    "ping",
    "dig",
    "nslookup",
    "host",
    "whois",
    "mtr",
    "traceroute",
    "gh",
    "glab",
    "hub",
    "tea",
    "aws",
    "gcloud",
    "gsutil",
    "az",
    "doctl",
    "heroku",
    "vercel",
    "netlify",
    "fly",
    "flyctl",
    "wrangler",
    "firebase",
    "supabase",
    "railway",
    "render",
    "kubectl",
    "helm",
    "terraform",
    "tofu",
    "pulumi",
    "docker",
    "podman",
    "npm",
    "npx",
    "pnpm",
    "pnpx",
    "yarn",
    "bun",
    "bunx",
    "deno",
    "pip",
    "pip3",
    "uv",
    "uvx",
    "poetry",
    "pipenv",
    "conda",
    "mamba",
    "cargo",
    "rustup",
    "go",
    "gem",
    "bundle",
    "composer",
    "brew",
    "apt",
    "apt-get",
    "pacman",
    "yay",
    "paru",
    "dnf",
    "yum",
    "snap",
    "flatpak",
    "nix",
    "rclone",
    "s3cmd",
    "mail",
    "mailx",
    "sendmail",
    "mutt",
    "msmtp",
    "osascript",
    "open",
    "xdg-open",
    "stripe",
    "op",
    "vault",
    "ollama",
    "mvn",
    "gradle",
    "dotnet",
    "swift",
    "flutter",
    "dart",
    "jj",
    "hg",
    "svn",
    "python",
    "python3",
    "node",
    "perl",
    "ruby",
    "php",
    "lua",
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "fish",
    "pwsh",
    "powershell",
    "make",
    "just",
    "task",
    "xargs",
    "parallel",
    "socket",
];

/// Programs that run a command with the person's secrets put into its environment (`doppler run
/// -- ls`, `op run -- …`, `aws-vault exec prod -- …`): the command they wrap is what the parser
/// shows, but it runs with the person's sign-ins, so the whole is never settled.
const SECRET_RUNNERS: &[&str] = &[
    "doppler",
    "aws-vault",
    "infisical",
    "chamber",
    "envchain",
    "teller",
    "dotenvx",
    "berglas",
    "varlock",
    "summon",
    "with-secrets",
];

/// Of programs with other uses, the subcommands that do the same (`op run`, `sops exec-env`).
const SECRET_SUBCOMMANDS: &[(&str, &str)] = &[
    ("op", "run"),
    ("sops", "exec-env"),
    ("sops", "exec-file"),
    ("vault", "exec"),
    ("gopass", "env"),
    ("pass", "env"),
];

/// Whether `lower` starts a command, anywhere in it, with a program that injects the person's
/// secrets. Read from the words as written, since the parser takes such wrappers off.
fn runs_with_secrets(lower: &str) -> bool {
    lower
        .split(['\n', ';', '|', '&', '(', ')', '`', '{', '}'])
        .any(|segment| {
            let mut words = segment.split_whitespace().skip_while(|w| {
                w.contains('=')
                    || matches!(
                        *w,
                        "sudo"
                            | "env"
                            | "exec"
                            | "command"
                            | "nohup"
                            | "time"
                            | "then"
                            | "do"
                            | "!"
                    )
            });
            let Some(first) = words.next() else {
                return false;
            };
            let first = first.rsplit('/').next().unwrap_or(first);
            let next = words.find(|w| !w.starts_with('-')).unwrap_or("");
            SECRET_RUNNERS.contains(&first) || SECRET_SUBCOMMANDS.contains(&(first, next))
        })
}

/// `git` subcommands that reach a remote.
const GIT_NETWORK: &[&str] = &[
    "fetch",
    "pull",
    "push",
    "clone",
    "ls-remote",
    "submodule",
    "remote",
    "send-email",
    "request-pull",
    "archive",
    "lfs",
    "credential",
];

/// Options that make a program run another program it names, by program: a command with one
/// hides what it runs, so it is never settled (`rg --pre`, `tar --to-command`, `rsync -e`).
const RUNS_ANOTHER: &[(&str, &[&str])] = &[
    ("rg", &["--pre"]),
    (
        "tar",
        &[
            "-I",
            "--use-compress-program",
            "--to-command",
            "--checkpoint-action",
            "--info-script",
            "--new-volume-script",
            "-F",
        ],
    ),
    ("sort", &["--compress-program"]),
    ("rsync", &["-e", "--rsh", "--rsync-path"]),
    (
        "git",
        &[
            "-c",
            "--config-env",
            "--exec-path",
            "--upload-pack",
            "--receive-pack",
            "--ext-diff",
            "--textconv",
        ],
    ),
    ("zip", &["-TT", "--unzip-command"]),
    ("man", &["-P", "--pager", "-H"]),
    ("less", &["--lesskey-src", "-k"]),
    ("find", &["-exec", "-execdir", "-ok", "-okdir"]),
    ("fd", &["-x", "--exec", "-X", "--exec-batch"]),
    ("ssh", &["-o", "-F"]),
    ("dpkg", &["--root"]),
    ("vim", &["-c", "--cmd", "-S"]),
    ("nvim", &["-c", "--cmd", "-S"]),
    ("emacs", &["--eval", "-l", "--load"]),
    ("watch", &["-x"]),
    ("entr", &[]),
];

/// Programs whose first word is a subcommand (`git push`, `npm publish`): for them the
/// subcommand is a key part of what the command is, so one never seen in a low-risk command
/// is never settled. For any other program the first argument is data (a file, a pattern).
/// This list only ever makes the model more careful; it routes nothing.
const SUBCOMMANDS: &[&str] = &[
    "git",
    "gh",
    "npm",
    "pnpm",
    "yarn",
    "bun",
    "deno",
    "cargo",
    "go",
    "rustup",
    "uv",
    "pip",
    "pip3",
    "poetry",
    "gem",
    "bundle",
    "brew",
    "apt",
    "apt-get",
    "dnf",
    "docker",
    "podman",
    "kubectl",
    "helm",
    "terraform",
    "aws",
    "gcloud",
    "gsutil",
    "az",
    "doctl",
    "heroku",
    "vercel",
    "netlify",
    "fly",
    "flyctl",
    "firebase",
    "wrangler",
    "serverless",
    "stripe",
    "op",
    "pass",
    "vault",
    "security",
    "systemctl",
    "launchctl",
    "defaults",
    "diskutil",
    "dscl",
    "xcrun",
    "shortcuts",
    "dotnet",
    "swift",
    "mvn",
    "gradle",
    "rclone",
    "twine",
    "flutter",
    "dart",
    "composer",
    "conda",
    "mamba",
    "nix",
    "jj",
    "hg",
    "svn",
    "glab",
    "tea",
    "kubectx",
    "minikube",
    "colima",
    "lima",
    "multipass",
    "ollama",
    "supabase",
    "railway",
    "render",
    "pulumi",
    "hyprctl",
    "omarchy",
    "journalctl",
    "nmcli",
    "tmux",
    "zellij",
];

/// Of those, the ones whose second word is a subcommand too (`gh pr create`, `aws s3 cp`).
const TWO_LEVELS: &[&str] = &[
    "gh",
    "aws",
    "gcloud",
    "az",
    "kubectl",
    "docker",
    "podman",
    "stripe",
    "op",
    "glab",
    "doctl",
    "heroku",
    "firebase",
    "supabase",
    "jj",
    "rustup",
    "terraform",
    "pulumi",
    "dotnet",
    "flutter",
    "dart",
    "vault",
    "minikube",
    "colima",
    "multipass",
];

/// Subcommands whose next word says what they do (`git remote add`, `git stash drop`, `git bisect
/// run`, `brew services start`, `npm config set`): that word is a key part too. Other programs'
/// second words are data (a branch, a file, a package), so they aren't keys.
const NESTED: &[(&str, &str)] = &[
    ("git", "remote"),
    ("git", "stash"),
    ("git", "worktree"),
    ("git", "submodule"),
    ("git", "bisect"),
    ("git", "notes"),
    ("git", "lfs"),
    ("git", "config"),
    ("git", "credential"),
    ("git", "reflog"),
    ("hg", "bookmark"),
    ("brew", "services"),
    ("brew", "tap"),
    ("npm", "config"),
    ("npm", "token"),
    ("npm", "access"),
    ("npm", "owner"),
    ("npm", "dist-tag"),
    ("npm", "pkg"),
    ("pnpm", "config"),
    ("yarn", "config"),
    ("yarn", "npm"),
    ("bun", "pm"),
    ("uv", "tool"),
    ("uv", "pip"),
    ("uv", "self"),
    ("poetry", "config"),
    ("poetry", "self"),
    ("cargo", "owner"),
    ("go", "mod"),
    ("go", "env"),
    ("helm", "repo"),
    ("helm", "plugin"),
    ("conda", "env"),
    ("conda", "config"),
    ("nix", "profile"),
    ("hyprctl", "keyword"),
    ("hyprctl", "dispatch"),
    ("omarchy", "theme"),
];

/// Programs that decode text.
const DECODERS: &[&str] = &[
    "base64", "xxd", "openssl", "uudecode", "rev", "printf", "gunzip", "zcat",
];

/// The features of `command`, run from `workspace`, and what reading it found.
pub(crate) fn features(command: &str, workspace: Option<&str>, bag: &mut Bag) -> Found {
    bag.add("KIND", &["shell"]);
    let folded = text::fold(command, LONGEST);
    for (flag, name) in [
        (folded.lookalike, "lookalike"),
        (folded.invisible, "invisible"),
        (folded.odd_space, "odd_space"),
        (folded.non_ascii, "non_ascii"),
        (folded.cut, "cut"),
    ] {
        if flag {
            bag.add("M", &[name]);
        }
    }
    // A function defined in the command (`f() { …; }`) runs under a name of its choosing.
    let squeezed: String = folded.text.split_whitespace().collect();
    let mut found = Found {
        hides: folded.lookalike || folded.invisible || folded.odd_space || squeezed.contains("(){"),
        // The text was longer than Spade reads: the rest, including any outside path, is unseen.
        dropped: folded.cut,
        ..Found::default()
    };
    let lower = folded.text.to_ascii_lowercase();
    for (marker, name) in [
        ("$(", "dollar_paren"),
        ("`", "backtick"),
        ("<<<", "here_string"),
        ("<<", "here_doc"),
        ("\\x", "hex_escape"),
        ("\\u", "unicode_escape"),
        ("$'", "ansi_quote"),
        ("${", "brace_variable"),
        ("/dev/tcp", "dev_tcp"),
        ("&&", "and"),
        (";", "sequence"),
        ("|", "pipe"),
        (">", "redirect"),
    ] {
        if lower.contains(marker) {
            bag.add("M", &[name]);
            found.hides |= matches!(
                name,
                "dollar_paren" | "backtick" | "hex_escape" | "unicode_escape" | "ansi_quote"
            );
        }
    }
    if runs_with_secrets(&lower) {
        bag.add("M", &["secret_runner"]);
        found.hides = true;
        found.network = true;
    }
    // Every word as written, wrappers included: the parser takes `sudo`, `env` or `nohup` off
    // what it reads, and the model should still see them.
    text::tokens(&lower, MOST_TOKENS, |t| bag.add("T", &[t]));
    // A device that is a network socket (`/dev/tcp/host/port`).
    found.network |= lower.contains("/dev/tcp") || lower.contains("/dev/udp");
    match shell::read(&folded.text) {
        Some(commands) => {
            let count = commands.len();
            bag.add(
                "N",
                &[match count {
                    0 => "0",
                    1 => "1",
                    2 => "2",
                    3 | 4 => "3-4",
                    _ => "5+",
                }],
            );
            // More commands than Spade examines: what is past the window is unseen.
            found.dropped |= commands.len() > MOST_COMMANDS;
            let mut previous: Option<String> = None;
            for simple in commands.iter().take(MOST_COMMANDS) {
                let program = one(simple, previous.as_deref(), workspace, bag, &mut found);
                previous = Some(program);
            }
        }
        None => {
            bag.add("M", &["unreadable"]);
            found.hides = true;
            // Read it as words, for what it can still say.
            for (i, word) in folded.text.split_whitespace().take(MOST_WORDS).enumerate() {
                let word = word.trim_matches(['"', '\'']);
                if i == 0 {
                    bag.add("P", &[&program_name(word)]);
                }
                if shape::is_path(word) && shape::place(word, workspace).outside() {
                    found.outside = true;
                }
                found.network = true;
                text::tokens(word, 8, |t| bag.add("W", &[t]));
            }
        }
    }
    bag.grams("G", &text::squeezed(&lower, GRAMS));
    if found.outside {
        bag.add("M", &["reaches_outside"]);
    }
    if found.hides {
        bag.add("M", &["hides"]);
    }
    found
}

/// A program as named: its base name, lower-cased; one run through a variable is `$var`, and a
/// file in the folder is `./file`.
fn program_name(word: &str) -> String {
    let word = word.trim_start_matches('\\');
    if word.contains('$') || word.contains('`') {
        return "$var".to_owned();
    }
    let base = word.rsplit('/').next().unwrap_or(word).to_ascii_lowercase();
    if word.contains('/') && !word.starts_with('/') {
        return format!("./{}", extension(&base).unwrap_or("file"));
    }
    base
}

fn extension(name: &str) -> Option<&str> {
    name.rsplit_once('.').map(|(_, e)| e)
}

fn wordish(word: &str) -> bool {
    (1..=32).contains(&word.len())
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
}

/// One simple command's features; its program's name.
fn one(
    simple: &Simple,
    previous: Option<&str>,
    workspace: Option<&str>,
    bag: &mut Bag,
    found: &mut Found,
) -> String {
    let Some(first) = simple.words.first() else {
        bag.add("P", &["(none)"]);
        return "(none)".to_owned();
    };
    let program = program_name(first);
    let p = program.as_str();
    bag.key("P", &[p]);
    if NETWORK.contains(&p) || p == "$var" {
        found.network = true;
    }
    if let Some((_, options)) = RUNS_ANOTHER.iter().find(|(name, _)| *name == p) {
        let runs = simple.words[1..].iter().any(|w| {
            options.iter().any(|o| {
                w == o
                    || w.starts_with(&format!("{o}="))
                    || (o.len() == 2
                        && w.starts_with(o)
                        && !o.starts_with("--")
                        && !w.starts_with("--"))
            })
        });
        // `entr` runs whatever it is given.
        found.hides |= runs || options.is_empty();
    }
    // Names that run other text: what runs isn't the word the command shows.
    if matches!(
        p,
        "eval" | "$var" | "source" | "." | "alias" | "function" | "exec"
    ) {
        found.hides = true;
    }
    if let Some(previous) = previous {
        bag.add("SEQ", &[previous, p]);
        if simple.piped {
            bag.add("PIPE", &[previous, p]);
            if SHELLS.contains(&p) {
                bag.add("M", &["pipe_into_interpreter"]);
                // Text from another program run as code: what runs isn't in the command.
                found.hides = true;
            }
            if DECODERS.contains(&previous) {
                found.hides = true;
            }
        }
    }
    if simple.piped {
        bag.add("PIPED", &[p]);
    }
    if simple.group > 0 {
        bag.add("M", &["subshell"]);
    }
    if simple.dir.is_some() {
        bag.add("M", &["moved_folder"]);
    }
    // More words than Spade examines for outside paths and unknown flags: part is unseen.
    found.dropped |= simple.words.len() > MOST_WORDS;
    let rest = &simple.words[1..simple.words.len().min(MOST_WORDS)];
    let mut positional = rest.iter().filter(|w| !w.starts_with('-'));
    if let Some(sub) = positional.next().filter(|w| wordish(w)) {
        let sub = sub.to_ascii_lowercase();
        if p == "git" && GIT_NETWORK.contains(&sub.as_str()) {
            found.network = true;
        }
        if SUBCOMMANDS.contains(&p) {
            bag.key("PS", &[p, &sub]);
        } else {
            bag.add("PS", &[p, &sub]);
        }
        // The subcommand alone, and with the shape of the last argument (`cp` to a URL is an
        // upload, whatever program runs it).
        bag.add("SUB", &[&sub]);
        if let Some(last) = rest.iter().rev().find(|w| !w.starts_with('-')) {
            let mut scratch = Bag::default();
            bag.add(
                "SUBLAST",
                &[&sub, shape::of(last, workspace, "X", &mut scratch)],
            );
        }
        if let Some(next) = positional.next().filter(|w| wordish(w)) {
            let next = next.to_ascii_lowercase();
            if TWO_LEVELS.contains(&p) || NESTED.contains(&(p, sub.as_str())) {
                bag.key("PSS", &[p, &sub, &next]);
            } else {
                bag.add("PSS", &[p, &sub, &next]);
            }
        }
    }
    let mut tokens = 0;
    for word in rest {
        if let Some(long) = word.strip_prefix("--") {
            let (name, value) = long.split_once('=').unwrap_or((long, ""));
            bag.key("PF", &[p, &format!("--{name}")]);
            bag.add("F", &[&format!("--{name}")]);
            if !value.is_empty() {
                argument(value, p, workspace, bag, found);
            }
        } else if word.len() > 1 && word.starts_with('-') && word.parse::<f64>().is_err() {
            let cluster: String = word.chars().take(12).collect();
            bag.add("PF", &[p, &cluster]);
            // Every option character is a key, so an unknown flag anywhere in a cluster is
            // caught by the known-parts check, not only the first few. A digit after an option
            // letter starts that option's value (`-A5`, `-j8`, `-n20`), as getopt reads it.
            let mut letters = false;
            for c in word.chars().skip(1) {
                if letters && c.is_ascii_digit() {
                    break;
                }
                letters |= c.is_ascii_alphabetic();
                bag.key("PF", &[p, &format!("-{c}")]);
            }
        } else {
            argument(word, p, workspace, bag, found);
        }
        let room = MOST_TOKENS.saturating_sub(tokens);
        text::tokens(word, room, |t| {
            tokens += 1;
            bag.add("W", &[t]);
            bag.add("PW", &[p, t]);
        });
    }
    for target in &simple.writes_to {
        let at = shape::place(target, workspace);
        found.outside |= at.outside();
        bag.add("R>", &[at.name()]);
        bag.add("PR>", &[p, at.name()]);
    }
    for source in &simple.reads_from {
        let at = shape::place(source, workspace);
        found.outside |= at.outside();
        bag.add("R<", &[at.name()]);
        shape::of(source, workspace, "A", bag);
    }
    if let Some(here) = &simple.here {
        bag.add("HERE", &[p]);
        if SHELLS.contains(&p) && p != "osascript" {
            found.hides = true;
        }
        text::tokens(here, MOST_TOKENS, |t| {
            bag.add("W", &[t]);
            bag.add("PW", &[p, t]);
        });
    }
    program
}

/// An argument's shape, under its program too.
fn argument(word: &str, program: &str, workspace: Option<&str>, bag: &mut Bag, found: &mut Found) {
    let shape = shape::of(word, workspace, "PA", bag);
    if shape.starts_with("path_") {
        found.outside |= shape::place(word, workspace).outside();
    }
    found.outside |= shape::elsewhere(word, shape);
    // A place on the network, or something that may name one (`host:port`, an address).
    found.network |= matches!(shape, "url" | "remote" | "email") || shape::names_host(word);
    bag.add("A", &[shape]);
    bag.add("PA", &[program, shape]);
    if let Some((key, _)) = word.split_once('=')
        && wordish(key)
    {
        bag.add("KV", &[&key.to_ascii_lowercase()]);
    }
}
