// SPDX-License-Identifier: Apache-2.0

//! Git's ignore rules as they apply to one root.
//!
//! Git reads a `.gitignore` per folder and the repository's `.git/info/exclude`, and the rule
//! closest to the path wins. A root inside a repository therefore sees the rules from the
//! repository top down to itself; a root outside one sees only its own, never its parent folders'
//! rules. This module keeps that chain so a path the watcher reports, or a folder an update walks
//! below the root, is judged the same way a full build judges it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use files_safe::Root;
use ignore::gitignore::{Gitignore, GitignoreBuilder};

/// The `.gitignore` files that apply to a root, plus the repository's `.git/info/exclude`.
#[derive(Debug)]
pub(crate) struct IgnoreRules {
    root: PathBuf,
    /// Deepest first: the root's own `.gitignore`, then each parent directory up to the top.
    chain: Vec<Gitignore>,
    exclude: Option<Gitignore>,
    /// Rules from folders inside the root, built the first time a path needs them.
    below: Mutex<HashMap<PathBuf, Option<Arc<Gitignore>>>>,
}

impl IgnoreRules {
    pub fn new(root: &Root) -> IgnoreRules {
        let root_path = root.path().to_path_buf();
        let top = repo_top(&root_path).map_or_else(|| root_path.clone(), Path::to_path_buf);
        let mut chain = Vec::new();
        let mut dir = root_path.clone();
        loop {
            chain.push(load(&dir));
            if dir == top {
                break;
            }
            match dir.parent() {
                Some(parent) => dir = parent.to_path_buf(),
                None => break,
            }
        }
        IgnoreRules {
            exclude: load_exclude(&top),
            root: root_path,
            chain,
            below: Mutex::new(HashMap::new()),
        }
    }

    /// Whether the rules exclude this path.
    ///
    /// `from_walk` says the path came from a walk that already applied every `.gitignore` from the
    /// walk start down, so only the rules the walk could not see (the root and its ancestors) are
    /// checked. A `.gitignore` inside the root can still pull a file back in that an ancestor file
    /// ignored, exactly as git allows; an excluded folder is never pulled back.
    pub fn ignored(&self, absolute: &Path, is_dir: bool, from_walk: bool) -> bool {
        match self.chain_decision(absolute, is_dir) {
            Some(true) => !matches!(self.deeper(absolute, is_dir), Some(false)),
            Some(false) => false,
            None => !from_walk && self.deeper(absolute, is_dir) == Some(true),
        }
    }

    /// Whether any `.gitignore` above the root contributes rules.
    pub fn has_ancestors(&self) -> bool {
        self.chain.len() > 1 || self.exclude.is_some()
    }

    /// The deepest rule that names this path or one of its parents, in the chain above the root.
    fn chain_decision(&self, absolute: &Path, is_dir: bool) -> Option<bool> {
        for layer in &self.chain {
            if let Some(decision) = decision(layer, absolute, is_dir) {
                return Some(decision);
            }
        }
        self.exclude
            .as_ref()
            .and_then(|exclude| decision(exclude, absolute, is_dir))
    }

    /// Rules from folders below the root, deepest first, built on demand.
    fn deeper(&self, absolute: &Path, is_dir: bool) -> Option<bool> {
        let mut dir = absolute.parent();
        while let Some(current) = dir {
            if current == self.root || !current.starts_with(&self.root) {
                break;
            }
            if let Some(layer) = self.local(current)
                && let Some(decision) = decision(&layer, absolute, is_dir)
            {
                return Some(decision);
            }
            dir = current.parent();
        }
        None
    }

    fn local(&self, dir: &Path) -> Option<Arc<Gitignore>> {
        let mut cache = match self.below.lock() {
            Ok(cache) => cache,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(cached) = cache.get(dir) {
            return cached.clone();
        }
        let matcher = load(dir);
        let value = (!matcher.is_empty()).then(|| Arc::new(matcher));
        cache.insert(dir.to_path_buf(), value.clone());
        value
    }
}

/// `Some(true)` means ignored, `Some(false)` means re-included.
fn decision(layer: &Gitignore, absolute: &Path, is_dir: bool) -> Option<bool> {
    let found = layer.matched_path_or_any_parents(absolute, is_dir);
    if found.is_ignore() {
        Some(true)
    } else if found.is_whitelist() {
        Some(false)
    } else {
        None
    }
}

/// The nearest folder at or above `start` that holds a `.git` entry.
pub(crate) fn repo_top(start: &Path) -> Option<&Path> {
    start.ancestors().find(|dir| dir.join(".git").exists())
}

fn load(dir: &Path) -> Gitignore {
    let file = dir.join(".gitignore");
    if !file.is_file() {
        return Gitignore::empty();
    }
    let mut builder = GitignoreBuilder::new(dir);
    builder.add(&file);
    builder.build().unwrap_or_else(|_| Gitignore::empty())
}

fn load_exclude(top: &Path) -> Option<Gitignore> {
    let file = top.join(".git/info/exclude");
    if !file.is_file() {
        return None;
    }
    let mut builder = GitignoreBuilder::new(top);
    builder.add(&file);
    builder.build().ok().filter(|matcher| !matcher.is_empty())
}
