// SPDX-License-Identifier: Apache-2.0

//! One lister per checkout: it answers folder listings and stats, and remembers what it read.

use std::sync::{Arc, Mutex};

use crate::cache::Lru;

use files_safe::Root;

use crate::clock::{Clock, SystemClock};
use crate::cursor::Cursor;
use crate::entry::{Entry, Kind, kind_of, millis, size_of};
use crate::error::Error;
use crate::hide::Hidden;
use crate::page::{ListOptions, Page};
use crate::rules::Rules;
use crate::snapshot::{self, Snapshot};
use crate::stamp::Stamp;

/// The most entries one page may hold.
const MAX_LIMIT: usize = 5000;
/// Folder listings kept, measured in entries: one folder of 100,000 files costs as much as a
/// hundred small ones, so a count of folders would either waste memory or throw away the tree.
const MAX_CACHED_ENTRIES: usize = 500_000;
/// Ignore chains kept, one per folder; each costs a few file reads to rebuild.
const MAX_CACHED_CHAINS: usize = 512;

/// Lists folders under one checkout root.
///
/// It is `Send + Sync` and holds no handles of its own beyond the root, so every thread that
/// serves the same checkout shares one. Cached folder listings are dropped when the folder
/// changes, and `invalidate` drops them early when the daemon knows better.
pub struct Lister {
    root: Root,
    clock: Arc<dyn Clock>,
    rules: Mutex<Lru<Rules>>,
    snapshots: Mutex<Lru<Snapshot>>,
}

impl Lister {
    /// Wraps a root, reading the time from the system clock; nothing is read until the first
    /// request.
    pub fn new(root: Root) -> Lister {
        Lister::with_clock(root, Arc::new(SystemClock))
    }

    /// Wraps a root and a clock. Tests pass a clock they control so a folder they just wrote counts
    /// as settled instead of being inside the racy window.
    pub fn with_clock(root: Root, clock: Arc<dyn Clock>) -> Lister {
        Lister {
            root,
            clock,
            rules: Mutex::new(Lru::new(MAX_CACHED_CHAINS)),
            snapshots: Mutex::new(Lru::new(MAX_CACHED_ENTRIES)),
        }
    }

    /// Lists one page of the folder `dir` (empty for the root).
    ///
    /// A cursor from another call is only honoured while the folder holds the same entries it
    /// held then, and once the folder is past the racy window; otherwise it is `INVALID_CURSOR`
    /// and the caller starts again from the top.
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
                if snapshot.racy {
                    return Err(Error::InvalidCursor(format!(
                        "folder {dir:?} changed too recently to page through"
                    )));
                }
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
    ///
    /// The root itself is not an entry of anything, so the empty path is `INVALID_PATH`.
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
            self.forget(dir);
        }
    }

    /// The ignore chain for `dir`, built from its parent's chain and cached.
    ///
    /// A chain whose ignore files were edited in place is rebuilt, and the listings below it are
    /// dropped, so the next listing reports the new flags without anyone calling `invalidate`.
    fn rules_for(&self, dir: &str) -> Result<Arc<Rules>, Error> {
        if let Some(cached) = self.cached_rules(dir) {
            if cached.is_current() {
                return Ok(cached);
            }
            self.forget(dir);
        }
        let rules = if dir.is_empty() {
            Rules::root(&self.root)
        } else {
            let (parent, name) = split_leaf(dir);
            self.rules_for(parent)?.child(name)
        };
        let rules = Arc::new(rules);
        if let Ok(mut cache) = self.rules.lock() {
            cache.insert(dir, Arc::clone(&rules), 1);
        }
        Ok(rules)
    }

    /// Drops the rules and listings cached for `dir` and everything below it.
    fn forget(&self, dir: &str) {
        if let Ok(mut rules) = self.rules.lock() {
            rules.retain(|key| !is_within(key, dir));
        }
        if let Ok(mut snapshots) = self.snapshots.lock() {
            snapshots.retain(|key| !is_within(key, dir));
        }
    }

    fn cached_rules(&self, dir: &str) -> Option<Arc<Rules>> {
        self.rules.lock().ok().and_then(|mut cache| cache.get(dir))
    }

    fn cached_snapshot(&self, dir: &str) -> Option<Arc<Snapshot>> {
        self.snapshots
            .lock()
            .ok()
            .and_then(|mut cache| cache.get(dir))
    }

    /// The listing of `dir`, re-read when the folder or the hide patterns changed.
    fn snapshot(&self, dir: &str, rules: &Rules, hidden: &Hidden) -> Result<Arc<Snapshot>, Error> {
        let abs = self.root.resolve(dir)?;
        let metadata = std::fs::metadata(&abs)?;
        if !metadata.is_dir() {
            return Err(Error::NotDirectory(dir.to_owned()));
        }
        let stamp = Stamp::of(&metadata);
        let racy = stamp.is_racy(self.clock.now());
        let hide = hidden.fingerprint();
        if let Some(cached) = self.cached_snapshot(dir)
            && cached.stamp == stamp
            && cached.hide == hide
        {
            return Ok(cached);
        }
        let fresh = Arc::new(snapshot::read(
            &self.root, dir, &abs, stamp, racy, rules, hidden,
        )?);
        // A folder that changed within the racy window is not cached: its stamp cannot prove it
        // will look the same on the next call, so the next call reads it again.
        if !racy && let Ok(mut cache) = self.snapshots.lock() {
            cache.insert(dir, Arc::clone(&fresh), fresh.total());
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
