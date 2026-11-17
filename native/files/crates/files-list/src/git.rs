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

/// The nearest folder at or above `dir` that holds `.git`, with the git directory it names.
///
/// `None` when `dir` is not inside a repository, in which case only the root's own `.gitignore`
/// applies and nothing above it is read.
pub(crate) fn repository(dir: &Path) -> Option<(PathBuf, PathBuf)> {
    dir.ancestors()
        .find_map(|folder| git_dir_at(folder).map(|git| (folder.to_path_buf(), git)))
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

/// `<git-dir>/info/exclude`, which git applies to every repository but never commits.
pub(crate) fn info_exclude(git_dir: &Path) -> Option<PathBuf> {
    let path = git_dir.join("info").join("exclude");
    path.is_file().then_some(path)
}

/// The file named by `core.excludesFile` in the repository's own config, when it sets one.
pub(crate) fn excludes_file(git_dir: &Path, base: &Path) -> Option<PathBuf> {
    let config = read_bounded(&git_dir.join("config"))?;
    let value = parse_core_excludes_file(&config)?;
    resolve_path(&value, base)
}

/// The last `core.excludesFile` value in a config file, in git's *section, key = value* form.
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
            let value = value.trim().trim_matches('"');
            if !value.is_empty() {
                return Some(value.to_owned());
            }
        }
    }
    None
}

/// Git expands a leading `~/`; a relative value is taken from the repository top.
fn resolve_path(value: &str, base: &Path) -> Option<PathBuf> {
    if let Some(rest) = value.strip_prefix("~/") {
        let home = std::env::var_os("HOME")?;
        return Some(PathBuf::from(home).join(rest));
    }
    let path = Path::new(value);
    Some(if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    })
}

fn read_bounded(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG_BYTES).read_to_end(&mut bytes).ok()?;
    String::from_utf8(bytes).ok()
}
