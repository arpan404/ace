//! What a shell command reaches, decided without a model (ADR 0144): the commands a reviewer must
//! never approve on the person's behalf (sending over the network, mail, publishing, changing
//! servers, writing or deleting outside the bot's folder, driving other apps, admin rights,
//! payments) and anything it can't read for sure. Every simple command is looked at: across
//! pipes, `;`, `&&`, `||`, `$(...)`, `sh -c` strings and wrappers such as `env`, `xargs` or
//! `timeout`. Like any denylist it can't be complete; the reviewer and the person stand behind it.

use super::Sensitive;
use super::secrets::{basename, command_reads};

/// What a command needs, beyond the reviewer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Finding {
    /// It reads sign-ins or credentials: never run.
    Credentials,
    /// The person decides.
    Sensitive(Sensitive),
}

/// One simple command: its words (wrappers taken off) and where its output is written.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Simple {
    words: Vec<String>,
    writes_to: Vec<String>,
    /// Files its input comes from (`< file`).
    reads_from: Vec<String>,
    /// Its input is the previous command's output.
    piped: bool,
}

/// What `command` needs; `None` when nothing here stands out (the reviewer still judges it).
pub fn assess(command: &str) -> Option<Finding> {
    let Ok(commands) = parse(command, 0) else {
        return Some(Finding::Sensitive(Sensitive::Unclear));
    };
    if commands.iter().any(|c| command_reads(&with_targets(c))) {
        return Some(Finding::Credentials);
    }
    commands.iter().find_map(classify).map(Finding::Sensitive)
}

/// Every simple command in `text`, as words (wrappers taken off, output targets after them);
/// `None` when it can't be read.
pub fn simple_commands(text: &str) -> Option<Vec<Vec<String>>> {
    parse(text, 0)
        .ok()
        .map(|commands| commands.iter().map(with_targets).collect())
}

fn with_targets(simple: &Simple) -> Vec<String> {
    simple
        .words
        .iter()
        .chain(&simple.writes_to)
        .chain(&simple.reads_from)
        .cloned()
        .collect()
}

/// Deepest nesting of `sh -c` and `$(...)` read before giving up.
const DEEPEST: usize = 4;

struct Unreadable;

fn parse(text: &str, depth: usize) -> Result<Vec<Simple>, Unreadable> {
    if depth > DEEPEST {
        return Err(Unreadable);
    }
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<Simple> = Vec::new();
    let mut nested: Vec<Simple> = Vec::new();
    let mut current = Simple::default();
    let mut word = String::new();
    let mut in_word = false;
    let mut target = false;
    let mut input = false;
    let mut i = 0;
    let end_word = |word: &mut String,
                    in_word: &mut bool,
                    target: &mut bool,
                    input: &mut bool,
                    current: &mut Simple| {
        if !*in_word {
            return;
        }
        let taken = std::mem::take(word);
        if *target {
            current.writes_to.push(taken);
            *target = false;
        } else if *input {
            current.reads_from.push(taken);
            *input = false;
        } else {
            current.words.push(taken);
        }
        *in_word = false;
    };
    while i < chars.len() {
        let c = chars[i];
        match c {
            ' ' | '\t' => end_word(
                &mut word,
                &mut in_word,
                &mut target,
                &mut input,
                &mut current,
            ),
            '\n' | ';' | '&' | '|' | '(' | ')' => {
                if c == '&' && chars.get(i + 1) == Some(&'>') {
                    // `&>file`: both streams to a file.
                    end_word(
                        &mut word,
                        &mut in_word,
                        &mut target,
                        &mut input,
                        &mut current,
                    );
                    i += 1;
                    if chars.get(i + 1) == Some(&'>') {
                        i += 1;
                    }
                    target = true;
                    i += 1;
                    continue;
                }
                end_word(
                    &mut word,
                    &mut in_word,
                    &mut target,
                    &mut input,
                    &mut current,
                );
                if target {
                    return Err(Unreadable);
                }
                let piped = c == '|' && chars.get(i + 1) != Some(&'|');
                if matches!(c, '&' | '|') && chars.get(i + 1) == Some(&c) {
                    i += 1;
                }
                out.push(std::mem::take(&mut current));
                current.piped = piped;
            }
            '\'' => {
                in_word = true;
                i += 1;
                loop {
                    match chars.get(i) {
                        None => return Err(Unreadable),
                        Some('\'') => break,
                        Some(&ch) => word.push(ch),
                    }
                    i += 1;
                }
            }
            '"' => {
                in_word = true;
                i += 1;
                loop {
                    match chars.get(i) {
                        None | Some('`') => return Err(Unreadable),
                        Some('"') => break,
                        Some('\\') => {
                            i += 1;
                            word.push(*chars.get(i).ok_or(Unreadable)?);
                        }
                        Some('$') if chars.get(i + 1) == Some(&'(') => {
                            let (inner, next) = substitution(&chars, i)?;
                            nested.extend(parse(&inner, depth + 1)?);
                            word.push_str("$SUB");
                            i = next;
                            continue;
                        }
                        Some(&ch) => word.push(ch),
                    }
                    i += 1;
                }
            }
            '`' => return Err(Unreadable),
            '\\' => {
                in_word = true;
                i += 1;
                if let Some(&ch) = chars.get(i)
                    && ch != '\n'
                {
                    word.push(ch);
                }
            }
            '$' if chars.get(i + 1) == Some(&'(') => {
                let (inner, next) = substitution(&chars, i)?;
                nested.extend(parse(&inner, depth + 1)?);
                in_word = true;
                word.push_str("$SUB");
                i = next;
                continue;
            }
            '<' => {
                // A here-document or here-string carries text Spade doesn't read as a command.
                if matches!(chars.get(i + 1), Some('<') | Some('(')) {
                    return Err(Unreadable);
                }
                end_word(
                    &mut word,
                    &mut in_word,
                    &mut target,
                    &mut input,
                    &mut current,
                );
                input = true;
            }
            '>' => {
                // `2>file`, `1>>file`: the number is the stream, not a word.
                if in_word && word.chars().all(|d| d.is_ascii_digit()) {
                    word.clear();
                    in_word = false;
                }
                end_word(
                    &mut word,
                    &mut in_word,
                    &mut target,
                    &mut input,
                    &mut current,
                );
                if chars.get(i + 1) == Some(&'(') {
                    return Err(Unreadable);
                }
                if chars.get(i + 1) == Some(&'>') || chars.get(i + 1) == Some(&'|') {
                    i += 1;
                }
                if chars.get(i + 1) == Some(&'&') {
                    // `>&2`: to another stream.
                    i += 2;
                    while chars
                        .get(i)
                        .is_some_and(|d| d.is_ascii_digit() || *d == '-')
                    {
                        i += 1;
                    }
                    continue;
                }
                target = true;
            }
            '#' if !in_word => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            _ => {
                in_word = true;
                word.push(c);
            }
        }
        i += 1;
    }
    end_word(
        &mut word,
        &mut in_word,
        &mut target,
        &mut input,
        &mut current,
    );
    if target {
        return Err(Unreadable);
    }
    out.push(current);
    let mut simple: Vec<Simple> = Vec::new();
    for command in out
        .into_iter()
        .filter(|c| !c.words.is_empty() || !c.writes_to.is_empty())
    {
        simple.extend(unwrap(command, depth)?);
    }
    simple.extend(nested);
    Ok(simple)
}

/// The text inside `$(...)` starting at `start` (the `$`), and the index after its `)`.
fn substitution(chars: &[char], start: usize) -> Result<(String, usize), Unreadable> {
    if chars.get(start + 2) == Some(&'(') {
        // `$((...))` is arithmetic; nothing runs, but it isn't worth reading.
        return Err(Unreadable);
    }
    let mut depth = 0;
    let mut quote: Option<char> = None;
    let mut i = start + 1;
    while i < chars.len() {
        let c = chars[i];
        match (quote, c) {
            (Some(q), _) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '\'' | '"') => quote = Some(c),
            (None, '(') => depth += 1,
            (None, ')') => {
                depth -= 1;
                if depth == 0 {
                    let inner: String = chars[start + 2..i].iter().collect();
                    return Ok((inner, i + 1));
                }
            }
            _ => {}
        }
        i += 1;
    }
    Err(Unreadable)
}

/// Programs that run the command after them, with the flags that take a value.
const WRAPPERS: &[(&str, &[&str])] = &[
    ("env", &["-u", "-C", "-S"]),
    ("command", &[]),
    ("builtin", &[]),
    ("exec", &["-a"]),
    ("nohup", &[]),
    ("time", &[]),
    ("nice", &["-n"]),
    ("ionice", &["-c", "-n"]),
    ("stdbuf", &["-i", "-o", "-e"]),
    ("timeout", &["-s", "-k", "--signal", "--kill-after"]),
    ("caffeinate", &["-t", "-w"]),
    ("xargs", &["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a"]),
    ("watch", &["-n", "-d"]),
];

const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"];
const INTERPRETERS: &[&str] = &[
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "fish",
    "ash",
    "python",
    "python3",
    "node",
    "deno",
    "bun",
    "perl",
    "ruby",
    "php",
    "lua",
    "osascript",
];

/// Takes off variable assignments and wrappers, and reads `sh -c` strings.
fn unwrap(mut simple: Simple, depth: usize) -> Result<Vec<Simple>, Unreadable> {
    loop {
        let Some(first) = simple.words.first().cloned() else {
            return Ok(vec![simple]);
        };
        if is_assignment(&first) {
            simple.words.remove(0);
            continue;
        }
        let program = basename(&first).to_owned();
        if program.starts_with('$') || matches!(program.as_str(), "eval" | "source" | ".") {
            return Err(Unreadable);
        }
        if let Some((_, valued)) = WRAPPERS.iter().find(|(name, _)| *name == program) {
            simple.words.remove(0);
            let mut skip_value = false;
            while let Some(word) = simple.words.first() {
                if skip_value {
                    skip_value = false;
                    simple.words.remove(0);
                    continue;
                }
                if word.starts_with('-') || is_assignment(word) {
                    skip_value = valued.contains(&word.as_str());
                    simple.words.remove(0);
                    continue;
                }
                // `timeout 10 cmd`, `nice 5`? The first plain number is the wrapper's.
                if (program == "timeout" || program == "watch")
                    && word.chars().next().is_some_and(|c| c.is_ascii_digit())
                {
                    simple.words.remove(0);
                }
                break;
            }
            continue;
        }
        if SHELLS.contains(&program.as_str()) {
            let script = simple
                .words
                .iter()
                .position(|w| w.starts_with('-') && !w.starts_with("--") && w.contains('c'))
                .and_then(|at| simple.words.get(at + 1).cloned());
            if let Some(script) = script {
                let mut inner = parse(&script, depth + 1)?;
                if let Some(first) = inner.first_mut() {
                    first.piped |= simple.piped;
                }
                return Ok(inner);
            }
        }
        // A shell or interpreter reading its program from a pipe runs text Spade never sees.
        if simple.piped
            && INTERPRETERS.contains(&program.as_str())
            && simple.words[1..].iter().all(|w| w.starts_with('-'))
        {
            return Err(Unreadable);
        }
        return Ok(vec![simple]);
    }
}

fn is_assignment(word: &str) -> bool {
    let Some((name, _)) = word.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !name.starts_with(|c: char| c.is_ascii_digit())
}

/// Whether a path written to leaves the bot's folder: absolute, from the home folder, through a
/// variable Spade can't read, or climbing above where it starts.
fn outside(path: &str) -> bool {
    let path = path.trim();
    if matches!(path, "/dev/null" | "/dev/stdout" | "/dev/stderr" | "-") {
        return false;
    }
    if path.starts_with('/') || path.starts_with('~') || path.contains('$') {
        return true;
    }
    // A Windows drive or share.
    if path.contains(":\\") || path.contains(":/") || path.starts_with("\\\\") {
        return true;
    }
    let mut depth: i32 = 0;
    for part in path.split(['/', '\\']) {
        match part {
            ".." => {
                depth -= 1;
                if depth < 0 {
                    return true;
                }
            }
            "" | "." => {}
            _ => depth += 1,
        }
    }
    false
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

const METHODS: &[&str] = &["POST", "PUT", "PATCH", "DELETE"];

fn classify(simple: &Simple) -> Option<Sensitive> {
    if simple.writes_to.iter().any(|t| outside(t)) {
        return Some(Sensitive::WriteOutside);
    }
    let words = &simple.words;
    let program = basename(words.first()?);
    let lower: Vec<String> = words.iter().map(|w| w.to_lowercase()).collect();
    let has = |flags: &[&str]| {
        words.iter().any(|w| {
            flags
                .iter()
                .any(|f| w == f || (f.starts_with("--") && w.starts_with(&format!("{f}="))))
        })
    };
    match program {
        "sudo" | "doas" | "su" | "pkexec" | "runas" | "launchctl" | "systemctl" | "crontab"
        | "reboot" | "shutdown" | "halt" | "diskutil" | "mount" | "umount" | "chflags" => {
            Some(Sensitive::Admin)
        }
        "osascript" | "automator" | "shortcuts" | "xdotool" | "ydotool" | "cliclick" | "open"
        | "xdg-open" | "start" => Some(Sensitive::Automation),
        "stripe" | "paypal" => Some(Sensitive::Payment),
        "mail" | "mailx" | "sendmail" | "mutt" | "neomutt" | "msmtp" | "swaks" => {
            Some(Sensitive::MessageAsPerson)
        }
        "nc" | "ncat" | "netcat" | "socat" | "telnet" | "ftp" | "lftp" | "sftp" | "tftp"
        | "ssh" | "mosh" => Some(Sensitive::Network),
        "curl" => {
            let sends = has(&[
                "-d",
                "--data",
                "--data-raw",
                "--data-binary",
                "--data-urlencode",
                "--data-ascii",
                "-F",
                "--form",
                "--form-string",
                "-T",
                "--upload-file",
                "--json",
            ]) || words.iter().any(|w| w.starts_with("-d") && w.len() > 2)
                || method_flag(words, &["-X", "--request"]);
            sends.then_some(Sensitive::Network)
        }
        "wget" => (has(&["--post-data", "--post-file", "--body-data", "--body-file"])
            || method_flag(words, &["--method"]))
        .then_some(Sensitive::Network),
        "http" | "https" | "xh" | "xhs" | "httpie" => {
            let method = operands(words)
                .first()
                .is_some_and(|w| METHODS.contains(&w.to_uppercase().as_str()));
            let data = operands(words).iter().any(|w| {
                !w.contains("://") && !w.contains("==") && (w.contains('=') || w.contains(":@"))
            });
            (method || data || has(&["--form", "-f"])).then_some(Sensitive::Network)
        }
        "scp" => {
            if operands(words).iter().any(|w| remote(w)) {
                Some(Sensitive::Network)
            } else {
                last_outside(words)
            }
        }
        "rsync" => {
            if operands(words).iter().any(|w| remote(w)) {
                Some(Sensitive::Network)
            } else {
                last_outside(words)
            }
        }
        "git" => {
            let (_, sub) = subcommand(words, &["-C", "-c", "--git-dir", "--work-tree"])?;
            match sub {
                "push" => Some(Sensitive::Publish),
                "send-email" | "imap-send" => Some(Sensitive::MessageAsPerson),
                _ => None,
            }
        }
        "gh" => gh(words),
        "npm" | "pnpm" | "yarn" | "bun" => matches!(
            subcommand(words, &[])?.1,
            "publish" | "unpublish" | "deprecate" | "owner" | "dist-tag" | "access"
        )
        .then_some(Sensitive::Publish),
        "cargo" => matches!(subcommand(words, &[])?.1, "publish" | "yank" | "owner")
            .then_some(Sensitive::Publish),
        "twine" | "flit" | "hatch" | "poetry" | "uv" | "gem" => matches!(
            subcommand(words, &[])?.1,
            "upload" | "publish" | "push" | "yank" | "owner"
        )
        .then_some(Sensitive::Publish),
        "docker" | "podman" | "buildah" => {
            (subcommand(words, &[])?.1 == "push" || has(&["--push"])).then_some(Sensitive::Publish)
        }
        "vercel" | "netlify" | "fly" | "flyctl" | "firebase" | "heroku" => (lower
            .iter()
            .any(|w| matches!(w.as_str(), "deploy" | "--prod" | "release")))
        .then_some(Sensitive::Publish),
        "kubectl" | "oc" => matches!(
            subcommand(words, &["-n", "--namespace", "--context"])?.1,
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
        .then_some(Sensitive::RemoteChange),
        "helm" => matches!(
            subcommand(words, &[])?.1,
            "install" | "upgrade" | "uninstall" | "delete" | "rollback"
        )
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
            .any(|p| outside(p))
            .then_some(Sensitive::DeleteOutside),
        "mv" => operands(words)
            .iter()
            .any(|p| outside(p))
            .then_some(Sensitive::WriteOutside),
        "tee" | "touch" | "mkdir" | "truncate" | "chmod" | "chown" | "chgrp" | "setfacl"
        | "xattr" => operands(words)
            .iter()
            .any(|p| outside(p))
            .then_some(Sensitive::WriteOutside),
        "cp" | "ln" | "install" | "ditto" => last_outside(words),
        "dd" => words
            .iter()
            .filter_map(|w| w.strip_prefix("of="))
            .any(outside)
            .then_some(Sensitive::WriteOutside),
        "find" => find(words),
        _ => None,
    }
}

fn method_flag(words: &[String], flags: &[&str]) -> bool {
    words.iter().enumerate().any(|(at, w)| {
        let value = flags.iter().find_map(|f| {
            if w == f {
                words.get(at + 1).map(String::as_str)
            } else if let Some(rest) = w.strip_prefix(&format!("{f}=")) {
                Some(rest)
            } else if f.len() == 2 && w.starts_with(f) && w.len() > 2 {
                Some(&w[2..])
            } else {
                None
            }
        });
        value.is_some_and(|v| METHODS.contains(&v.to_uppercase().as_str()))
    })
}

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
fn last_outside(words: &[String]) -> Option<Sensitive> {
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
        .any(outside)
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
            Some(a),
        ) if matches!(
            a,
            "create"
                | "merge"
                | "edit"
                | "close"
                | "reopen"
                | "comment"
                | "review"
                | "upload"
                | "delete"
                | "lock"
                | "transfer"
                | "ready"
                | "set"
        ) =>
        {
            Some(Sensitive::Publish)
        }
        ("api", _) => {
            let writes = method_flag(words, &["-X", "--method"])
                || words.iter().any(|w| {
                    matches!(
                        w.as_str(),
                        "-f" | "-F" | "--field" | "--raw-field" | "--input"
                    )
                });
            writes.then_some(Sensitive::Publish)
        }
        ("workflow" | "run", Some("run" | "rerun" | "cancel" | "enable" | "disable")) => {
            Some(Sensitive::RemoteChange)
        }
        _ => None,
    }
}

fn find(words: &[String]) -> Option<Sensitive> {
    let acts = words.iter().any(|w| {
        matches!(
            w.as_str(),
            "-delete" | "-exec" | "-execdir" | "-ok" | "-okdir"
        )
    });
    if !acts {
        return None;
    }
    let starts = words
        .iter()
        .skip(1)
        .take_while(|w| !w.starts_with('-') && *w != "(" && *w != "!");
    if starts.clone().any(|p| outside(p)) {
        return Some(Sensitive::DeleteOutside);
    }
    // What `-exec` runs is a command of its own.
    let at = words
        .iter()
        .position(|w| matches!(w.as_str(), "-exec" | "-execdir" | "-ok" | "-okdir"))?;
    let inner: Vec<String> = words[at + 1..]
        .iter()
        .take_while(|w| !matches!(w.as_str(), ";" | "+" | "\\;"))
        .cloned()
        .collect();
    classify(&Simple {
        words: inner,
        ..Simple::default()
    })
}

#[cfg(test)]
mod tests;
