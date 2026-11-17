// SPDX-License-Identifier: Apache-2.0

//! Git's ignore rules for one folder, as a chain of matchers.
//!
//! A checkout root can be a subfolder of a repository, so the chain starts at the repository top
//! (the folder holding `.git`), not at the root: every `.gitignore` from there down, the
//! repository's `.git/info/exclude`, and the global excludes file all apply, and nothing above the
//! repository top does. A folder that holds its own `.git` starts a fresh chain, because a nested
//! repository or submodule is a repository of its own.
//!
//! Matching walks the chain from the deepest folder up, so the closest `.gitignore` decides last,
//! exactly as git does. Chains are cached per folder, and every ignore file's mtime and size is
//! remembered so an edit in place is noticed the next time the chain is used.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use files_safe::Root;
use ignore::Match;
use ignore::gitignore::{Gitignore, GitignoreBuilder};

use crate::git;
use crate::stamp::nanos_since_epoch;

/// One ignore file and the mtime and size it had when it was read.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Source {
    path: PathBuf,
    /// `None` when the file does not exist, which is a state worth noticing too: creating it must
    /// change the flags.
    stamp: Option<FileStamp>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    mtime_ns: u128,
    size: u64,
}

impl Source {
    fn of(path: PathBuf) -> Source {
        let stamp = FileStamp::of(&path);
        Source { path, stamp }
    }

    fn is_current(&self) -> bool {
        FileStamp::of(&self.path) == self.stamp
    }
}

impl FileStamp {
    fn of(path: &Path) -> Option<FileStamp> {
        let metadata = std::fs::metadata(path).ok()?;
        Some(FileStamp {
            mtime_ns: metadata.modified().ok().map_or(0, nanos_since_epoch),
            size: metadata.len(),
        })
    }
}

/// One matcher and how many path segments from the chain top name the folder holding it.
#[derive(Clone)]
struct Rule {
    matcher: Arc<Gitignore>,
    depth: usize,
    source: Option<Source>,
}

/// The matchers that apply to the entries of one folder.
pub(crate) struct Rules {
    dir: String,
    abs: PathBuf,
    /// Path segments from the chain top down to this folder.
    segments: Vec<String>,
    /// Ascending precedence, as git applies them.
    rules: Vec<Rule>,
    folder_ignored: bool,
}

impl Rules {
    /// The rules for the checkout root.
    pub(crate) fn root(root: &Root) -> Rules {
        Rules::build("", root.path())
    }

    /// The rules for the folder `name` directly inside these rules' folder.
    pub(crate) fn child(&self, name: &str) -> Rules {
        let dir = if self.dir.is_empty() {
            name.to_owned()
        } else {
            format!("{}/{name}", self.dir)
        };
        let abs = self.abs.join(name);
        if holds_git(&abs) {
            return Rules::build(&dir, &abs);
        }

        let mut segments = self.segments.clone();
        segments.push(name.to_owned());
        let mut rules = self.rules.clone();
        push_folder_rule(&mut rules, &abs, segments.len());
        let folder_ignored = self.folder_ignored || self.ignored(name, true);
        Rules {
            dir,
            abs,
            segments,
            rules,
            folder_ignored,
        }
    }

    /// Whether every ignore file in the chain still has the mtime and size it was built from.
    pub(crate) fn is_current(&self) -> bool {
        self.rules
            .iter()
            .all(|rule| rule.source.as_ref().is_none_or(Source::is_current))
    }

    /// Whether the folder these rules describe is itself ignored by a parent. Git cannot re-include
    /// anything inside an ignored folder, so every entry under it is ignored too.
    pub(crate) fn folder_ignored(&self) -> bool {
        self.folder_ignored
    }

    /// Whether the entry `name` directly inside this folder is ignored.
    ///
    /// `is_dir` matches git, which treats symlinks as files whatever they point at.
    pub(crate) fn ignored(&self, name: &str, is_dir: bool) -> bool {
        matches(&self.rules, &self.segments, name, is_dir)
    }

    /// Builds the chain for `abs`, which is the folder `dir` under the checkout root.
    fn build(dir: &str, abs: &Path) -> Rules {
        let repository = git::repository(abs);
        let (top, common_dir) = match repository {
            Some(repository) => (repository.top, Some(repository.common_dir)),
            None => (abs.to_path_buf(), None),
        };
        let segments = segments_between(&top, abs);

        let mut rules = Vec::new();
        let excludes = common_dir
            .as_deref()
            .and_then(|common_dir| git::excludes_file(common_dir, &top))
            .or_else(git::global_excludes);
        if let Some(path) = excludes {
            push_rule(&mut rules, path, &top, 0);
        }
        if let Some(common_dir) = &common_dir {
            push_rule(&mut rules, common_dir.join("info").join("exclude"), &top, 0);
        }
        push_folder_rule(&mut rules, &top, 0);

        let mut folder_ignored = false;
        let mut current = top;
        for (level, segment) in segments.iter().enumerate() {
            if matches(&rules, &segments[..level], segment, true) {
                folder_ignored = true;
            }
            current.push(segment);
            push_folder_rule(&mut rules, &current, level + 1);
        }

        Rules {
            dir: dir.to_owned(),
            abs: abs.to_path_buf(),
            segments,
            rules,
            folder_ignored,
        }
    }
}

/// Whether `abs` holds a `.git` entry, which makes it the top of its own repository.
fn holds_git(abs: &Path) -> bool {
    std::fs::symlink_metadata(abs.join(".git")).is_ok()
}

/// Whether `name`, directly inside the folder named by `segments`, is ignored.
fn matches(rules: &[Rule], segments: &[String], name: &str, is_dir: bool) -> bool {
    let mut candidate = String::new();
    for rule in rules.iter().rev() {
        let path: &str = if rule.depth == segments.len() {
            name
        } else {
            candidate.clear();
            for segment in &segments[rule.depth..] {
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

/// Adds the matcher for one ignore file and remembers the file's identity. A missing or partly
/// broken file contributes the patterns it does contain, which is what git does.
fn push_rule(rules: &mut Vec<Rule>, path: PathBuf, root: &Path, depth: usize) {
    let mut builder = GitignoreBuilder::new(root);
    let _ = builder.add(&path);
    let matcher = builder.build().unwrap_or_else(|_| Gitignore::empty());
    rules.push(Rule {
        matcher: Arc::new(matcher),
        depth,
        source: Some(Source::of(path)),
    });
}

/// Adds a folder's own `.gitignore`.
fn push_folder_rule(rules: &mut Vec<Rule>, abs: &Path, depth: usize) {
    push_rule(rules, abs.join(".gitignore"), abs, depth);
}

/// The path from `top` down to `abs`, as plain segments.
fn segments_between(top: &Path, abs: &Path) -> Vec<String> {
    let Ok(rest) = abs.strip_prefix(top) else {
        return Vec::new();
    };
    rest.iter()
        .filter_map(|part| part.to_str().map(str::to_owned))
        .collect()
}
