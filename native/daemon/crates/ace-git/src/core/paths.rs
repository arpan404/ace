// SPDX-License-Identifier: Apache-2.0
//! Root discovery and its cache, and the containment rule every lease uses
//! (`repository-paths.ts`, `Repository.root`, `Repository.serial`'s canonical
//! key). Ported from `packages/git/src/repository-paths.ts` and
//! `packages/git/src/repository.ts` (G2b).

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use crate::core::error::{GitError, GitErrorCode};

/// `Repository.serial`'s key and every journal path: the canonical root.
///
/// Node's `realpath` and this agree on POSIX. On Windows Node answers a drive
/// path where `std::fs::canonicalize` answers a verbatim `\\?\` path, so the
/// prefix is stripped here, including the `UNC\` form.
pub fn canonical(path: &str) -> Result<String, std::io::Error> {
    let resolved = std::fs::canonicalize(path)?;
    Ok(display_path(&resolved))
}

/// A canonical path as a JavaScript string: UTF-8 bytes, verbatim prefixes removed on Windows.
pub fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return rest.to_owned();
        }
    }
    text
}

/// Node's `path.resolve` for an already-absolute base: join, then normalise.
pub fn resolve(base: &str, path: &str) -> String {
    let joined = Path::new(base).join(path);
    normalise(&joined)
}

/// Lexical normalisation, as Node's `path.normalize` does: `.` and `..` are
/// folded, repeated separators collapse, and a `..` above a root stays at it.
pub fn normalise(path: &Path) -> String {
    let mut parts: Vec<Component<'_>> = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match parts.last() {
                Some(Component::Normal(_)) => {
                    parts.pop();
                }
                Some(Component::RootDir) | Some(Component::Prefix(_)) => {}
                _ => parts.push(component),
            },
            other => parts.push(other),
        }
    }
    let mut out = PathBuf::new();
    for part in parts {
        out.push(part.as_os_str());
    }
    display_path(&out)
}

/// `within(parent, path)`: `path` is `parent` or lies inside it. The answer
/// TypeScript's `path.relative` gives: empty, or a relative path that is not
/// `..` and does not start with `../`.
pub fn within(parent: &str, path: &str) -> bool {
    let parent = normalise(Path::new(parent));
    let path = normalise(Path::new(path));
    if parent == path {
        return true;
    }
    // A differently rooted path (another Windows drive) is never inside.
    match Path::new(&path).strip_prefix(Path::new(&parent)) {
        Ok(relative) => !matches!(
            relative.components().next(),
            Some(Component::ParentDir) | Some(Component::RootDir) | Some(Component::Prefix(_))
        ),
        Err(_) => false,
    }
}

/// The registered checkout that contains `cwd`: the deepest of the real paths,
/// as `Repository.discoverRoot` picks it. `None` when no checkout contains it.
pub fn containing_checkout<'a>(checkouts: &'a [String], cwd: &str) -> Option<&'a String> {
    checkouts
        .iter()
        .filter(|checkout| within(checkout, cwd))
        .max_by_key(|checkout| checkout.len())
}

/// `Repository.root`'s cache. Only a checkout that is its own root is kept: a
/// deeper path's root also depends on the worktree registry, so it is asked
/// again. G2c's config-fact stamps decide when an entry is stale; here the
/// caller drops it when the `.git` entry it was read from changes.
#[derive(Default)]
pub struct RootCache {
    roots: Mutex<HashMap<String, String>>,
}

impl RootCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// The remembered root for `cwd`, when the checkout is that same directory.
    pub fn get(&self, cwd: &str) -> Option<String> {
        self.roots
            .lock()
            .ok()
            .and_then(|roots| roots.get(cwd).cloned())
    }

    /// Remembers `root` for `cwd` only when the checkout root is the directory itself.
    pub fn remember(&self, cwd: &str, root: &str) {
        if cwd != root {
            return;
        }
        if let Ok(mut roots) = self.roots.lock() {
            roots.insert(cwd.to_owned(), root.to_owned());
        }
    }

    pub fn forget(&self, cwd: &str) {
        if let Ok(mut roots) = self.roots.lock() {
            roots.remove(cwd);
        }
    }
}

/// `Repository.serial`'s canonical key, with the error a caller sees for a path
/// that is not there: `not_a_repo`, never a raw filesystem error.
pub fn serial_key(root: &str) -> Result<String, GitError> {
    canonical(root).map_err(|_| not_a_repo(root))
}

pub fn not_a_repo(path: &str) -> GitError {
    GitError::new(
        GitErrorCode::NotARepo,
        format!("Repository path does not exist: {path}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_checkout_contains_its_own_directory_and_everything_below_it() {
        assert!(within("/repos/ace", "/repos/ace"));
        assert!(within("/repos/ace", "/repos/ace/packages/git"));
        assert!(!within("/repos/ace", "/repos/ace-other"));
        assert!(!within("/repos/ace", "/repos"));
        assert!(within("/repos/ace/packages", "/repos/ace/packages"));
    }

    #[test]
    fn containment_folds_dot_and_dot_dot_segments_like_path_relative() {
        assert!(within("/repos/ace", "/repos/ace/./packages/../packages/git"));
        assert!(!within("/repos/ace", "/repos/ace/../ace-other"));
        assert!(within("/repos/ace/", "/repos/ace/packages"));
    }

    #[test]
    fn the_deepest_registered_checkout_containing_a_path_is_its_root() {
        let checkouts = vec![
            "/repos/ace".to_owned(),
            "/repos/ace/packages/git".to_owned(),
            "/elsewhere".to_owned(),
        ];
        assert_eq!(
            containing_checkout(&checkouts, "/repos/ace/packages/git/src").map(String::as_str),
            Some("/repos/ace/packages/git")
        );
        assert_eq!(
            containing_checkout(&checkouts, "/repos/ace/packages/rust").map(String::as_str),
            Some("/repos/ace")
        );
        assert_eq!(containing_checkout(&checkouts, "/tmp"), None);
    }

    #[test]
    fn a_deeper_paths_root_is_not_remembered_but_a_checkouts_own_is() {
        let cache = RootCache::new();
        cache.remember("/repos/ace/packages/git", "/repos/ace");
        assert_eq!(cache.get("/repos/ace/packages/git"), None);
        cache.remember("/repos/ace", "/repos/ace");
        assert_eq!(cache.get("/repos/ace").as_deref(), Some("/repos/ace"));
        cache.forget("/repos/ace");
        assert_eq!(cache.get("/repos/ace"), None);
    }

    #[test]
    fn a_missing_root_is_not_a_repo_rather_than_a_filesystem_error() {
        let error = serial_key("/nonexistent/ace-g2b/root").expect_err("missing root");
        assert_eq!(error.code, GitErrorCode::NotARepo);
    }
}
