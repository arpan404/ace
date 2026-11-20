// SPDX-License-Identifier: Apache-2.0

//! Ignore rules inherited from the folders above a checkout root.
//!
//! A checkout root is often a subfolder of a git repository, and git applies the `.gitignore`
//! files of the folders between the repository's top and the root. Reading them as a fallback
//! keeps a search from showing files git would ignore, without ever reaching above the repository.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use ignore::gitignore::{Gitignore, GitignoreBuilder};

/// The `.gitignore` rules of the folders between the enclosing repository's top and the root.
pub(crate) struct Inherited {
    /// The checkout root; rules are read from here down, never above it.
    root: PathBuf,
    /// One matcher per folder, from the repository's top down to the root's parent.
    matchers: Vec<Gitignore>,
    /// `.gitignore` matchers built on demand for folders inside the root.
    inside: Mutex<HashMap<PathBuf, Option<Arc<Gitignore>>>>,
}

impl Inherited {
    /// Reads the rules git would apply from above `root`.
    ///
    /// A root outside a repository inherits nothing: without a folder holding `.git` there is no
    /// way to tell another checkout's rules from this one's, so the search stops at the root.
    pub(crate) fn find(root: &Path) -> Inherited {
        let mut matchers = Vec::new();
        if let Some(folders) = repository_to(root) {
            for folder in folders {
                if let Some(matcher) = read(&folder) {
                    matchers.push(matcher);
                }
            }
        }
        Inherited {
            root: root.to_path_buf(),
            matchers,
            inside: Mutex::new(HashMap::new()),
        }
    }

    /// Whether rules from above `root` exclude `path`.
    ///
    /// A folder ignored up there is excluded outright, because git never looks inside it. A file
    /// is excluded unless a `.gitignore` between the root and that file's folder re-includes it,
    /// which is the precedence git gives deeper files.
    pub(crate) fn ignores(&self, path: &Path, is_dir: bool) -> bool {
        if !self.excluded_above(path, is_dir) {
            return false;
        }
        if is_dir {
            return true;
        }
        !self.reincluded(path)
    }

    /// Whether the inherited matchers exclude `path`, the deepest folder's rules winning.
    fn excluded_above(&self, path: &Path, is_dir: bool) -> bool {
        for matcher in self.matchers.iter().rev() {
            match matcher.matched(path, is_dir) {
                ignore::Match::Ignore(_) => return true,
                ignore::Match::Whitelist(_) => return false,
                ignore::Match::None => {}
            }
        }
        false
    }

    /// Whether a `.gitignore` inside the root re-includes a file its parents exclude.
    fn reincluded(&self, path: &Path) -> bool {
        let mut folder = path.parent();
        while let Some(dir) = folder {
            if let Some(matcher) = self.rules_inside(dir) {
                match matcher.matched(path, false) {
                    ignore::Match::Ignore(_) => return false,
                    ignore::Match::Whitelist(_) => return true,
                    ignore::Match::None => {}
                }
            }
            if dir == self.root {
                break;
            }
            folder = dir.parent();
        }
        false
    }

    /// The matcher for one folder inside the root, built once and kept.
    fn rules_inside(&self, dir: &Path) -> Option<Arc<Gitignore>> {
        let mut inside = match self.inside.lock() {
            Ok(inside) => inside,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(matcher) = inside.get(dir) {
            return matcher.clone();
        }
        let matcher = read(dir).map(Arc::new);
        inside.insert(dir.to_path_buf(), matcher.clone());
        matcher
    }
}

/// The folders from the enclosing repository's top down to `root`'s parent, if there is one.
fn repository_to(root: &Path) -> Option<Vec<PathBuf>> {
    let mut folders = Vec::new();
    for folder in root.ancestors().skip(1) {
        folders.push(folder.to_path_buf());
        if folder.join(".git").exists() {
            folders.reverse();
            return Some(folders);
        }
    }
    None
}

/// The `.gitignore` rules of one folder, if it has any that parse.
///
/// The file is read only when it is a regular file of that folder: it is opened without following
/// a link, so a `.gitignore` that is a link never brings in rules from somewhere else.
fn read(folder: &Path) -> Option<Gitignore> {
    use std::io::Read;

    use cap_fs_ext::{FollowSymlinks, OpenOptions, OpenOptionsFollowExt};

    let dir = cap_std::fs::Dir::open_ambient_dir(folder, cap_std::ambient_authority()).ok()?;
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let mut file = dir.open_with(GITIGNORE, &options).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut text = String::new();
    file.read_to_string(&mut text).ok()?;
    let from = folder.join(GITIGNORE);
    let mut builder = GitignoreBuilder::new(folder);
    for line in text.lines() {
        let _ = builder.add_line(Some(from.clone()), line);
    }
    builder.build().ok()
}

/// The name of a folder's ignore file.
const GITIGNORE: &str = ".gitignore";
