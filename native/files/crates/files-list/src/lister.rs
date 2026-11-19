// SPDX-License-Identifier: Apache-2.0

//! One lister per checkout: it answers folder listings and stats, and remembers what it read.

use std::ops::Range;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use cap_std::fs::Dir;

use crate::cache::Lru;

use files_safe::Root;

use crate::clock::{Clock, SystemClock};
use crate::cursor::{Cursor, Pin, Resume, decode as decode_cursor};
use crate::entry::{Entry, Kind, kind_of, millis, size_of, symlink_kind};
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
    /// Listings a caller pinned for a multi-page traversal, by token.
    pinned: Mutex<Lru<Pinned>>,
    next_pin: AtomicU64,
}

/// One folder as a traversal first read it, kept until its pages are done.
enum Pinned {
    /// The whole listing, so every page is exactly what the traversal first read, even after the
    /// folder is renamed, deleted or edited.
    Listed {
        dir: String,
        /// The handle the listing was read through, so later pages never re-open the path.
        handle: Arc<Dir>,
        snapshot: Arc<Snapshot>,
    },
    /// A folder too large to keep in memory. Each page re-reads it through this handle, so the
    /// traversal stays bounded without ever handing out a cursor whose listing was not kept.
    Streamed {
        dir: String,
        handle: Arc<Dir>,
        rules: Arc<Rules>,
        hidden: Hidden,
    },
}

impl std::fmt::Debug for Pinned {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Pinned::Listed {
                dir,
                handle: _,
                snapshot,
            } => formatter
                .debug_struct("Listed")
                .field("dir", dir)
                .field("total", &snapshot.total())
                .finish(),
            Pinned::Streamed { dir, .. } => formatter
                .debug_struct("Streamed")
                .field("dir", dir)
                .finish(),
        }
    }
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
        Lister::with_clock_and_budget(root, clock, MAX_CACHED_ENTRIES)
    }

    /// Wraps a root, a clock and the number of listing entries memory may hold.
    ///
    /// The budget bounds both the folder cache and the listings pinned for a traversal: a folder
    /// larger than the budget is streamed page by page instead of being kept. Production uses the
    /// default; a test shrinks it so a folder too large to keep needs only a handful of files.
    pub fn with_clock_and_budget(root: Root, clock: Arc<dyn Clock>, entries: usize) -> Lister {
        Lister {
            root,
            clock,
            rules: Mutex::new(Lru::new(MAX_CACHED_CHAINS)),
            snapshots: Mutex::new(Lru::new(entries)),
            pinned: Mutex::new(Lru::new(entries)),
            next_pin: AtomicU64::new(1),
        }
    }

    /// Lists one page of the folder `dir` (empty for the root).
    ///
    /// A cursor from another call is only honoured while the folder holds the same entries it
    /// held then, and once the folder is past the racy window; otherwise it is `INVALID_CURSOR`
    /// and the caller starts again from the top.
    pub fn list(&self, dir: &str, options: &ListOptions) -> Result<Page, Error> {
        self.page(dir, options, false)
    }

    /// Lists one page of a traversal that pins `dir` for as long as it pages through it.
    ///
    /// A traversal that walks a whole checkout is not showing a person a folder: it must see
    /// every entry once, even when the folder changed a moment ago and keeps changing. The first
    /// page reads the folder and keeps that listing under a token; later pages read from it, so a
    /// folder inside the racy window or edited mid-walk cannot refuse the traversal's cursor or
    /// skip a file. The listing is dropped when its pages are done, or evicted past the cache cap.
    pub fn list_pinned(&self, dir: &str, options: &ListOptions) -> Result<Page, Error> {
        self.page(dir, options, true)
    }

    fn page(&self, dir: &str, options: &ListOptions, pinned: bool) -> Result<Page, Error> {
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
                decode_cursor(text)
                    .ok_or_else(|| Error::InvalidCursor(format!("not a listing cursor: {text}")))?,
            ),
        };
        if let Some(Resume::Pinned(pin)) = cursor {
            if !pinned {
                return Err(Error::InvalidCursor(
                    "this cursor belongs to a pinned traversal".into(),
                ));
            }
            let listing = self.pinned_listing(dir, &pin)?;
            return self.pinned_page(dir, &pin, options.limit, &listing);
        }
        let cursor = match cursor {
            None => None,
            Some(Resume::Folder(cursor)) => {
                if pinned {
                    // A traversal pages its own pinned listing, never a folder stamp cursor.
                    return Err(Error::InvalidCursor(
                        "a pinned traversal starts from the first page".into(),
                    ));
                }
                Some(cursor)
            }
            Some(Resume::Pinned(_)) => None,
        };
        let hidden = Hidden::build(self.root.path(), &options.hide)?;
        let handle = self.root.open_dir(dir)?;
        let rules = self.rules_for(dir)?;
        let snapshot = self.snapshot(dir, &handle, &rules, &hidden)?;
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
        let next_cursor = if end < total {
            if pinned {
                let token = self.next_pin.fetch_add(1, Ordering::Relaxed);
                // The listing keeps the handle it was read through, so a folder renamed or
                // deleted after this page still answers the pages that follow.
                let held = Arc::new(handle.try_clone()?);
                self.pin(dir, token, held, &snapshot, rules, hidden)?;
                Some(
                    Pin {
                        token,
                        offset: end as u64,
                    }
                    .encode(),
                )
            } else {
                Some(
                    Cursor {
                        stamp: snapshot.stamp,
                        count: total as u64,
                        offset: end as u64,
                    }
                    .encode(),
                )
            }
        } else {
            None
        };
        Ok(Page {
            entries: snapshot.entries(&handle, offset..end),
            next_cursor,
            total,
        })
    }

    /// Reports one entry, following nothing: a symlink reports what it points at.
    ///
    /// The name reported is the one the folder stores, which is also the name git's ignore rules
    /// are matched against. The root itself is not an entry of anything, so the empty path is
    /// `INVALID_PATH`.
    pub fn stat(&self, path: &str) -> Result<Entry, Error> {
        Root::check(path)?;
        if path.is_empty() {
            return Err(Error::Path(files_safe::Error::InvalidPath(String::new())));
        }
        let (parent, _) = split_leaf(path);
        let (handle, name) = self.root.open_parent(path)?;
        let metadata = handle.symlink_metadata(&name)?;
        let kind = if metadata.file_type().is_symlink() {
            symlink_kind(&handle, &name)
        } else {
            kind_of(&metadata.file_type())
        };
        let rules = self.rules_for(parent)?;
        let is_dir = matches!(kind, Kind::Directory);
        Ok(Entry {
            ignored: rules.folder_ignored() || rules.ignored(&name, is_dir),
            path: path.to_owned(),
            name,
            size: size_of(&metadata, &kind),
            mtime_ms: metadata
                .modified()
                .map(|time| millis(time.into_std()))
                .unwrap_or(0),
            kind,
        })
    }

    /// Keeps the listing of the folder a traversal is paging, under `token`.
    ///
    /// A listing that fits the memory budget is kept whole. A larger one is not stored at all,
    /// since keeping it would be the memory blow-up the budget exists to prevent: the token names
    /// a bounded stream that re-reads the folder through `handle` on each page instead. Admission
    /// is checked here, before the caller issues a cursor, so no cursor ever names a listing that
    /// was silently dropped.
    fn pin(
        &self,
        dir: &str,
        token: u64,
        handle: Arc<Dir>,
        snapshot: &Arc<Snapshot>,
        rules: Arc<Rules>,
        hidden: Hidden,
    ) -> Result<(), Error> {
        let mut cache = self
            .pinned
            .lock()
            .map_err(|_| Error::Io(std::io::Error::other("the pinned listings are poisoned")))?;
        let key = token.to_string();
        let total = snapshot.total();
        let entry = if cache.admits(total) {
            Pinned::Listed {
                dir: dir.to_owned(),
                handle,
                snapshot: Arc::clone(snapshot),
            }
        } else {
            Pinned::Streamed {
                dir: dir.to_owned(),
                handle,
                rules,
                hidden,
            }
        };
        // A stream holds one handle, not the folder's entries, so it costs one slot.
        let weight = if matches!(entry, Pinned::Listed { .. }) {
            total
        } else {
            1
        };
        if !cache.insert(&key, Arc::new(entry), weight) {
            return Err(Error::Io(std::io::Error::other(
                "no room to keep the listing this traversal pins",
            )));
        }
        Ok(())
    }

    /// One page of a traversal from the listing it pinned, after the folder itself changed.
    fn pinned_page(
        &self,
        dir: &str,
        pin: &Pin,
        limit: usize,
        listing: &Pinned,
    ) -> Result<Page, Error> {
        match listing {
            Pinned::Listed {
                dir: listed,
                handle,
                snapshot,
            } if listed == dir => {
                let total = snapshot.total();
                let offset = pin.offset(total)?;
                self.pinned_entries(pin.token, offset, limit, total, |range| {
                    snapshot.entries(handle, range)
                })
            }
            Pinned::Streamed {
                dir: streamed,
                handle,
                rules,
                hidden,
            } if streamed == dir => {
                // Bounded by one folder read: this listing is used for this page and dropped. A
                // folder that shrank below the offset simply ends the traversal.
                let stamp = Stamp::of(&handle.dir_metadata()?);
                let snapshot = snapshot::read(
                    dir,
                    handle,
                    stamp,
                    stamp.is_racy(self.clock.now()),
                    rules,
                    hidden,
                )?;
                let total = snapshot.total();
                let offset = usize::try_from(pin.offset).unwrap_or(usize::MAX).min(total);
                self.pinned_entries(pin.token, offset, limit, total, |range| {
                    snapshot.entries(handle, range)
                })
            }
            _ => Err(Error::InvalidCursor(format!(
                "the pinned listing is not for {dir:?}"
            ))),
        }
    }

    /// One page of a pinned listing, releasing the pin once its traversal reaches the end.
    fn pinned_entries(
        &self,
        token: u64,
        offset: usize,
        limit: usize,
        total: usize,
        entries: impl FnOnce(Range<usize>) -> Vec<Entry>,
    ) -> Result<Page, Error> {
        let end = offset.saturating_add(limit).min(total);
        let next_cursor = if end < total {
            Some(
                Pin {
                    token,
                    offset: end as u64,
                }
                .encode(),
            )
        } else {
            self.release(token);
            None
        };
        Ok(Page {
            entries: entries(offset..end),
            next_cursor,
            total,
        })
    }

    /// The listing `pin` names, which must be the one this folder's traversal pinned.
    fn pinned_listing(&self, dir: &str, pin: &Pin) -> Result<Arc<Pinned>, Error> {
        let found = self
            .pinned
            .lock()
            .ok()
            .and_then(|mut cache| cache.get(&pin.token.to_string()));
        match found {
            Some(listing) => Ok(listing),
            None => Err(Error::InvalidCursor(format!(
                "the pinned listing of {dir:?} expired; start again"
            ))),
        }
    }

    /// Forgets a pinned listing whose traversal reached its end.
    fn release(&self, token: u64) {
        if let Ok(mut cache) = self.pinned.lock() {
            cache.remove(&token.to_string());
        }
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
            if cached.is_current(&self.root) {
                return Ok(cached);
            }
            self.forget(dir);
        }
        let rules = if dir.is_empty() {
            Rules::root(&self.root)
        } else {
            let (parent, name) = split_leaf(dir);
            self.rules_for(parent)?.child(name, &self.root)
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
    fn snapshot(
        &self,
        dir: &str,
        handle: &cap_std::fs::Dir,
        rules: &Rules,
        hidden: &Hidden,
    ) -> Result<Arc<Snapshot>, Error> {
        let stamp = Stamp::of(&handle.dir_metadata()?);
        let racy = stamp.is_racy(self.clock.now());
        let hide = hidden.fingerprint();
        if let Some(cached) = self.cached_snapshot(dir)
            && cached.stamp == stamp
            && cached.hide == hide
        {
            return Ok(cached);
        }
        let fresh = Arc::new(snapshot::read(dir, handle, stamp, racy, rules, hidden)?);
        // A folder that changed within the racy window is not cached: its stamp cannot prove it
        // will look the same on the next call, so the next call reads it again.
        if !racy && let Ok(mut cache) = self.snapshots.lock() {
            cache.insert(dir, Arc::clone(&fresh), fresh.total());
        }
        Ok(fresh)
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
