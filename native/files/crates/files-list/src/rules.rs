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
//!
//! Ignore files inside the checkout are read and stat'd through the root's handle; the ones above
//! a subfolder root, and the global excludes file, are the only paths read by name, because they
//! are outside what the handle reaches.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use files_safe::Root;
use ignore::Match;
use ignore::gitignore::{Gitignore, GitignoreBuilder};

use crate::git;
use crate::stamp::nanos_since_epoch;

/// Ignore files are read up to this much; a longer one is not a pattern file ace should trust.
const MAX_IGNORE_BYTES: u64 = 1024 * 1024;

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
    fn of(path: PathBuf, root: &Root) -> Source {
        let stamp = FileStamp::of(&path, root);
        Source { path, stamp }
    }

    fn is_current(&self, root: &Root) -> bool {
        FileStamp::of(&self.path, root) == self.stamp
    }
}

impl FileStamp {
    fn of(path: &Path, root: &Root) -> Option<FileStamp> {
        match root.relative(path) {
            // Inside the checkout: the root's handle stats it, so the name a caller wrote cannot
            // point somewhere else between the walk and the read.
            Some(rel) => {
                let metadata = root.dir().metadata(rel).ok()?;
                Some(FileStamp {
                    mtime_ns: metadata
                        .modified()
                        .ok()
                        .map_or(0, |time| nanos_since_epoch(time.into_std())),
                    size: metadata.len(),
                })
            }
            None => {
                let metadata = std::fs::metadata(path).ok()?;
                Some(FileStamp {
                    mtime_ns: metadata.modified().ok().map_or(0, nanos_since_epoch),
                    size: metadata.len(),
                })
            }
        }
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
        Rules::build("", root.path(), root)
    }

    /// The rules for the folder `name` directly inside these rules' folder.
    pub(crate) fn child(&self, name: &str, root: &Root) -> Rules {
        let dir = if self.dir.is_empty() {
            name.to_owned()
        } else {
            format!("{}/{name}", self.dir)
        };
        let abs = self.abs.join(name);
        if holds_git(&abs, root) {
            return Rules::build(&dir, &abs, root);
        }

        let mut segments = self.segments.clone();
        segments.push(name.to_owned());
        let mut rules = self.rules.clone();
        push_folder_rule(&mut rules, &abs, segments.len(), root);
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
    pub(crate) fn is_current(&self, root: &Root) -> bool {
        self.rules.iter().all(|rule| {
            rule.source
                .as_ref()
                .is_none_or(|source| source.is_current(root))
        })
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

    /// Builds the chain for `abs`, which is the folder `dir` under the checkout `root`.
    fn build(dir: &str, abs: &Path, root: &Root) -> Rules {
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
            push_rule(&mut rules, path, &top, 0, root);
        }
        if let Some(common_dir) = &common_dir {
            push_rule(
                &mut rules,
                common_dir.join("info").join("exclude"),
                &top,
                0,
                root,
            );
        }
        push_folder_rule(&mut rules, &top, 0, root);

        let mut folder_ignored = false;
        let mut current = top;
        for (level, segment) in segments.iter().enumerate() {
            if matches(&rules, &segments[..level], segment, true) {
                folder_ignored = true;
            }
            current.push(segment);
            push_folder_rule(&mut rules, &current, level + 1, root);
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
fn holds_git(abs: &Path, root: &Root) -> bool {
    FileStamp::of(&abs.join(".git"), root).is_some()
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
fn push_rule(rules: &mut Vec<Rule>, path: PathBuf, builder_root: &Path, depth: usize, root: &Root) {
    let mut builder = GitignoreBuilder::new(builder_root);
    if let Some(text) = read_ignore_file(root, &path) {
        add_patterns(&mut builder, &path, &text);
    }
    let matcher = builder.build().unwrap_or_else(|_| Gitignore::empty());
    rules.push(Rule {
        matcher: Arc::new(matcher),
        depth,
        source: Some(Source::of(path, root)),
    });
}

/// Adds a folder's own `.gitignore`.
fn push_folder_rule(rules: &mut Vec<Rule>, abs: &Path, depth: usize, root: &Root) {
    push_rule(rules, abs.join(".gitignore"), abs, depth, root);
}

/// Reads an ignore file: through the root's handle when it lives inside the checkout, by path
/// when it does not, which is the only way to reach the repository top above a subfolder root or
/// the global excludes file. A link that leads out of the root cannot be read through the handle,
/// so it contributes no patterns.
fn read_ignore_file(root: &Root, path: &Path) -> Option<String> {
    match root.relative(path) {
        Some(rel) => read_text(root.dir().open(rel).ok()?),
        None => read_text(std::fs::File::open(path).ok()?),
    }
}

fn read_text(file: impl Read) -> Option<String> {
    let mut bytes = Vec::new();
    file.take(MAX_IGNORE_BYTES).read_to_end(&mut bytes).ok()?;
    String::from_utf8(bytes).ok()
}

/// Feeds one file's lines to the builder, dropping a byte-order mark the way git does.
fn add_patterns(builder: &mut GitignoreBuilder, from: &Path, text: &str) {
    for (index, line) in text.lines().enumerate() {
        let line = if index == 0 {
            line.trim_start_matches('\u{feff}')
        } else {
            line
        };
        let _ = builder.add_line(Some(from.to_path_buf()), line);
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
