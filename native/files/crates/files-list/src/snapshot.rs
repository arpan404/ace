// SPDX-License-Identifier: Apache-2.0

//! Reads one folder into ordered, annotated entries, without their numbers.
//!
//! Reading a folder of 100,000 names costs one directory read and one sort. The size and time of
//! an entry are only read when that entry lands in a page, so showing the first 500 of 100,000
//! costs 500 stats instead of 100,000. Both happen through the folder's own handle: nothing here
//! re-walks a path, so a folder renamed mid-listing cannot make ace stat something else.

use std::cmp::Ordering;
use std::ops::Range;

use cap_std::fs::Dir;

use crate::entry::{Entry, Kind, kind_of, millis, size_of, symlink_kind};
use crate::error::Error;
use crate::hide::Hidden;
use crate::rules::Rules;
use crate::sort;
use crate::stamp::Stamp;

/// One entry as far as ordering and ignoring are concerned.
#[derive(Debug)]
struct Item {
    path: String,
    name: String,
    kind: Kind,
    ignored: bool,
    /// The folded name, so ordering does not re-fold the folder on every comparison.
    folded: String,
}

/// A folder as it was when it was read: its stamp and its listable entries in listing order.
#[derive(Debug)]
pub(crate) struct Snapshot {
    /// The folder's identity when it was read.
    pub(crate) stamp: Stamp,
    /// Whether the folder changed too recently for `stamp` to prove it is unchanged.
    pub(crate) racy: bool,
    /// The hide patterns this listing was filtered with.
    pub(crate) hide: String,
    items: Vec<Item>,
}

impl Snapshot {
    pub(crate) fn total(&self) -> usize {
        self.items.len()
    }

    /// The entries in `range`, reading the numbers the panel shows now through `dir`.
    ///
    /// A file that vanished between the folder read and this page reports zeroes; the next
    /// listing is the one that stops showing it.
    pub(crate) fn entries(&self, dir: &Dir, range: Range<usize>) -> Vec<Entry> {
        self.items[range]
            .iter()
            .map(|item| self.entry(dir, item))
            .collect()
    }

    fn entry(&self, dir: &Dir, item: &Item) -> Entry {
        let metadata = dir.symlink_metadata(&item.name).ok();
        let size = metadata
            .as_ref()
            .map_or(0, |metadata| size_of(metadata, &item.kind));
        let mtime_ms = metadata
            .as_ref()
            .and_then(|metadata| metadata.modified().ok())
            .map_or(0, |time| millis(time.into_std()));
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

/// Reads the folder behind `handle`, which is the folder `dir` under the checkout root.
pub(crate) fn read(
    dir: &str,
    handle: &Dir,
    stamp: Stamp,
    racy: bool,
    rules: &Rules,
    hidden: &Hidden,
) -> Result<Snapshot, Error> {
    let mut items = Vec::new();
    for entry in handle.entries()? {
        let entry = entry?;
        if let Some(item) = item_for(handle, dir, &entry, rules, hidden)? {
            items.push(item);
        }
    }
    items.sort_by(compare);
    Ok(Snapshot {
        stamp,
        racy,
        hide: hidden.fingerprint().to_owned(),
        items,
    })
}

/// One directory item, or `None` when it cannot be a path the API can send back or the caller
/// asked for it to be hidden.
fn item_for(
    handle: &Dir,
    dir: &str,
    entry: &cap_std::fs::DirEntry,
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
    if files_safe::Root::check(&path).is_err() {
        return Ok(None);
    }
    let file_type = entry.file_type()?;
    let kind = if file_type.is_symlink() {
        symlink_kind(handle, &name)
    } else {
        kind_of(&file_type)
    };
    // The hide patterns are the caller's: `build/` should hide a symlink to a folder too. Git's
    // ignore rules below are stricter, because git treats symlinks as files whatever they point at.
    if hidden.hides(&path, kind.is_directory()) {
        return Ok(None);
    }
    let is_dir = matches!(kind, Kind::Directory);
    Ok(Some(Item {
        ignored: rules.folder_ignored() || rules.ignored(&name, is_dir),
        folded: sort::fold(&name),
        path,
        name,
        kind,
    }))
}

/// Folders first, then everything else, each in case-insensitive natural order with the exact
/// name breaking ties so the order never depends on how the file system returned the entries.
fn compare(left: &Item, right: &Item) -> Ordering {
    right
        .kind
        .is_directory()
        .cmp(&left.kind.is_directory())
        .then_with(|| sort::compare(&left.folded, &right.folded))
        .then_with(|| left.name.cmp(&right.name))
}
