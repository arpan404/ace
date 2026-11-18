//! Configuration around a command's folder that can make a tool run a program the command never
//! names (ADR 0172, amendment 2): git's (an fsmonitor, a pager, diff, merge and filter drivers,
//! credential and gpg programs, aliases that run a shell, hooks; across the repository's config,
//! a worktree's, every file they include, and `GIT_*` variables), the Node package managers'
//! (`.npmrc`, `.yarnrc`, `.yarnrc.yml`, `bunfig.toml`, a pnpmfile, `.env` for bun), cargo's
//! (`.cargo/config.toml`, a toolchain file's `path`, `RUSTC_*` and `CARGO_*` variables) and
//! ripgrep's (`RIPGREP_CONFIG_PATH`). Project tool managers' hooks (`mise.toml`'s `_.source`)
//! count for the tools they put on the path.
//!
//! The decision is pure: the gate brings the files and the environment through [`Files`]. What
//! can't be read counts as running something. Configuration is read through the environment the
//! command runs with: Spade sets `HOME` to the bot's folder, so `~/.gitconfig` and `~/.npmrc` are
//! files the bot can write, and they are read. Machine-wide configuration (`/etc/gitconfig`) and
//! project files above the bot's folder are the person's and are not.

use std::path::{Component, Path, PathBuf};

use spade_core::autonomy::ConfigTools;

/// A file, as the gate found it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Found {
    Missing,
    Text(String),
    /// There, but unreadable or too large: counts as running something.
    Unreadable,
}

/// What [`inspect`] reads: the files around the folder and the environment commands run with.
pub trait Files {
    fn read(&self, path: &Path) -> Found;
    /// The names in a folder; `None` when it isn't one.
    fn list(&self, dir: &Path) -> Option<Vec<String>>;
    fn var(&self, name: &str) -> Option<String>;
    /// Every variable's name.
    fn vars(&self) -> Vec<String>;
}

/// The most files one inspection follows through includes.
const MOST_INCLUDES: usize = 32;

/// Which tools' configuration, for a command starting in `start` inside the bot's folder
/// `workspace`, names no program for them to run.
pub fn inspect(files: &dyn Files, start: &Path, workspace: &Path) -> ConfigTools {
    let start = lexical(start);
    let workspace = lexical(workspace);
    // The folders from `start` up to the bot's folder: project configuration lives there.
    let mut chain: Vec<PathBuf> = start
        .ancestors()
        .take_while(|dir| dir.starts_with(&workspace))
        .map(Path::to_path_buf)
        .collect();
    if chain.is_empty() {
        chain.push(start.clone());
    }
    let managed = !manager_hooks(files, &chain);
    ConfigTools {
        git: git(files, &start),
        node: managed && node(files, &chain, &start),
        cargo: managed && cargo(files, &chain),
        ripgrep: ripgrep(files),
    }
}

fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// `GIT_*` variables that only set identity, dates or output: anything else (a config file, a
/// pager, an ssh command, another git folder) counts as running something.
const GIT_PLAIN_VARS: &[&str] = &[
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_DATE",
    "GIT_TERMINAL_PROMPT",
    "GIT_OPTIONAL_LOCKS",
    "GIT_FLUSH",
    "GIT_LFS_SKIP_SMUDGE",
    "GIT_CONFIG_NOSYSTEM",
];

fn git(files: &dyn Files, start: &Path) -> bool {
    if files
        .vars()
        .iter()
        .any(|name| name.starts_with("GIT_") && !GIT_PLAIN_VARS.contains(&name.as_str()))
    {
        return false;
    }
    let Some(gitdir) = git_dir(files, start) else {
        // No repository: only the home's configuration applies.
        let mut seen = 0;
        return match files.var("HOME") {
            Some(home) => {
                let home = Path::new(&home);
                git_config_runs_nothing(files, &home.join(".gitconfig"), &mut seen)
                    && git_config_runs_nothing(files, &home.join(".config/git/config"), &mut seen)
            }
            None => true,
        };
    };
    let common = match files.read(&gitdir.join("commondir")) {
        Found::Text(dir) => lexical(&gitdir.join(dir.trim())),
        Found::Missing => gitdir.clone(),
        Found::Unreadable => return false,
    };
    let mut seen = 0;
    // The "global" files of the home the command runs with, then the repository's own.
    let mut configs = Vec::new();
    if let Some(home) = files.var("HOME") {
        configs.push(Path::new(&home).join(".gitconfig"));
        let xdg = files
            .var("XDG_CONFIG_HOME")
            .map_or_else(|| Path::new(&home).join(".config"), PathBuf::from);
        configs.push(xdg.join("git/config"));
    }
    configs.push(common.join("config"));
    configs.push(gitdir.join("config.worktree"));
    for config in configs {
        if !git_config_runs_nothing(files, &config, &mut seen) {
            return false;
        }
    }
    // A hook that isn't a sample may run for this command (`post-index-change` after a status).
    match files.list(&common.join("hooks")) {
        Some(names) => names.iter().all(|name| name.ends_with(".sample")),
        None => true,
    }
}

/// The repository's git folder, found the way git finds it: the nearest `.git` at or above
/// `start`, a folder or a file naming one.
fn git_dir(files: &dyn Files, start: &Path) -> Option<PathBuf> {
    for dir in start.ancestors() {
        let dot = dir.join(".git");
        if files.list(&dot).is_some() {
            return Some(dot);
        }
        match files.read(&dot) {
            Found::Text(text) => {
                let target = text.trim().strip_prefix("gitdir:").map(str::trim)?;
                return Some(lexical(&dir.join(target)));
            }
            // A `.git` that can't be read: say there is one, at a place with nothing readable.
            Found::Unreadable => return Some(dot),
            Found::Missing => {}
        }
    }
    None
}

/// Whether the git config file at `path` and every file it includes name no program.
fn git_config_runs_nothing(files: &dyn Files, path: &Path, seen: &mut usize) -> bool {
    *seen += 1;
    if *seen > MOST_INCLUDES {
        return false;
    }
    let text = match files.read(path) {
        Found::Missing => return true,
        Found::Unreadable => return false,
        Found::Text(text) => text,
    };
    let Some(entries) = git_config(&text) else {
        return false;
    };
    let base = path.parent().unwrap_or(Path::new("/"));
    for entry in &entries {
        if runs(entry) {
            return false;
        }
        if entry.key == "path" && matches!(entry.section.as_str(), "include" | "includeif") {
            if entry.value.is_empty() {
                continue;
            }
            if entry.value.starts_with("%(") {
                return false;
            }
            let target = match entry.value.strip_prefix("~/") {
                Some(rest) => match files.var("HOME") {
                    Some(home) => Path::new(&home).join(rest),
                    None => return false,
                },
                None => base.join(&entry.value),
            };
            if !git_config_runs_nothing(files, &lexical(&target), seen) {
                return false;
            }
        }
    }
    true
}

/// One `key = value` of a git config file, its section and key lower-cased.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Entry {
    pub section: String,
    pub subsection: Option<String>,
    pub key: String,
    pub value: String,
}

/// The entries of a git config file, read by git's own rules (quoted values, the escapes `\\`,
/// `\"`, `\n`, `\t`, `\b`, a backslash before a line's end, `#` and `;` comments outside
/// quotes, `[section "sub"]` and `[section.sub]` headers); `None` for anything else, which then
/// counts as running something.
pub(crate) fn git_config(text: &str) -> Option<Vec<Entry>> {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut out = Vec::new();
    let mut section: Option<(String, Option<String>)> = None;
    let mut i = 0;
    loop {
        while i < n && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= n {
            return Some(out);
        }
        match chars[i] {
            '#' | ';' => {
                while i < n && chars[i] != '\n' {
                    i += 1;
                }
            }
            '[' => {
                i += 1;
                let start = i;
                while i < n && (chars[i].is_ascii_alphanumeric() || matches!(chars[i], '-' | '.')) {
                    i += 1;
                }
                let name: String = chars[start..i].iter().collect();
                if name.is_empty() {
                    return None;
                }
                let mut sub = None;
                if i < n && matches!(chars[i], ' ' | '\t') {
                    while i < n && matches!(chars[i], ' ' | '\t') {
                        i += 1;
                    }
                    if chars.get(i) != Some(&'"') {
                        return None;
                    }
                    i += 1;
                    let mut text = String::new();
                    loop {
                        match chars.get(i)? {
                            '"' => break,
                            '\n' => return None,
                            '\\' => {
                                i += 1;
                                let c = *chars.get(i)?;
                                if c == '\n' {
                                    return None;
                                }
                                text.push(c);
                            }
                            c => text.push(*c),
                        }
                        i += 1;
                    }
                    i += 1;
                    sub = Some(text);
                }
                if chars.get(i) != Some(&']') {
                    return None;
                }
                i += 1;
                let (name, sub) = match (name.split_once('.'), sub) {
                    (Some(_), Some(_)) => return None,
                    (Some((head, rest)), None) => (head.to_owned(), Some(rest.to_owned())),
                    (None, sub) => (name, sub),
                };
                section = Some((name.to_ascii_lowercase(), sub));
            }
            c if c.is_ascii_alphabetic() => {
                let (name, sub) = section.clone()?;
                let start = i;
                while i < n && (chars[i].is_ascii_alphanumeric() || chars[i] == '-') {
                    i += 1;
                }
                let key: String = chars[start..i]
                    .iter()
                    .collect::<String>()
                    .to_ascii_lowercase();
                while i < n && matches!(chars[i], ' ' | '\t') {
                    i += 1;
                }
                let value = match chars.get(i) {
                    None | Some('\n') | Some('#') | Some(';') => "true".to_owned(),
                    Some('\r') if chars.get(i + 1) == Some(&'\n') => "true".to_owned(),
                    Some('=') => {
                        i += 1;
                        let (value, next) = git_value(&chars, i)?;
                        i = next;
                        value
                    }
                    _ => return None,
                };
                out.push(Entry {
                    section: name,
                    subsection: sub,
                    key,
                    value,
                });
            }
            _ => return None,
        }
    }
}

/// A value from `at` to its line's end, and where reading stopped.
fn git_value(chars: &[char], mut i: usize) -> Option<(String, usize)> {
    let n = chars.len();
    let mut value = String::new();
    // Whitespace outside quotes, kept only if more of the value follows.
    let mut pending = String::new();
    let mut quoted = false;
    let mut started = false;
    while i < n {
        let c = chars[i];
        match c {
            '\n' if quoted => return None,
            '\n' => break,
            '\r' if chars.get(i + 1) == Some(&'\n') && !quoted => break,
            '#' | ';' if !quoted => {
                while i < n && chars[i] != '\n' {
                    i += 1;
                }
                break;
            }
            '"' => {
                value.push_str(&pending);
                pending.clear();
                quoted = !quoted;
                started = true;
            }
            '\\' => {
                i += 1;
                let escaped = match chars.get(i)? {
                    'n' => Some('\n'),
                    't' => Some('\t'),
                    'b' => Some('\u{8}'),
                    '"' => Some('"'),
                    '\\' => Some('\\'),
                    '\n' => None,
                    '\r' if chars.get(i + 1) == Some(&'\n') => {
                        i += 1;
                        None
                    }
                    _ => return None,
                };
                if let Some(e) = escaped {
                    value.push_str(&pending);
                    pending.clear();
                    value.push(e);
                    started = true;
                }
            }
            ' ' | '\t' if !quoted => {
                if started {
                    pending.push(c);
                }
            }
            c => {
                value.push_str(&pending);
                pending.clear();
                value.push(c);
                started = true;
            }
        }
        i += 1;
    }
    if quoted {
        return None;
    }
    Some((value, i))
}

/// Sections every key of which names something git may run.
const RUNNING_SECTIONS: &[&str] = &[
    "pager",
    "difftool",
    "mergetool",
    "sendemail",
    "filter",
    "credential",
    "gpg",
    "browser",
    "man",
    "instaweb",
    "web",
    "guitool",
    "sequence",
    "trailer",
];

/// Key endings that name a program, whatever the section (so a key git adds later is caught).
const RUNNING_KEYS: &[&str] = &[
    "command",
    "cmd",
    "program",
    "helper",
    "editor",
    "pager",
    "textconv",
    "driver",
    "askpass",
    "sshcommand",
    "hookspath",
    "gitproxy",
    "external",
    "uploadpack",
    "receivepack",
    "packobjectshook",
    "difffilter",
    "fsmonitor",
    "process",
    "smudge",
    "clean",
    "vcs",
];

/// Whether a git config entry names a program for git to run.
pub(crate) fn runs(entry: &Entry) -> bool {
    if entry.section == "core"
        && entry.key == "fsmonitor"
        && matches!(
            entry.value.to_ascii_lowercase().as_str(),
            "false" | "true" | "0" | "1" | "no" | "yes" | "off" | "on" | ""
        )
    {
        // The built-in daemon, or none: git itself.
        return false;
    }
    entry.value.starts_with('!')
        || RUNNING_SECTIONS.contains(&entry.section.as_str())
        || RUNNING_KEYS.iter().any(|k| entry.key.ends_with(k))
}

/// Whether a project tool manager's configuration in the folder runs a script for the tools it
/// puts on the path (`mise.toml`'s `[env] _.source`, its hooks).
fn manager_hooks(files: &dyn Files, chain: &[PathBuf]) -> bool {
    let shims = files
        .var("PATH")
        .is_some_and(|path| path.contains("mise") || path.contains("rtx") || path.contains("asdf"));
    if !shims {
        return false;
    }
    const CONFIGS: &[&str] = &[
        "mise.toml",
        ".mise.toml",
        "mise.local.toml",
        ".mise.local.toml",
        ".config/mise.toml",
        ".config/mise/config.toml",
        ".mise/config.toml",
        ".rtx.toml",
    ];
    chain.iter().any(|dir| {
        CONFIGS
            .iter()
            .any(|name| match files.read(&dir.join(name)) {
                Found::Missing => false,
                Found::Unreadable => true,
                Found::Text(text) => {
                    let text = text.to_ascii_lowercase();
                    text.contains("source") || text.contains("hooks") || text.contains("enter")
                }
            })
    })
}

/// A file in one of `chain`'s folders whose text means a tool runs something: `true` when none.
fn none_runs(
    files: &dyn Files,
    chain: &[PathBuf],
    name: &str,
    runs: impl Fn(&str) -> bool,
) -> bool {
    chain.iter().all(|dir| match files.read(&dir.join(name)) {
        Found::Missing => true,
        Found::Unreadable => false,
        Found::Text(text) => !runs(&text.to_ascii_lowercase()),
    })
}

fn node(files: &dyn Files, chain: &[PathBuf], start: &Path) -> bool {
    const NPMRC: &[&str] = &[
        "node-options",
        "script-shell",
        "shell",
        "onload-script",
        "init-module",
        "editor",
        "browser",
        "git",
        "viewer",
        "globalconfig",
        "userconfig",
        "prefix",
        "node-gyp",
    ];
    let npmrc_runs = |text: &str| {
        text.lines().any(|line| {
            let key = line.split('=').next().unwrap_or("").trim();
            NPMRC.contains(&key) || key.ends_with(":node-options")
        })
    };
    let env_runs = files.var("NODE_OPTIONS").is_some()
        || files.vars().iter().any(|name| {
            let lower = name.to_ascii_lowercase();
            lower.starts_with("npm_config_")
                || lower.starts_with("yarn_")
                || lower.starts_with("bun_")
        });
    let pnpmfile = chain.iter().any(|dir| {
        [
            ".pnpmfile.cjs",
            ".pnpmfile.mjs",
            "pnpmfile.js",
            ".pnpmfile.js",
        ]
        .iter()
        .any(|name| files.read(&dir.join(name)) != Found::Missing)
    });
    // bun reads `.env` files from where it starts into the environment.
    let dotenv = [
        ".env",
        ".env.local",
        ".env.development",
        ".env.production",
        ".env.test",
    ]
    .iter()
    .any(|name| match files.read(&start.join(name)) {
        Found::Missing => false,
        Found::Unreadable => true,
        Found::Text(text) => {
            let text = text.to_ascii_lowercase();
            ["node_options", "ld_preload", "bun_", "npm_config_", "dyld_"]
                .iter()
                .any(|k| text.contains(k))
        }
    });
    !env_runs
        && !pnpmfile
        && !dotenv
        && none_runs(files, chain, ".npmrc", npmrc_runs)
        && none_runs(files, chain, ".yarnrc", |t| {
            t.contains("yarn-path") || t.contains("--")
        })
        && none_runs(files, chain, ".yarnrc.yml", |t| {
            t.contains("yarnpath") || t.contains("plugins") || t.contains("injectenvironmentfiles")
        })
        && none_runs(files, chain, "bunfig.toml", |t| {
            t.contains("preload") || t.contains("[run]")
        })
        && none_runs(files, chain, "pnpm-workspace.yaml", |t| {
            t.contains("pnpmfile") || t.contains("nodeoptions") || t.contains("scriptshell")
        })
}

fn cargo(files: &dyn Files, chain: &[PathBuf]) -> bool {
    const RUNS: &[&str] = &[
        "runner",
        "rustc",
        "rustdoc",
        "wrapper",
        "linker",
        "alias",
        "credential",
        "[env]",
        "rustflags",
        "[target",
        "[unstable]",
        "[host]",
    ];
    let config_runs = |text: &str| RUNS.iter().any(|k| text.contains(k));
    let env_runs = files.vars().iter().any(|name| {
        matches!(
            name.as_str(),
            "RUSTC"
                | "RUSTC_WRAPPER"
                | "RUSTC_WORKSPACE_WRAPPER"
                | "RUSTDOC"
                | "RUSTFLAGS"
                | "RUSTUP_TOOLCHAIN"
        ) || name.starts_with("CARGO_BUILD_")
            || name.starts_with("CARGO_TARGET_")
            || name.starts_with("CARGO_ALIAS_")
            || name == "CARGO_HOME"
    });
    !env_runs
        && none_runs(files, chain, ".cargo/config.toml", config_runs)
        && none_runs(files, chain, ".cargo/config", config_runs)
        && none_runs(files, chain, "rust-toolchain.toml", |t| t.contains("path"))
        && none_runs(files, chain, "rust-toolchain", |t| {
            t.contains("path") || t.contains('/')
        })
}

fn ripgrep(files: &dyn Files) -> bool {
    let Some(path) = files.var("RIPGREP_CONFIG_PATH") else {
        return true;
    };
    match files.read(Path::new(&path)) {
        Found::Missing => true,
        Found::Unreadable => false,
        Found::Text(text) => !text.contains("--pre"),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    /// Files and variables held in memory.
    #[derive(Default)]
    struct Memory {
        files: BTreeMap<PathBuf, Option<String>>,
        dirs: BTreeMap<PathBuf, Vec<String>>,
        vars: BTreeMap<String, String>,
    }

    impl Memory {
        fn file(mut self, path: &str, text: &str) -> Self {
            self.files
                .insert(PathBuf::from(path), Some(text.to_owned()));
            self
        }
        fn unreadable(mut self, path: &str) -> Self {
            self.files.insert(PathBuf::from(path), None);
            self
        }
        fn dir(mut self, path: &str, names: &[&str]) -> Self {
            self.dirs.insert(
                PathBuf::from(path),
                names.iter().map(|n| (*n).to_owned()).collect(),
            );
            self
        }
        fn var(mut self, name: &str, value: &str) -> Self {
            self.vars.insert(name.to_owned(), value.to_owned());
            self
        }
        fn repo(self) -> Self {
            self.dir("/w/.git", &["config", "HEAD", "hooks"])
                .dir("/w/.git/hooks", &["pre-commit.sample"])
                .file("/w/.git/config", "[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote \"origin\"]\n\turl = https://example.com/x.git\n")
        }
    }

    impl Files for Memory {
        fn read(&self, path: &Path) -> Found {
            match self.files.get(path) {
                None => Found::Missing,
                Some(None) => Found::Unreadable,
                Some(Some(text)) => Found::Text(text.clone()),
            }
        }
        fn list(&self, dir: &Path) -> Option<Vec<String>> {
            self.dirs.get(dir).cloned()
        }
        fn var(&self, name: &str) -> Option<String> {
            self.vars.get(name).cloned()
        }
        fn vars(&self) -> Vec<String> {
            self.vars.keys().cloned().collect()
        }
    }

    /// Which tool a case is about.
    type Tool = fn(ConfigTools) -> bool;

    fn clean(files: &Memory) -> ConfigTools {
        inspect(files, Path::new("/w/src"), Path::new("/w"))
    }

    #[test]
    fn a_plain_repository_and_folder_run_nothing() {
        assert_eq!(clean(&Memory::default().repo()), ConfigTools::ALL);
        assert!(clean(&Memory::default()).git, "no repository at all");
    }

    #[test]
    fn git_config_that_names_a_program_counts_wherever_it_is() {
        for config in [
            "[core]\n\tfsmonitor = ./monitor.sh",
            "[core]\n\tpager = less -R",
            "[core]\n\tsshCommand = ssh -i key",
            "[core]\n\thooksPath = .husky",
            "[diff \"img\"]\n\ttextconv = ./conv",
            "[diff]\n\texternal = difft",
            "[filter \"lfs\"]\n\tsmudge = git-lfs smudge %f",
            "[filter \"x\"]\n\tprocess = ./filter",
            "[merge \"ours\"]\n\tdriver = true",
            "[credential]\n\thelper = store",
            "[gpg]\n\tprogram = ./gpg",
            "[alias]\n\tst = !./run.sh",
            "[pager]\n\tlog = ./page",
            "[core] fsmonitor = ./m",
            "[sequence]\n\teditor = ./e",
            "[remote \"o\"]\n\tuploadpack = ./up",
            "garbage that isn't config",
        ] {
            let files = Memory::default().repo().file("/w/.git/config", config);
            assert!(!clean(&files).git, "{config}");
        }
        // The built-in fsmonitor daemon is git itself.
        let builtin = Memory::default()
            .repo()
            .file("/w/.git/config", "[core]\n\tfsmonitor = true");
        assert!(clean(&builtin).git);
        // A plain alias rewrites to git's own commands.
        let alias = Memory::default()
            .repo()
            .file("/w/.git/config", "[alias]\n\tst = status -sb");
        assert!(clean(&alias).git);
    }

    #[test]
    fn config_is_read_by_gits_own_quoting_and_what_it_cant_read_counts() {
        // A quoted include path keeps its `#`: the file it names is read.
        let hash = Memory::default()
            .repo()
            .file("/w/.git/config", "[include]\n\tpath = \"extra#cfg\"")
            .file("/w/.git/extra#cfg", "[core]\n\tfsmonitor = ./m");
        assert!(!clean(&hash).git, "the include named extra#cfg");
        // An unquoted `#` starts a comment, as git reads it.
        let comment = Memory::default()
            .repo()
            .file("/w/.git/config", "[include]\n\tpath = extra # cfg")
            .file("/w/.git/extra", "[core]\n\tpager = ./p");
        assert!(!clean(&comment).git);
        // A value continued with a backslash, and escapes.
        let continued = Memory::default()
            .repo()
            .file("/w/.git/config", "[core]\n\tfsmon\\\nitor = x");
        assert!(!clean(&continued).git, "not a key git reads: refused");
        let escaped = Memory::default()
            .repo()
            .file("/w/.git/config", "[include]\n\tpath = \"ex\\\"tra\"")
            .file("/w/.git/ex\"tra", "[core]\n\tpager = ./p");
        assert!(!clean(&escaped).git);
        for broken in [
            "[core]\n\tpager = \"unterminated",
            "[core]\n\tpager = a\\qb",
            "[core \"x\n",
            "key = value",
            "[core]\n\t9key = v",
            "[core.x \"y\"]",
        ] {
            let files = Memory::default().repo().file("/w/.git/config", broken);
            assert!(!clean(&files).git, "{broken:?}");
        }
        let header_entry = Memory::default()
            .repo()
            .file("/w/.git/config", "[core] fsmonitor = ./m");
        assert!(!clean(&header_entry).git);
        let plain = Memory::default().repo().file(
            "/w/.git/config",
            "# comment\n[core]\n\tbare = false ; trailing\n[remote \"origin\"]\n\turl = \"https://example.com/a b.git\"\n",
        );
        assert!(clean(&plain).git);
    }

    #[test]
    fn included_files_worktrees_hooks_and_variables_are_read_too() {
        let included = Memory::default()
            .repo()
            .file(
                "/w/.git/config",
                "[includeIf \"gitdir:/w/\"]\n\tpath = extra.cfg",
            )
            .file("/w/.git/extra.cfg", "[core]\n\tpager = ./p");
        assert!(!clean(&included).git);
        let unreadable_include = Memory::default()
            .repo()
            .file("/w/.git/config", "[include]\n\tpath = extra.cfg")
            .unreadable("/w/.git/extra.cfg");
        assert!(!clean(&unreadable_include).git);
        let worktree = Memory::default()
            .file("/w/.git", "gitdir: /main/.git/worktrees/w\n")
            .file("/main/.git/worktrees/w/commondir", "../..\n")
            .file("/main/.git/config", "[core]\n\tfsmonitor = /tmp/m");
        assert!(!clean(&worktree).git);
        let worktree_config = Memory::default()
            .repo()
            .file("/w/.git/config.worktree", "[diff]\n\texternal = ./d");
        assert!(!clean(&worktree_config).git);
        let hook = Memory::default()
            .repo()
            .dir("/w/.git/hooks", &["post-index-change"]);
        assert!(!clean(&hook).git);
        let variable = Memory::default().repo().var("GIT_CONFIG_COUNT", "1");
        assert!(!clean(&variable).git);
        // Spade's commands run with the bot's folder as their home.
        let home = Memory::default()
            .repo()
            .var("HOME", "/w")
            .file("/w/.gitconfig", "[core]\n\tpager = ./p");
        assert!(!clean(&home).git);
        let xdg = Memory::default()
            .var("HOME", "/w")
            .file("/w/.config/git/config", "[diff]\n\texternal = ./d");
        assert!(
            !clean(&xdg).git,
            "no repository, but a home config that runs something"
        );
        let identity = Memory::default().repo().var("GIT_AUTHOR_NAME", "Sam");
        assert!(clean(&identity).git);
    }

    #[test]
    fn node_cargo_and_ripgrep_configuration_that_runs_something_counts() {
        let cases: [(Memory, Tool); 9] = [
            (
                Memory::default().file("/w/.npmrc", "node-options=--require ./x.js"),
                |c| c.node,
            ),
            (
                Memory::default().file("/w/src/.npmrc", "script-shell=./sh"),
                |c| c.node,
            ),
            (
                Memory::default().file("/w/.pnpmfile.cjs", "module.exports = {}"),
                |c| c.node,
            ),
            (
                Memory::default().file("/w/.yarnrc.yml", "yarnPath: .yarn/releases/x.cjs"),
                |c| c.node,
            ),
            (
                Memory::default().file("/w/bunfig.toml", "preload = [\"./x.ts\"]"),
                |c| c.node,
            ),
            (
                Memory::default().file(
                    "/w/.cargo/config.toml",
                    "[target.x86_64-unknown-linux-gnu]\nrunner = \"./r\"",
                ),
                |c| c.cargo,
            ),
            (
                Memory::default().file("/w/rust-toolchain.toml", "[toolchain]\npath = \"./tc\""),
                |c| c.cargo,
            ),
            (
                Memory::default()
                    .var("RIPGREP_CONFIG_PATH", "/w/.rg")
                    .file("/w/.rg", "--pre=./x"),
                |c| c.ripgrep,
            ),
            (
                Memory::default()
                    .var("PATH", "/home/u/.local/share/mise/shims:/usr/bin")
                    .file("/w/mise.toml", "[env]\n_.source = \"./env.sh\""),
                |c| c.node && c.cargo,
            ),
        ];
        for (files, tool) in cases {
            assert!(!tool(clean(&files)), "{:?}", files.files);
        }
        let plain = Memory::default()
            .file("/w/.npmrc", "save-exact=true")
            .file("/w/.cargo/config.toml", "[build]\njobs = 4")
            .var("RIPGREP_CONFIG_PATH", "/w/.rg")
            .file("/w/.rg", "--smart-case");
        assert_eq!(clean(&plain), ConfigTools::ALL);
    }

    #[test]
    fn configuration_above_the_bots_folder_is_the_persons_own() {
        let files = Memory::default().file("/.npmrc", "node-options=--require x");
        assert!(clean(&files).node);
    }
}
