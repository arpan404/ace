// SPDX-License-Identifier: Apache-2.0

//! Path rules: Node's `path.resolve` for absolute paths, and `contains` from
//! `@ace/native-session`, both lexical.

use std::path::{Component, Path, PathBuf};

/// `path.resolve(path)` for an absolute path: `.` and `..` folded, no symlinks followed.
pub fn resolve(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                if out.parent().is_some() {
                    out.pop();
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn key(path: &Path) -> PathBuf {
    let resolved = resolve(path);
    if cfg!(windows) {
        PathBuf::from(resolved.to_string_lossy().to_lowercase())
    } else {
        resolved
    }
}

/// Whether `path` is `root` or inside it.
pub fn contains(root: &Path, path: &Path) -> bool {
    key(path).starts_with(key(root))
}

/// `path.basename(path, suffix)`.
pub fn basename(path: &Path, suffix: &str) -> String {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    match name.strip_suffix(suffix) {
        Some(stem) if !stem.is_empty() && !suffix.is_empty() => stem.to_owned(),
        _ => name,
    }
}

/// The path as the string the catalog stores.
pub fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
