// SPDX-License-Identifier: Apache-2.0
//! Which files can change what a Git command reads as configuration (`config-sources.ts` and
//! `config-learning.ts`, G2c), and the `configWatch` request frame.

use std::path::{Path, PathBuf};

use ace_json::{Array, JsString, Map, Value};

use crate::core::error::{GitError, GitErrorCode};

/// Environment that never changes what Git reads as configuration or which checkout it finds.
pub const CONFIG_NEUTRAL: &[&str] = &[
    "GIT_INDEX_FILE",
    "GIT_LITERAL_PATHSPECS",
    "GIT_OPTIONAL_LOCKS",
    "GIT_TERMINAL_PROMPT",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_DATE",
];

/// The part of a call's environment that can change Git's configuration sources, sorted by key
/// so it forms a stable cache key.
pub fn config_environment(env: &[(String, String)]) -> Vec<(String, String)> {
    let mut kept: Vec<(String, String)> = env
        .iter()
        .filter(|(key, _)| !CONFIG_NEUTRAL.contains(&key.as_str()))
        .cloned()
        .collect();
    kept.sort_by(|(left, _), (right, _)| left.cmp(right));
    kept
}

/// Where a checkout's Git metadata lives, from three single-value `rev-parse` queries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub git_dir: String,
    pub common_dir: String,
    pub toplevel: String,
}

/// One path value from Git: strip one LF terminator (CRLF only on Windows).
pub fn single(raw: &str, is_windows: bool) -> String {
    crate::core::paths::strip_terminator(raw, is_windows).to_owned()
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `path.resolve(dir, value)`: absolute values stay, relative ones join.
pub(crate) fn resolve_path(base: &str, value: &str) -> String {
    let joined = Path::new(base).join(value);
    crate::core::paths::normalise(&joined)
}

pub fn parse_layout(cwd: &str, git_dir: &str, common_dir: &str, toplevel: &str) -> Option<Layout> {
    if git_dir.is_empty() || common_dir.is_empty() || toplevel.is_empty() {
        return None;
    }
    if !Path::new(git_dir).is_absolute() || !Path::new(toplevel).is_absolute() {
        return None;
    }
    Some(Layout {
        git_dir: git_dir.to_owned(),
        common_dir: resolve_path(cwd, common_dir),
        toplevel: toplevel.to_owned(),
    })
}

fn include_target(value: &str, file: &str, home: Option<&str>) -> Option<String> {
    if value.is_empty() {
        return Some(String::new());
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return home
            .filter(|home| Path::new(home).is_absolute())
            .map(|home| display(&Path::new(home).join(rest)));
    }
    // `~user/` and `%(prefix)/` depend on the account database and Git's build.
    if value.starts_with('~') || value.starts_with("%(prefix)") {
        return None;
    }
    if Path::new(value).is_absolute() {
        return Some(value.to_owned());
    }
    let parent = display(Path::new(file).parent().unwrap_or(Path::new("")));
    Some(resolve_path(&parent, value))
}

fn is_include_path(key: &str) -> bool {
    static PATTERN: std::sync::OnceLock<Option<regex::Regex>> = std::sync::OnceLock::new();
    PATTERN
        .get_or_init(|| regex::Regex::new(r"(?s)^include(?:if\..*)?\.path$").ok())
        .as_ref()
        .is_some_and(|pattern| pattern.is_match(key))
}

/// Every file the `config -z --show-origin --show-scope --list` output says Git read, plus the
/// targets of every include directive in them, whether or not those exist yet. `None` when the
/// listing has an origin or include this module can't place on disk exactly as Git would.
pub fn listed_sources(listing: &str, layout: &Layout, home: Option<&str>) -> Option<Vec<String>> {
    if !listing.is_empty() && !listing.ends_with('\0') {
        return None;
    }
    let fields: Vec<&str> = if listing.is_empty() {
        Vec::new()
    } else {
        listing[..listing.len() - 1].split('\0').collect()
    };
    if !fields.len().is_multiple_of(3) {
        return None;
    }
    let repository_files = [
        display(&Path::new(&layout.common_dir).join("config")),
        display(&Path::new(&layout.git_dir).join("config.worktree")),
    ];
    let mut files: Vec<String> = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let scope = fields[index];
        let origin = fields.get(index + 1).copied()?;
        let entry = fields.get(index + 2).copied()?;
        index += 3;
        // Our own `-c`/GIT_CONFIG_* pairs: fixed by the caller, never a file.
        if scope == "command" {
            continue;
        }
        let named = origin.strip_prefix("file:")?;
        // Git names the repository's own files relative to the worktree it changed into.
        let file = if Path::new(named).is_absolute() {
            named.to_owned()
        } else {
            let resolved = resolve_path(&layout.toplevel, named);
            if !repository_files.contains(&resolved) {
                return None;
            }
            resolved
        };
        push_unique(&mut files, &file);
        let newline = entry.find('\n');
        let key = match newline {
            Some(at) => &entry[..at],
            None => entry,
        };
        if !is_include_path(&key.to_lowercase()) {
            continue;
        }
        let value = match newline {
            Some(at) => &entry[at + 1..],
            None => "",
        };
        let target = include_target(value, &file, home)?;
        if !target.is_empty() {
            push_unique(&mut files, &target);
        }
    }
    Some(files)
}

fn push_unique(items: &mut Vec<String>, value: &str) {
    if !items.iter().any(|item| item == value) {
        items.push(value.to_owned());
    }
}

/// Every file whose change can alter what a Git command in `cwd` reads as configuration or which
/// checkout it finds: each listed file and include target, the standard files even when absent,
/// the checkout's own config files, HEAD (for `includeIf.onbranch`) and, from `cwd` up to its
/// worktree root, every `.git` entry and bare-repository marker.
pub fn watched_paths(
    cwd: &str,
    layout: &Layout,
    listed: &[String],
    standard: &[String],
) -> Option<Vec<String>> {
    let toplevel = Path::new(&layout.toplevel);
    // A path outside the checkout root has no discovery walk from the root.
    Path::new(cwd).strip_prefix(toplevel).ok()?;
    let mut discovery: Vec<String> = Vec::new();
    let mut directory = PathBuf::from(cwd);
    loop {
        discovery.push(display(&directory.join(".git")));
        if directory == *toplevel {
            break;
        }
        // Without a `.git` entry, discovery also accepts the directory itself as a bare
        // repository once it holds HEAD, objects/ and refs/, and then reads its `config`.
        for part in ["HEAD", "objects", "refs", "config"] {
            discovery.push(display(&directory.join(part)));
        }
        let parent = directory.parent()?.to_path_buf();
        if parent == directory || !starts_with_path(&directory, toplevel) {
            return None;
        }
        directory = parent;
    }
    let mut watched: Vec<String> = Vec::new();
    for path in discovery
        .into_iter()
        .chain([
            display(&Path::new(&layout.git_dir).join("HEAD")),
            display(&Path::new(&layout.git_dir).join("commondir")),
            display(&Path::new(&layout.git_dir).join("gitdir")),
            display(&Path::new(&layout.git_dir).join("config.worktree")),
            display(&Path::new(&layout.common_dir).join("config")),
        ])
        .chain(standard.iter().cloned())
        .chain(listed.iter().cloned())
    {
        if !watched.contains(&path) {
            watched.push(path);
        }
    }
    Some(watched)
}

fn starts_with_path(path: &Path, prefix: &Path) -> bool {
    path.strip_prefix(prefix).is_ok() && path != prefix
}

/// Everything the one `configWatch` operation needs: the raw Git output plus how to read it.
#[derive(Debug, Clone, Default)]
pub struct WatchInput {
    pub cwd: String,
    pub git_dir: Option<String>,
    pub common_dir: Option<String>,
    pub toplevel: Option<String>,
    /// The decoded `config -z --show-origin --show-scope --list` text, or `None` when it was
    /// not valid UTF-8.
    pub listing: Option<String>,
    pub standard: Vec<String>,
    pub home: Option<String>,
    pub is_windows: bool,
}

impl WatchInput {
    /// The watched paths, or `None` whenever any of it can't be named exactly.
    pub fn watched(&self) -> Option<Vec<String>> {
        let (Some(git_dir), Some(common_dir), Some(toplevel), Some(listing)) = (
            self.git_dir.as_deref(),
            self.common_dir.as_deref(),
            self.toplevel.as_deref(),
            self.listing.as_deref(),
        ) else {
            return None;
        };
        let layout = parse_layout(
            &self.cwd,
            &single(git_dir, self.is_windows),
            &single(common_dir, self.is_windows),
            &single(toplevel, self.is_windows),
        )?;
        let listed = listed_sources(listing, &layout, self.home.as_deref())?;
        watched_paths(&self.cwd, &layout, &listed, &self.standard)
    }
}

/// Reads one `configWatch` frame.
pub fn watch_input_from_json(text: &str) -> Option<WatchInput> {
    let map = ace_json::parse(text).ok()?;
    let Value::Object(map) = map else {
        return None;
    };
    let string = |key: &str| match map.get(key) {
        Some(Value::String(value)) => Some(value.to_string_lossy().into_owned()),
        _ => None,
    };
    let flag = |key: &str| matches!(map.get(key), Some(Value::Bool(true)));
    let standard = match map.get("standard") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::String(value) => Some(value.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect::<Option<Vec<String>>>()?,
        _ => Vec::new(),
    };
    Some(WatchInput {
        cwd: string("cwd")?,
        git_dir: string("gitDir"),
        common_dir: string("commonDir"),
        toplevel: string("toplevel"),
        listing: string("listing"),
        standard,
        home: string("home"),
        is_windows: flag("isWindows"),
    })
}

/// The answer frame: `{ paths: string[] | null }`.
pub fn paths_to_json(paths: Option<&[String]>) -> String {
    let mut frame = Map::new();
    match paths {
        Some(paths) => {
            let items: Vec<Value> = paths
                .iter()
                .map(|path| Value::String(JsString::from(path.as_str())))
                .collect();
            frame.insert(JsString::from("paths"), Value::Array(Array::from(items)));
        }
        None => {
            frame.insert(JsString::from("paths"), Value::Null);
        }
    }
    ace_json::to_string(&Value::Object(frame))
}

/// The error a malformed request is answered with.
pub fn invalid_request() -> GitError {
    GitError::new(GitErrorCode::InvalidArgument, "invalid config request")
}

#[cfg(test)]
mod tests;
