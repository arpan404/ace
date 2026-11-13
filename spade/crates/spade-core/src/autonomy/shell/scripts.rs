//! Code a command runs that its words don't show: inline code (`python -c`, `node -e`, `awk`
//! programs) and the files and task lists it runs (a script, a make target, a package script).
//! Inline code is already in the call, so the reviewer reads it; markers of network use or of
//! starting other programs in it go to the person. Files are read so the reviewer sees what
//! would run; one Spade can't show goes to the person.

use std::path::Path;

use super::super::Sensitive;
use super::effects::{Effect, Run};
use super::paths::Place;
use super::{Finding, Shown};

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
    "pty",
    "shell_exec",
    "passthru",
    "proc_open",
    "%x",
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
    Effect { sensitive, runs }
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
                    sensitive: None,
                    runs: words.get(at).cloned().map(Run::File).into_iter().collect(),
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
                    runs: Vec::new(),
                };
            }
        }
    }
    Effect::default()
}

/// Shows each run's code (adding to `shown`), and says what it needs: a file outside the
/// folder, unreadable or too long goes to the person; a shell script's or a package script's
/// commands are checked like the call's own.
pub(super) fn show(
    runs: &[Run],
    place: &dyn Place,
    depth: usize,
    shown: &mut Vec<Shown>,
) -> Option<Finding> {
    let unseen = Some(Finding::Sensitive(Sensitive::UnseenScript));
    if depth > DEEPEST {
        return unseen;
    }
    for run in runs {
        let found = match run {
            Run::File(path) => {
                let Some(text) = read(place, path) else {
                    return unseen;
                };
                if super::super::secrets::names_place(&text) {
                    return Some(Finding::Credentials);
                }
                let shelled = path.ends_with(".sh")
                    || text.starts_with("#!")
                        && text.lines().next().is_some_and(|l| l.ends_with("sh"));
                shown.push(Shown {
                    path: path.clone(),
                    content: text.clone(),
                });
                shelled
                    .then(|| super::assess_at(&text, place, depth + 1, shown))
                    .flatten()
            }
            Run::Make { dir, file } | Run::Just { dir, file } => {
                let names: &[&str] = if matches!(run, Run::Make { .. }) {
                    &["GNUmakefile", "makefile", "Makefile"]
                } else {
                    &["justfile", "Justfile", ".justfile"]
                };
                let candidates: Vec<String> = match file {
                    Some(file) => vec![join(dir, file)],
                    None => names.iter().map(|n| join(dir, n)).collect(),
                };
                let Some((path, text)) = candidates
                    .iter()
                    .find_map(|c| read(place, c).map(|text| (c.clone(), text)))
                else {
                    return unseen;
                };
                shown.push(Shown {
                    path,
                    content: text.clone(),
                });
                // Recipe lines are shell commands; what they plainly do is checked, though
                // make's own variables keep some from being read.
                recipes(&text).find_map(|line| {
                    match super::assess_at(line, place, depth + 1, shown) {
                        Some(Finding::Sensitive(Sensitive::Unclear | Sensitive::UnseenScript)) => {
                            None
                        }
                        other => other,
                    }
                })
            }
            Run::Package { dir, target } => {
                let path = join(dir, "package.json");
                let Some(text) = read(place, &path) else {
                    return unseen;
                };
                let Ok(package) = serde_json::from_str::<serde_json::Value>(&text) else {
                    return unseen;
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
                shown.push(Shown {
                    path: format!("{path} (scripts)"),
                    content: bodies
                        .iter()
                        .map(|(name, body)| format!("{name}: {body}"))
                        .collect::<Vec<_>>()
                        .join("\n"),
                });
                // A package script runs through `sh -c` from the package's folder.
                bodies
                    .iter()
                    .find_map(|(_, body)| super::assess_at(body, place, depth + 1, shown))
            }
        };
        if found.is_some() {
            return found;
        }
    }
    None
}

/// A file's text, when it is inside the folder and short enough to show.
fn read(place: &dyn Place, path: &str) -> Option<String> {
    if path.starts_with('~') || path.contains('$') || path.contains('`') {
        return None;
    }
    let real = place.resolve(path)?;
    if !place.contains(&real) {
        return None;
    }
    place.read(&real, LONGEST_SCRIPT).ok()
}

fn join(dir: &str, name: &str) -> String {
    if name.starts_with('/') || dir == "." {
        name.to_owned()
    } else {
        Path::new(dir).join(name).to_string_lossy().into_owned()
    }
}

/// A makefile's or justfile's recipe lines (indented), without make's echo and error marks.
fn recipes(text: &str) -> impl Iterator<Item = &str> {
    text.lines()
        .filter(|line| line.starts_with('\t') || line.starts_with("    "))
        .map(|line| line.trim().trim_start_matches(['@', '-', '+']).trim())
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
}
