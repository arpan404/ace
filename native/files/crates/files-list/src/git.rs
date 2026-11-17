// SPDX-License-Identifier: Apache-2.0

//! Finds the ignore files git itself would read for a checkout.
//!
//! Everything here is best effort: a checkout without git, an unreadable config or an unknown
//! config value means "no such file", never a failed listing.

use std::io::Read;
use std::path::{Path, PathBuf};

/// Config files are read up to this much; anything longer is not a git config ace cares about.
const MAX_CONFIG_BYTES: u64 = 64 * 1024;

/// The repository's git directory, following the `.git` file that worktrees and submodules use.
pub(crate) fn git_dir(root: &Path) -> Option<PathBuf> {
    let dot = root.join(".git");
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
        root.join(path)
    })
}

/// `<git-dir>/info/exclude`, which git applies to every repository but never commits.
pub(crate) fn info_exclude(root: &Path) -> Option<PathBuf> {
    let path = git_dir(root)?.join("info").join("exclude");
    path.is_file().then_some(path)
}

/// The file named by `core.excludesFile` in the repository's own config, when it sets one.
pub(crate) fn excludes_file(root: &Path) -> Option<PathBuf> {
    let config = read_bounded(&git_dir(root)?.join("config"))?;
    let value = parse_core_excludes_file(&config)?;
    resolve_path(&value, root)
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

/// Git expands a leading `~/`; a relative value is taken from the checkout root.
fn resolve_path(value: &str, root: &Path) -> Option<PathBuf> {
    if let Some(rest) = value.strip_prefix("~/") {
        let home = std::env::var_os("HOME")?;
        return Some(PathBuf::from(home).join(rest));
    }
    let path = Path::new(value);
    Some(if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    })
}

fn read_bounded(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG_BYTES).read_to_end(&mut bytes).ok()?;
    String::from_utf8(bytes).ok()
}
