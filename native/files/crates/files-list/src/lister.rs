// SPDX-License-Identifier: Apache-2.0

//! One lister per checkout: it answers folder listings and stats, and remembers what it read.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use files_safe::Root;

use crate::cursor::Cursor;
use crate::entry::{Entry, Kind, kind_of, millis, size_of};
use crate::error::Error;
use crate::hide::Hidden;
use crate::page::{ListOptions, Page};
use crate::rules::Rules;
use crate::snapshot::{self, Snapshot};

/// The most entries one page may hold.
const MAX_LIMIT: usize = 5000;
/// Folder rule chains kept before the cache is dropped. Rebuilding one costs a few file reads.
const MAX_CACHED_RULES: usize = 256;
/// Folder listings kept before the cache is dropped, which is several screens of folders.
const MAX_CACHED_SNAPSHOTS: usize = 64;

/// Lists folders under one checkout root.
///
/// It is `Send + Sync` and holds no handles of its own beyond the root, so every thread that
/// serves the same checkout shares one. Cached folder listings are dropped when the folder
/// changes, and `invalidate` drops them early when the daemon knows better.
pub struct Lister {
    root: Root,
    rules: RwLock<HashMap<String, Arc<Rules>>>,
    snapshots: RwLock<HashMap<String, Arc<Snapshot>>>,
}

impl Lister {
    /// Wraps a root; nothing is read until the first request.
    pub fn new(root: Root) -> Lister {
        Lister {
            root,
            rules: RwLock::new(HashMap::new()),
            snapshots: RwLock::new(HashMap::new()),
        }
    }

    /// Lists one page of the folder `dir` (empty for the root).
    ///
    /// A cursor from another call is only honoured while the folder holds the same entries it
    /// held then; otherwise it is `INVALID_CURSOR` and the caller starts again from the top.
    pub fn list(&self, dir: &str, options: &ListOptions) -> Result<Page, Error> {
        if options.limit == 0 || options.limit > MAX_LIMIT {
            return Err(Error::InvalidArgument(format!(
                "limit {} is outside 1..={MAX_LIMIT}",
                options.limit
            )));
        }
        Root::check(dir)?;
        let cursor = match options.cursor.as_deref() {
            None => None,
            Some(text) => Some(
                Cursor::decode(text)
                    .ok_or_else(|| Error::InvalidCursor(format!("not a listing cursor: {text}")))?,
            ),
        };
        let hidden = Hidden::build(self.root.path(), &options.hide)?;
        let rules = self.rules_for(dir)?;
        let snapshot = self.snapshot(dir, &rules, &hidden)?;
        let total = snapshot.total();
        let offset = match cursor {
            None => 0,
            Some(cursor) => {
                if cursor.stamp != snapshot.stamp || cursor.count != total as u64 {
                    return Err(Error::InvalidCursor(format!(
                        "folder {dir:?} changed since the cursor was handed out"
                    )));
                }
                let offset = usize::try_from(cursor.offset).map_err(|_| {
                    Error::InvalidCursor(format!("offset {} is too large", cursor.offset))
                })?;
                if offset > total {
                    return Err(Error::InvalidCursor(format!(
                        "offset {offset} is past the {total} entries of {dir:?}"
                    )));
                }
                offset
            }
        };
        let end = offset.saturating_add(options.limit).min(total);
        let next_cursor = (end < total).then(|| {
            Cursor {
                stamp: snapshot.stamp,
                count: total as u64,
                offset: end as u64,
            }
            .encode()
        });
        Ok(Page {
            entries: snapshot.entries(offset..end),
            next_cursor,
            total,
        })
    }

    /// Reports one entry, following nothing: a symlink reports what it points at.
    pub fn stat(&self, path: &str) -> Result<Entry, Error> {
        Root::check(path)?;
        if path.is_empty() {
            return Err(Error::Path(files_safe::Error::InvalidPath(String::new())));
        }
        let (parent, name) = split_leaf(path);
        let parent_abs = self.root.resolve(parent)?;
        let metadata = std::fs::symlink_metadata(parent_abs.join(name))?;
        let file_type = metadata.file_type();
        let kind = if file_type.is_symlink() {
            symlink_kind(&self.root, path)
        } else {
            kind_of(&file_type)
        };
        let rules = self.rules_for(parent)?;
        let is_dir = matches!(kind, Kind::Directory);
        Ok(Entry {
            ignored: rules.folder_ignored() || rules.ignored(name, is_dir),
            path: path.to_owned(),
            name: name.to_owned(),
            size: size_of(&metadata, &kind),
            mtime_ms: metadata.modified().map(millis).unwrap_or(0),
            kind,
        })
    }

    /// Forgets the rules and listings cached for `dirs` and everything below them. Empty string
    /// clears everything.
    pub fn invalidate(&self, dirs: &[&str]) {
        for dir in dirs {
            if let Ok(mut rules) = self.rules.write() {
                rules.retain(|key, _| !is_within(key, dir));
            }
            if let Ok(mut snapshots) = self.snapshots.write() {
                snapshots.retain(|key, _| !is_within(key, dir));
            }
        }
    }

    /// The ignore chain for `dir`, built from its parent's chain and cached.
    fn rules_for(&self, dir: &str) -> Result<Arc<Rules>, Error> {
        if let Some(cached) = self
            .rules
            .read()
            .ok()
            .and_then(|rules| rules.get(dir).cloned())
        {
            return Ok(cached);
        }
        let rules = if dir.is_empty() {
            Rules::root(&self.root)
        } else {
            let (parent, name) = split_leaf(dir);
            self.rules_for(parent)?.child(name)
        };
        let rules = Arc::new(rules);
        if let Ok(mut cache) = self.rules.write() {
            if cache.len() >= MAX_CACHED_RULES {
                cache.clear();
            }
            cache.insert(dir.to_owned(), Arc::clone(&rules));
        }
        Ok(rules)
    }

    /// The listing of `dir`, re-read when the folder or the hide patterns changed.
    fn snapshot(&self, dir: &str, rules: &Rules, hidden: &Hidden) -> Result<Arc<Snapshot>, Error> {
        let abs = self.root.resolve(dir)?;
        let metadata = std::fs::metadata(&abs)?;
        if !metadata.is_dir() {
            return Err(Error::NotDirectory(dir.to_owned()));
        }
        let stamp = snapshot::stamp(&metadata);
        let hide = hidden.fingerprint();
        if let Some(cached) = self
            .snapshots
            .read()
            .ok()
            .and_then(|map| map.get(dir).cloned())
            && cached.stamp == stamp
            && cached.hide == hide
        {
            return Ok(cached);
        }
        let fresh = Arc::new(snapshot::read(&self.root, dir, &abs, stamp, rules, hidden)?);
        if let Ok(mut cache) = self.snapshots.write() {
            if cache.len() >= MAX_CACHED_SNAPSHOTS && !cache.contains_key(dir) {
                cache.clear();
            }
            cache.insert(dir.to_owned(), Arc::clone(&fresh));
        }
        Ok(fresh)
    }
}

/// A symlink's target kind, but only while the target is inside the root.
fn symlink_kind(root: &Root, path: &str) -> Kind {
    match root
        .resolve(path)
        .ok()
        .and_then(|abs| std::fs::metadata(abs).ok())
    {
        Some(metadata) => Kind::Symlink {
            target: Some(Box::new(kind_of(&metadata.file_type()))),
        },
        None => Kind::Symlink { target: None },
    }
}

/// `"a/b"` becomes `("a", "b")`, and `"b"` becomes `("", "b")`.
fn split_leaf(path: &str) -> (&str, &str) {
    match path.rfind('/') {
        Some(index) => (&path[..index], &path[index + 1..]),
        None => ("", path),
    }
}

/// Whether `key` is `dir` or a folder inside it.
fn is_within(key: &str, dir: &str) -> bool {
    dir.is_empty()
        || key == dir
        || key
            .strip_prefix(dir)
            .is_some_and(|rest| rest.starts_with('/'))
}
