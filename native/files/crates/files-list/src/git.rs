// SPDX-License-Identifier: Apache-2.0

//! Finds the ignore files git itself would read for a checkout.
//!
//! A checkout root can sit anywhere inside a repository, so the repository top (the folder that
//! holds `.git`) is found by walking up from the root and never looked past. Everything here is
//! best effort: no repository, an unreadable config or an unknown config value means "no such
//! file", never a failed listing.

use std::io::Read;
use std::path::{Path, PathBuf};

/// Config files are read up to this much; anything longer is not a git config ace cares about.
const MAX_CONFIG_BYTES: u64 = 64 * 1024;

/// A repository that contains a checkout.
pub(crate) struct Repository {
    /// The folder holding `.git`, where gitignore patterns start.
    pub(crate) top: PathBuf,
    /// The git directory holding `info/exclude` and `config`. A linked worktree keeps those in the
    /// main repository, which its own git directory names in its `commondir` file.
    pub(crate) common_dir: PathBuf,
}

/// The nearest folder at or above `dir` that holds `.git`, with the git directories it names.
///
/// `None` when `dir` is not inside a repository, in which case only the root's own `.gitignore`
/// applies and nothing above it is read.
pub(crate) fn repository(dir: &Path) -> Option<Repository> {
    dir.ancestors().find_map(|top| {
        let common_dir = common_dir_of(&git_dir_at(top)?);
        Some(Repository {
            top: top.to_path_buf(),
            common_dir,
        })
    })
}

/// A folder's git directory, following the `.git` file that worktrees and submodules use.
fn git_dir_at(folder: &Path) -> Option<PathBuf> {
    let dot = folder.join(".git");
    if dot.is_dir() {
        return Some(dot);
    }
    let text = read_bounded(&dot)?;
    let target = text
        .lines()
        .find_map(|line| line.trim().strip_prefix("gitdir:"))?
        .trim();
    if target.is_empty() {
        return None;
    }
    let path = Path::new(target);
    Some(if path.is_absolute() {
        path.to_path_buf()
    } else {
        folder.join(path)
    })
}

/// The shared git directory: `<git-dir>/commondir`, relative to the git directory unless absolute.
fn common_dir_of(git_dir: &Path) -> PathBuf {
    let Some(text) = read_bounded(&git_dir.join("commondir")) else {
        return git_dir.to_path_buf();
    };
    let value = text.trim();
    if value.is_empty() {
        return git_dir.to_path_buf();
    }
    let path = Path::new(value);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        git_dir.join(path)
    };
    std::fs::canonicalize(&joined).unwrap_or(joined)
}

/// `<git-dir>/info/exclude`, which git applies to every repository but never commits.
pub(crate) fn info_exclude(common_dir: &Path) -> Option<PathBuf> {
    let path = common_dir.join("info").join("exclude");
    path.is_file().then_some(path)
}

/// The file named by `core.excludesFile` in the repository's own config, when it sets one.
pub(crate) fn excludes_file(common_dir: &Path, base: &Path) -> Option<PathBuf> {
    let config = read_bounded(&common_dir.join("config"))?;
    let value = parse_core_excludes_file(&config)?;
    resolve_path(&value, base)
}

/// The last `core.excludesFile` value in a config file, in git's *section, key = value* form.
///
/// Git's `[include]` and `[includeIf]` sections are not followed, so a value set in an included
/// file is not seen.
fn parse_core_excludes_file(config: &str) -> Option<String> {
    let mut section = String::new();
    for line in config.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(header) = line.strip_prefix('[') {
            let header = header.split(']').next().unwrap_or(header);
            section = header
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if section == "core" && key.trim().eq_ignore_ascii_case("excludesfile") {
            let value = unquote(value.trim());
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

/// A config value: quoted parts keep everything, unquoted parts end at a `;` or `#` comment.
fn unquote(value: &str) -> String {
    let mut out = String::new();
    let mut quoted = false;
    let mut chars = value.chars();
    while let Some(character) = chars.next() {
        match character {
            '"' => quoted = !quoted,
            '\\' if quoted => {
                if let Some(escaped) = chars.next() {
                    out.push(escaped);
                }
            }
            ';' | '#' if !quoted => break,
            _ => out.push(character),
        }
    }
    out.trim().to_owned()
}

/// Git expands `~/` and `~user/`; a relative value is taken from the repository top.
fn resolve_path(value: &str, base: &Path) -> Option<PathBuf> {
    if value == "~" {
        return std::env::var_os("HOME").map(PathBuf::from);
    }
    if let Some(rest) = value.strip_prefix("~/") {
        let home = std::env::var_os("HOME")?;
        return Some(PathBuf::from(home).join(rest));
    }
    if let Some(rest) = value.strip_prefix('~') {
        let (user, rest) = match rest.split_once('/') {
            Some((user, rest)) => (user, rest),
            None => (rest, ""),
        };
        return Some(home_of(user)?.join(rest));
    }
    let path = Path::new(value);
    Some(if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    })
}

/// A user's home folder from the password database; only unix keeps one ace can read.
#[cfg(unix)]
fn home_of(user: &str) -> Option<PathBuf> {
    let database = std::fs::read_to_string("/etc/passwd").ok()?;
    for line in database.lines() {
        let mut fields = line.split(':');
        if fields.next() != Some(user) {
            continue;
        }
        let home = fields.nth(4)?;
        if !home.is_empty() {
            return Some(PathBuf::from(home));
        }
    }
    None
}

#[cfg(not(unix))]
fn home_of(_user: &str) -> Option<PathBuf> {
    None
}

fn read_bounded(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG_BYTES).read_to_end(&mut bytes).ok()?;
    String::from_utf8(bytes).ok()
}
