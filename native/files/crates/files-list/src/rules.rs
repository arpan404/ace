// SPDX-License-Identifier: Apache-2.0

//! Git's ignore rules for one folder, as a chain of matchers.
//!
//! Each folder holds one matcher built from its own `.gitignore`, and a folder's chain is its
//! parent's chain plus that matcher. Matching walks the chain from the deepest folder up, so the
//! closest `.gitignore` decides last, exactly as git does. Chains are cached per folder because
//! building one costs one file read per level.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use files_safe::Root;
use ignore::Match;
use ignore::gitignore::{Gitignore, GitignoreBuilder};

use crate::git;

/// One matcher and how many path segments name the folder whose patterns it holds.
#[derive(Clone)]
struct Rule {
    matcher: Arc<Gitignore>,
    depth: usize,
}

/// The matchers that apply to the entries of one folder.
pub(crate) struct Rules {
    dir: String,
    abs: PathBuf,
    segments: Vec<String>,
    rules: Vec<Rule>,
    folder_ignored: bool,
    active: bool,
}

impl Rules {
    /// The rules for the root: the global excludes file, then `.git/info/exclude`, then the root's
    /// own `.gitignore`, each later source winning over the earlier one.
    pub(crate) fn root(root: &Root) -> Rules {
        let abs = root.path().to_path_buf();
        let mut rules = Vec::new();

        let global = global_matcher(&abs);
        if !global.is_empty() {
            rules.push(Rule {
                matcher: Arc::new(global),
                depth: 0,
            });
        }

        let mut builder = GitignoreBuilder::new(&abs);
        if let Some(exclude) = git::info_exclude(&abs) {
            let _ = builder.add(exclude);
        }
        let _ = builder.add(abs.join(".gitignore"));
        let local = builder.build().unwrap_or_else(|_| Gitignore::empty());
        if !local.is_empty() {
            rules.push(Rule {
                matcher: Arc::new(local),
                depth: 0,
            });
        }

        let active = !rules.is_empty();
        Rules {
            dir: String::new(),
            abs,
            segments: Vec::new(),
            rules,
            folder_ignored: false,
            active,
        }
    }

    /// The rules for the folder `name` directly inside these rules' folder.
    pub(crate) fn child(&self, name: &str) -> Rules {
        let dir = if self.dir.is_empty() {
            name.to_owned()
        } else {
            format!("{}/{name}", self.dir)
        };
        let abs = self.abs.join(name);
        let matcher = folder_matcher(&abs);
        let added = !matcher.is_empty();
        let mut rules = self.rules.clone();
        if added {
            rules.push(Rule {
                matcher: Arc::new(matcher),
                depth: self.segments.len() + 1,
            });
        }
        let folder_ignored = self.folder_ignored || self.ignored(name, true);
        let mut segments = self.segments.clone();
        segments.push(name.to_owned());
        Rules {
            dir,
            abs,
            segments,
            rules,
            folder_ignored,
            active: self.active || added,
        }
    }

    /// Whether the folder these rules describe is itself ignored by one of its parents. Git cannot
    /// re-include anything inside an ignored folder, so every entry under it is ignored too.
    pub(crate) fn folder_ignored(&self) -> bool {
        self.folder_ignored
    }

    /// Whether the entry `name` directly inside this folder is ignored.
    ///
    /// `is_dir` matches git, which treats symlinks as files whatever they point at.
    pub(crate) fn ignored(&self, name: &str, is_dir: bool) -> bool {
        if !self.active {
            return false;
        }
        let mut candidate = String::new();
        for rule in self.rules.iter().rev() {
            let path: &str = if rule.depth == self.segments.len() {
                name
            } else {
                candidate.clear();
                for segment in &self.segments[rule.depth..] {
                    candidate.push_str(segment);
                    candidate.push('/');
                }
                candidate.push_str(name);
                &candidate
            };
            match rule.matcher.matched(path, is_dir) {
                Match::Ignore(_) => return true,
                Match::Whitelist(_) => return false,
                Match::None => {}
            }
        }
        false
    }
}

/// A folder's own `.gitignore`, if it has one. A missing or partly broken file contributes the
/// patterns it does contain, which is what git does.
fn folder_matcher(abs: &Path) -> Gitignore {
    let mut builder = GitignoreBuilder::new(abs);
    let _ = builder.add(abs.join(".gitignore"));
    builder.build().unwrap_or_else(|_| Gitignore::empty())
}

/// `core.excludesFile` from the repository's config when it sets one, otherwise git's global
/// excludes file (which `ignore` finds through the global config and the XDG default).
fn global_matcher(root: &Path) -> Gitignore {
    match git::excludes_file(root) {
        Some(path) => {
            let mut builder = GitignoreBuilder::new(root);
            let _ = builder.add(path);
            builder.build().unwrap_or_else(|_| Gitignore::empty())
        }
        None => GitignoreBuilder::new(root).build_global().0,
    }
}
