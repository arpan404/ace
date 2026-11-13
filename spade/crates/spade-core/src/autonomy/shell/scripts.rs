//! Code a command runs that its words don't show: inline code (`python -c`, `node -e`, `awk`
//! programs) and the files and task lists it runs (a script, a make target, a package script).
//! Inline code is already in the call, so the reviewer reads it; markers of network use or of
//! starting other programs in it go to the person. Files are read so the reviewer sees what
//! would run; one Spade can't show goes to the person.

use std::path::Path;

use super::super::Sensitive;
use super::effects::{Effect, Run};
use super::paths::{Place, Unseen, moved};
use super::{Shown, Walk};

/// The most of one file the reviewer is shown; a longer one goes to the person.
pub const LONGEST_SCRIPT: usize = 24_000;

/// How deep scripts that run scripts are followed.
const DEEPEST: usize = 3;

/// Words in inline code that reach the network.
const NETWORK: &[&str] = &[
    "http",
    "socket",
    "urllib",
    "requests",
    "fetch",
    "net.",
    "net::",
    "lwp",
    "open-uri",
    "smtp",
    "ftp",
    "paramiko",
    "curl",
    "wget",
    "websocket",
    "dns",
    "telnet",
    "xmlhttprequest",
];
/// Words in inline code that start other programs or build code to run.
const PROGRAMS: &[&str] = &[
    "subprocess",
    "child_process",
    "os.system",
    "os.popen",
    "os.exec",
    "spawn",
    "execsync",
    "execfile",
    "system(",
    "exec(",
    "eval(",
    "popen",
    "pty.spawn",
    "shell_exec",
    "passthru",
    "proc_open",
    "%x{",
    "%x(",
    "io.popen",
    "os.execute",
    "do shell script",
    "__import__",
    "importlib",
    "b64decode",
    "atob",
    "base64",
    "require(\"child",
    "deno.command",
    "bun.spawn",
    "| getline",
    "print |",
    "printf |",
];

/// What inline code needs: network use and running other programs go to the person; the rest
/// the reviewer reads in the call.
fn markers(code: &str) -> Option<Sensitive> {
    let code = code.to_lowercase();
    if NETWORK.iter().any(|m| code.contains(m)) {
        return Some(Sensitive::Network);
    }
    if PROGRAMS.iter().any(|m| code.contains(m)) {
        return Some(Sensitive::Unclear);
    }
    None
}

/// Flags that give an interpreter its code inline, and those that take a file or a value.
fn inline_flags(program: &str) -> (&'static [&'static str], &'static [&'static str]) {
    match program {
        "python" | "python3" => (&["-c"], &["-W", "-X", "-Q"]),
        "node" => (
            &["-e", "-p", "--eval", "--print"],
            &["--import", "--loader", "--input-type", "-C", "--conditions"],
        ),
        "deno" => (&[], &[]),
        "bun" => (&["-e", "-p", "--eval", "--print"], &[]),
        "perl" => (&["-e", "-E"], &["-I", "-M", "-m", "-x"]),
        "ruby" => (&["-e"], &["-I", "-r", "-C", "-E"]),
        "php" => (&["-r"], &["-d", "-c"]),
        "lua" => (&["-e"], &["-l"]),
        "osascript" => (&["-e"], &["-l"]),
        _ => (&[], &[]),
    }
}

const INTERPRETERS: &[&str] = &[
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

/// Whether `program` runs code it is given (a file, or its input).
pub(super) fn is_interpreter(program: &str) -> bool {
    let program = program
        .strip_suffix(|c: char| c.is_ascii_digit() || c == '.')
        .unwrap_or(program);
    INTERPRETERS.contains(&program) || matches!(program, "awk" | "gawk" | "mawk" | "nawk")
}

/// An interpreter's inline code, the file it runs, or a preloaded file (`node -r`).
pub(super) fn interpreter(program: &str, words: &[String]) -> Effect {
    if matches!(program, "awk" | "gawk" | "mawk" | "nawk") {
        return awk(words);
    }
    let program = program
        .strip_suffix(|c: char| c.is_ascii_digit() || c == '.')
        .filter(|p| INTERPRETERS.contains(p))
        .unwrap_or(program);
    if !INTERPRETERS.contains(&program) {
        return Effect::default();
    }
    let (inline, valued) = inline_flags(program);
    let mut runs = Vec::new();
    let mut sensitive = None;
    let mut code: Vec<String> = Vec::new();
    let mut at = 1;
    // `deno eval code`, `deno run file`.
    if program == "deno" {
        match words.get(1).map(String::as_str) {
            Some("eval") => code.extend(words.get(2).cloned()),
            Some("run") => {
                if let Some(file) = words[2..].iter().find(|w| !w.starts_with('-')) {
                    runs.push(Run::File(file.clone()));
                }
            }
            _ => {}
        }
        at = words.len();
    }
    while at < words.len() {
        let word = &words[at];
        at += 1;
        if word == "--" {
            break;
        }
        if inline.contains(&word.as_str()) {
            code.extend(words.get(at).cloned());
            // Inline code: what follows are its arguments.
            break;
        }
        // Run together: `-ne 'code'`, `-cprint(1)`, `--eval=code`.
        if let Some(flag) = inline.iter().find(|f| {
            (f.len() == 2 && word.starts_with(**f) && word.len() > 2)
                || (f.starts_with("--") && word.starts_with(&format!("{f}=")))
        }) {
            let rest = word[flag.len()..].trim_start_matches('=');
            code.push(rest.to_owned());
            break;
        }
        if program == "perl"
            && word.starts_with('-')
            && !word.starts_with("--")
            && word.ends_with('e')
        {
            code.extend(words.get(at).cloned());
            break;
        }
        if program == "python" || program == "python3" {
            if word == "-m" {
                // A module: its name may say what it does (`http.server`).
                code.extend(words.get(at).cloned());
                break;
            }
            if let Some(module) = word.strip_prefix("-m").filter(|m| !m.is_empty()) {
                code.push(module.to_owned());
                break;
            }
        }
        if program == "node" && matches!(word.as_str(), "-r" | "--require") {
            runs.extend(words.get(at).cloned().map(Run::File));
            at += 1;
            continue;
        }
        if valued.contains(&word.as_str()) {
            at += 1;
            continue;
        }
        if word.starts_with('-') {
            continue;
        }
        if program == "bun" {
            break;
        }
        // The script, then its arguments.
        runs.push(Run::File(word.clone()));
        break;
    }
    for text in &code {
        sensitive = sensitive.or_else(|| markers(text));
        // Backticks run a command in Perl, Ruby and PHP.
        if matches!(program, "perl" | "ruby" | "php") && text.contains('`') {
            sensitive = sensitive.or(Some(Sensitive::Unclear));
        }
    }
    Effect {
        sensitive,
        runs,
        ..Effect::default()
    }
}

/// An awk program: `-f file` runs a file; inline, `system()` and pipes start other programs.
fn awk(words: &[String]) -> Effect {
    let mut at = 1;
    while at < words.len() {
        let word = &words[at];
        at += 1;
        match word.as_str() {
            "-f" | "--file" => {
                return Effect {
                    runs: words.get(at).cloned().map(Run::File).into_iter().collect(),
                    ..Effect::default()
                };
            }
            "-v" | "-F" | "--assign" | "--field-separator" => at += 1,
            _ if word.starts_with('-') => {}
            program => {
                let starts = [
                    "system(",
                    "| getline",
                    "|getline",
                    "print |",
                    "print|",
                    "printf |",
                ];
                let lower = program.to_lowercase();
                let runs_programs =
                    starts.iter().any(|m| lower.contains(m)) || lower.contains("\" |");
                return Effect {
                    sensitive: runs_programs
                        .then_some(Sensitive::Unclear)
                        .or_else(|| markers(program).filter(|k| *k == Sensitive::Network)),
                    ..Effect::default()
                };
            }
        }
    }
    Effect::default()
}

/// Shows the code `run` runs (adding to the walk's `shown` and `ran`), and records what it
/// needs: a file outside the folder, unreadable or too long goes to the person; a shell script's,
/// a recipe's or a package script's commands are checked like the call's own; a file that names
/// a credential place is refused.
pub(super) fn show(run: &Run, place: &dyn Place, depth: usize, walk: &mut Walk) {
    if depth > DEEPEST {
        walk.kind(Sensitive::UnseenScript);
        return;
    }
    match run {
        Run::File(path) => file(place, path, How::Interpreted, depth, walk),
        Run::Exec(path) => file(place, path, How::Executed, depth, walk),
        Run::Shell(path) => file(place, path, How::Shell, depth, walk),
        Run::Make {
            dir,
            file: named,
            goals,
            vars,
        } => {
            let Some(at) = moved(place, dir) else {
                walk.kind(Sensitive::Unclear);
                return;
            };
            let first = match named {
                Some(name) => name.clone(),
                None => match ["GNUmakefile", "makefile", "Makefile"]
                    .iter()
                    .find(|name| exists(&at, name))
                {
                    Some(name) => (*name).to_owned(),
                    None => {
                        walk.kind(Sensitive::UnseenScript);
                        return;
                    }
                },
            };
            let mut read = |name: &str| {
                fetch(&at, name, walk).inspect(|text| {
                    walk.shown.push(Shown {
                        path: join(dir, name),
                        content: text.clone(),
                    });
                })
            };
            match super::make::recipes(&first, goals, vars, &mut read) {
                Ok(lines) => {
                    for line in lines {
                        super::assess_at(&line, &at, depth + 1, walk);
                    }
                }
                Err(super::make::Unread::Unclear) => walk.kind(Sensitive::Unclear),
                Err(super::make::Unread::Unseen) => walk.kind(Sensitive::UnseenScript),
            }
        }
        Run::Just {
            dir,
            file: named,
            recipes,
        } => {
            let Some(at) = moved(place, dir) else {
                walk.kind(Sensitive::Unclear);
                return;
            };
            let name = named.clone().or_else(|| {
                ["justfile", "Justfile", ".justfile"]
                    .iter()
                    .find(|name| exists(&at, name))
                    .map(|name| (*name).to_owned())
            });
            let Some(name) = name else {
                walk.kind(Sensitive::UnseenScript);
                return;
            };
            let Some(text) = fetch(&at, &name, walk) else {
                return;
            };
            walk.shown.push(Shown {
                path: join(dir, &name),
                content: text.clone(),
            });
            match just(&text, recipes) {
                Some(lines) => {
                    for line in lines {
                        super::assess_at(&line, &at, depth + 1, walk);
                    }
                }
                None => walk.kind(Sensitive::Unclear),
            }
        }
        Run::Package { dir, target } => {
            let Some(at) = moved(place, dir) else {
                walk.kind(Sensitive::Unclear);
                return;
            };
            let Some(text) = fetch(&at, "package.json", walk) else {
                return;
            };
            let Ok(package) = serde_json::from_str::<serde_json::Value>(&text) else {
                walk.kind(Sensitive::UnseenScript);
                return;
            };
            let scripts = &package["scripts"];
            let bodies: Vec<(String, String)> = [
                format!("pre{target}"),
                target.clone(),
                format!("post{target}"),
            ]
            .into_iter()
            .filter_map(|name| scripts[&name].as_str().map(|body| (name, body.to_owned())))
            .collect();
            walk.shown.push(Shown {
                path: format!("{} (scripts)", join(dir, "package.json")),
                content: bodies
                    .iter()
                    .map(|(name, body)| format!("{name}: {body}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
            });
            // A package script runs through `sh -c` from the package's folder.
            for (_, body) in &bodies {
                super::assess_at(body, &at, depth + 1, walk);
            }
        }
        Run::GitHooks { dir } => hooks(place, dir, depth, walk),
    }
}

/// How a file is run.
#[derive(Clone, Copy, PartialEq, Eq)]
enum How {
    /// By a shell: `sh x`, `source x`, `sh < x`.
    Shell,
    /// By the interpreter the command names: `python x.py`.
    Interpreted,
    /// Directly: its `#!` line names the interpreter, and with none the system's shell runs it.
    Executed,
}

/// A script file: shown; a shell script's commands checked like the call's own; any other
/// script that starts programs or builds code goes to the person, since what it runs isn't shown.
fn file(place: &dyn Place, path: &str, how: How, depth: usize, walk: &mut Walk) {
    let Some(text) = fetch(place, path, walk) else {
        return;
    };
    walk.shown.push(Shown {
        path: path.to_owned(),
        content: text.clone(),
    });
    let first = text.lines().next().unwrap_or("");
    let shell_line = first.starts_with("#!") && (first.ends_with("sh") || first.contains("sh "));
    let shelled = match how {
        How::Shell => true,
        How::Interpreted => false,
        How::Executed => shell_line || !first.starts_with("#!"),
    };
    if shelled {
        super::assess_at(&text, place, depth + 1, walk);
    } else if let Some(kind) = markers(&text) {
        walk.kind(match kind {
            Sensitive::Network => Sensitive::Network,
            _ => Sensitive::Unclear,
        });
    }
}

/// The hooks a git command would run: the repository's own, shown and checked like scripts.
/// Hooks set elsewhere (`core.hooksPath`), a repository Spade can't read, or one shared with
/// another worktree are unclear.
fn hooks(place: &dyn Place, dir: &str, depth: usize, walk: &mut Walk) {
    let Some(at) = moved(place, dir) else {
        walk.kind(Sensitive::Unclear);
        return;
    };
    let Some(mut folder) = at.resolve(".") else {
        walk.kind(Sensitive::Unclear);
        return;
    };
    loop {
        match at.list(&folder) {
            Ok(names) if names.iter().any(|n| n == ".git") => break,
            Ok(_) | Err(Unseen::Missing) => {}
            Err(_) => {
                walk.kind(Sensitive::Unclear);
                return;
            }
        }
        // No repository: git refuses before any hook.
        if !folder.pop() {
            return;
        }
    }
    let git = folder.join(".git");
    // `.git` as a file points elsewhere (a worktree, a submodule).
    if at.list(&git).is_err() {
        walk.kind(Sensitive::Unclear);
        return;
    }
    match at.read(&git.join("config"), LONGEST_SCRIPT) {
        Ok(config) => {
            let config = config.to_lowercase();
            if ["hookspath", "fsmonitor", "sshcommand", "[alias"]
                .iter()
                .any(|key| config.contains(key))
            {
                walk.kind(Sensitive::Unclear);
                return;
            }
        }
        Err(Unseen::Missing) => {}
        Err(_) => {
            walk.kind(Sensitive::Unclear);
            return;
        }
    }
    let names = match at.list(&git.join("hooks")) {
        Ok(names) => names,
        Err(Unseen::Missing) => return,
        Err(_) => {
            walk.kind(Sensitive::Unclear);
            return;
        }
    };
    let mut names: Vec<String> = names
        .into_iter()
        .filter(|n| !n.ends_with(".sample") && !n.starts_with('.'))
        .collect();
    names.sort();
    for name in names {
        let path = git.join("hooks").join(&name);
        file(&at, &path.to_string_lossy(), How::Executed, depth, walk);
    }
}

/// The lines `just` would run for `wanted` (none: the first recipe) and their dependencies;
/// `None` for what it doesn't follow (another shell, a recipe in another language).
fn just(text: &str, wanted: &[String]) -> Option<Vec<String>> {
    let mut recipes: Vec<(String, Vec<String>, Vec<String>)> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("set ") && trimmed.contains("shell") {
            return None;
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            if let Some((_, _, body)) = recipes.last_mut() {
                body.push(trimmed.to_owned());
            }
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.contains(":=") {
            continue;
        }
        let Some((head, deps)) = trimmed.split_once(':') else {
            continue;
        };
        let name = head
            .trim_start_matches('@')
            .split_whitespace()
            .next()?
            .to_owned();
        let deps = deps
            .split_whitespace()
            .map(|d| {
                d.trim_start_matches('(')
                    .split(' ')
                    .next()
                    .unwrap_or(d)
                    .to_owned()
            })
            .filter(|d| !d.is_empty() && !d.starts_with('&'))
            .collect();
        recipes.push((name, deps, Vec::new()));
    }
    let mut queue: Vec<String> = if wanted.is_empty() {
        recipes
            .first()
            .map(|(n, _, _)| n.clone())
            .into_iter()
            .collect()
    } else {
        wanted.to_vec()
    };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    while let Some(name) = queue.pop() {
        if !seen.insert(name.clone()) {
            continue;
        }
        let Some((_, deps, body)) = recipes.iter().find(|(n, _, _)| *n == name) else {
            continue;
        };
        if body.first().is_some_and(|l| l.starts_with("#!")) {
            return None;
        }
        out.extend(
            body.iter()
                .map(|l| l.trim_start_matches(['@', '-']).to_owned())
                .filter(|l| !l.is_empty() && !l.starts_with('#')),
        );
        queue.extend(deps.iter().rev().cloned());
    }
    Some(out)
}

/// A file's text, when it is inside the folder and short enough to show: recorded as run, and
/// checked for credential places. `None` (and the walk told) when it can't be shown.
fn fetch(place: &dyn Place, path: &str, walk: &mut Walk) -> Option<String> {
    let text = (|| {
        if path.starts_with('~') || path.contains('$') || path.contains('`') {
            return None;
        }
        let real = place.resolve(path)?;
        if !place.contains(&real) {
            return None;
        }
        let text = place.read(&real, LONGEST_SCRIPT).ok()?;
        walk.ran.push(real);
        Some(text)
    })();
    match &text {
        Some(text) if super::super::secrets::names_place(text) => walk.credentials = true,
        Some(_) => {}
        None => walk.kind(Sensitive::UnseenScript),
    }
    text
}

/// Whether `name` is a file in `place`'s folder.
fn exists(place: &dyn Place, name: &str) -> bool {
    place
        .resolve(name)
        .is_some_and(|real| !matches!(place.read(&real, 1), Err(Unseen::Missing)))
}

fn join(dir: &str, name: &str) -> String {
    if name.starts_with('/') || dir == "." {
        name.to_owned()
    } else {
        Path::new(dir).join(name).to_string_lossy().into_owned()
    }
}
