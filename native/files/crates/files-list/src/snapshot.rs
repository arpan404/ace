// SPDX-License-Identifier: Apache-2.0

//! Reads one folder into ordered, annotated entries, without their numbers.
//!
//! Reading a folder of 100,000 names costs one directory read and one sort. The size and time of
//! an entry are only read when that entry lands in a page, so showing the first 500 of 100,000
//! costs 500 stats instead of 100,000.

use std::cmp::Ordering;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use files_safe::Root;

use crate::entry::{Entry, Kind, kind_of, millis, size_of};
use crate::error::Error;
use crate::hide::Hidden;
use crate::rules::Rules;

/// One entry as far as ordering and ignoring are concerned.
#[derive(Debug)]
struct Item {
    path: String,
    name: String,
    kind: Kind,
    ignored: bool,
    /// The lowercased name, so natural ordering does not re-fold the folder on every comparison.
    folded: String,
}

/// A folder as it was when it was read: its stamp and its listable entries in listing order.
#[derive(Debug)]
pub(crate) struct Snapshot {
    /// The folder's modification time in nanoseconds.
    pub(crate) stamp: u128,
    /// The hide patterns this listing was filtered with.
    pub(crate) hide: String,
    abs: PathBuf,
    items: Vec<Item>,
}

impl Snapshot {
    pub(crate) fn total(&self) -> usize {
        self.items.len()
    }

    /// The entries in `range`, reading the numbers the panel shows now.
    ///
    /// A file that vanished between the folder read and this page reports zeroes; the next
    /// listing is the one that stops showing it.
    pub(crate) fn entries(&self, range: Range<usize>) -> Vec<Entry> {
        self.items[range]
            .iter()
            .map(|item| self.entry(item))
            .collect()
    }

    fn entry(&self, item: &Item) -> Entry {
        let metadata = std::fs::symlink_metadata(self.abs.join(&item.name)).ok();
        let size = metadata
            .as_ref()
            .map_or(0, |metadata| size_of(metadata, &item.kind));
        let mtime_ms = metadata
            .as_ref()
            .and_then(|metadata| metadata.modified().ok())
            .map_or(0, millis);
        Entry {
            path: item.path.clone(),
            name: item.name.clone(),
            kind: item.kind.clone(),
            size,
            mtime_ms,
            ignored: item.ignored,
        }
    }
}

/// A folder's own modification time in nanoseconds, which is when its entry list last changed.
pub(crate) fn stamp(metadata: &std::fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |age| age.as_nanos())
}

/// Reads `abs` (the folder `dir` under `root`) and returns every entry the contract lists.
pub(crate) fn read(
    root: &Root,
    dir: &str,
    abs: &Path,
    stamp: u128,
    rules: &Rules,
    hidden: &Hidden,
) -> Result<Snapshot, Error> {
    let mut items = Vec::new();
    for entry in std::fs::read_dir(abs)? {
        let entry = entry?;
        if let Some(item) = item_for(root, dir, &entry, rules, hidden)? {
            items.push(item);
        }
    }
    items.sort_by(compare);
    Ok(Snapshot {
        stamp,
        hide: hidden.fingerprint().to_owned(),
        abs: abs.to_path_buf(),
        items,
    })
}

/// One directory item, or `None` when it cannot be a path the API can send back or the caller
/// asked for it to be hidden.
fn item_for(
    root: &Root,
    dir: &str,
    entry: &std::fs::DirEntry,
    rules: &Rules,
    hidden: &Hidden,
) -> Result<Option<Item>, Error> {
    let Ok(name) = entry.file_name().into_string() else {
        return Ok(None);
    };
    let path = if dir.is_empty() {
        name.clone()
    } else {
        format!("{dir}/{name}")
    };
    if Root::check(&path).is_err() {
        return Ok(None);
    }
    let file_type = entry.file_type()?;
    let kind = if file_type.is_symlink() {
        symlink_kind(root, &path)
    } else {
        kind_of(&file_type)
    };
    let is_dir = matches!(kind, Kind::Directory);
    if hidden.hides(&path, is_dir) {
        return Ok(None);
    }
    Ok(Some(Item {
        ignored: rules.folder_ignored() || rules.ignored(&name, is_dir),
        folded: name.to_lowercase(),
        path,
        name,
        kind,
    }))
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

/// Folders first, then everything else, each in case-insensitive natural order with the exact
/// name breaking ties so the order never depends on how the file system returned the entries.
fn compare(left: &Item, right: &Item) -> Ordering {
    right
        .kind
        .is_directory()
        .cmp(&left.kind.is_directory())
        .then_with(|| natord::compare(&left.folded, &right.folded))
        .then_with(|| left.name.cmp(&right.name))
}
