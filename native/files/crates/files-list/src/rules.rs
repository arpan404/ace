// SPDX-License-Identifier: Apache-2.0

//! Git's ignore rules for one folder, as a chain of matchers.
//!
//! A checkout root can be a subfolder of a repository, so the chain starts at the repository top
//! (the folder holding `.git`), not at the root: every `.gitignore` from there down, the
//! repository's `.git/info/exclude`, and the global excludes file all apply, and nothing above the
//! repository top does. Matching walks the chain from the deepest folder up, so the closest
//! `.gitignore` decides last, exactly as git does. Chains are cached per folder because building
//! one costs one file read per level.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use files_safe::Root;
use ignore::Match;
use ignore::gitignore::{Gitignore, GitignoreBuilder};

use crate::git;

/// One matcher and how many path segments from the chain top name the folder holding it.
#[derive(Clone)]
struct Rule {
    matcher: Arc<Gitignore>,
    depth: usize,
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
    /// The rules for the root, built from the repository top down.
    pub(crate) fn root(root: &Root) -> Rules {
        let abs = root.path().to_path_buf();
        let repository = git::repository(&abs);
        let (top, git_dir) = match repository {
            Some((top, git_dir)) => (top, Some(git_dir)),
            None => (abs.clone(), None),
        };
        let segments = segments_between(&top, &abs);

        let mut rules = Vec::new();
        let global = global_matcher(&top, git_dir.as_deref().unwrap_or(&top));
        if !global.is_empty() {
            rules.push(Rule {
                matcher: Arc::new(global),
                depth: 0,
            });
        }
        if let Some(git_dir) = &git_dir {
            push_rule(&mut rules, git::info_exclude(git_dir), &top, 0);
        }
        push_folder_rule(&mut rules, &top, 0);

        let mut folder_ignored = false;
        let mut dir = top;
        for (level, segment) in segments.iter().enumerate() {
            if matches(&rules, &segments[..level], segment, true) {
                folder_ignored = true;
            }
            dir.push(segment);
            push_folder_rule(&mut rules, &dir, level + 1);
        }

        Rules {
            dir: String::new(),
            abs,
            segments,
            rules,
            folder_ignored,
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

/// Adds one ignore file built from a single file at `depth`, if it contributes any pattern.
fn push_rule(rules: &mut Vec<Rule>, file: Option<PathBuf>, root: &Path, depth: usize) {
    let Some(file) = file else {
        return;
    };
    let mut builder = GitignoreBuilder::new(root);
    let _ = builder.add(file);
    let matcher = builder.build().unwrap_or_else(|_| Gitignore::empty());
    if !matcher.is_empty() {
        rules.push(Rule {
            matcher: Arc::new(matcher),
            depth,
        });
    }
}

/// Adds a folder's own `.gitignore`, if it has one. A partly broken file contributes the patterns
/// it does contain, which is what git does.
fn push_folder_rule(rules: &mut Vec<Rule>, abs: &Path, depth: usize) {
    push_rule(rules, Some(abs.join(".gitignore")), abs, depth);
}

/// `core.excludesFile` from the repository's config when it sets one, otherwise git's global
/// excludes file (which `ignore` finds through the global config and the XDG default).
fn global_matcher(top: &Path, git_dir: &Path) -> Gitignore {
    match git::excludes_file(git_dir, top) {
        Some(path) => {
            let mut builder = GitignoreBuilder::new(top);
            let _ = builder.add(path);
            builder.build().unwrap_or_else(|_| Gitignore::empty())
        }
        None => GitignoreBuilder::new(top).build_global().0,
    }
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
