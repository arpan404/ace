// SPDX-License-Identifier: Apache-2.0

//! Reads one folder into sorted, annotated entries.

use std::cmp::Ordering;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use files_safe::Root;

use crate::entry::{Entry, Kind, kind_of, millis, size_of};
use crate::error::Error;
use crate::hide::Hidden;
use crate::rules::Rules;

/// A folder as it was when it was read: its stamp and its listable entries in listing order.
#[derive(Debug)]
pub(crate) struct Snapshot {
    /// The folder's modification time in nanoseconds.
    pub(crate) stamp: u128,
    /// The hide patterns this listing was filtered with.
    pub(crate) hide: String,
    pub(crate) entries: Vec<Entry>,
}

/// A folder's own modification time in nanoseconds, which is when its entry list last changed.
pub(crate) fn stamp(metadata: &std::fs::Metadata) -> u128 {
    modified_nanos(metadata.modified().ok())
}

fn modified_nanos(time: Option<SystemTime>) -> u128 {
    time.and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|age| age.as_nanos())
        .unwrap_or(0)
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
    let mut entries = Vec::new();
    for item in std::fs::read_dir(abs)? {
        let item = item?;
        if let Some(entry) = entry_for(root, dir, &item, rules, hidden)? {
            entries.push(entry);
        }
    }
    entries.sort_by(compare);
    Ok(Snapshot {
        stamp,
        hide: hidden.fingerprint().to_owned(),
        entries,
    })
}

/// One directory item, or `None` when it cannot be a path the API can send back or the caller
/// asked for it to be hidden.
fn entry_for(
    root: &Root,
    dir: &str,
    item: &std::fs::DirEntry,
    rules: &Rules,
    hidden: &Hidden,
) -> Result<Option<Entry>, Error> {
    let Ok(name) = item.file_name().into_string() else {
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
    let file_type = item.file_type()?;
    let kind = if file_type.is_symlink() {
        symlink_kind(root, &path)
    } else {
        kind_of(&file_type)
    };
    let is_dir = matches!(kind, Kind::Directory);
    if hidden.hides(&path, is_dir) {
        return Ok(None);
    }
    let metadata = item.metadata()?;
    Ok(Some(Entry {
        ignored: rules.folder_ignored() || rules.ignored(&name, is_dir),
        path,
        name,
        size: size_of(&metadata, &kind),
        mtime_ms: metadata.modified().map(millis).unwrap_or(0),
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
fn compare(left: &Entry, right: &Entry) -> Ordering {
    right
        .kind
        .is_directory()
        .cmp(&left.kind.is_directory())
        .then_with(|| natord::compare_ignore_case(&left.name, &right.name))
        .then_with(|| left.name.cmp(&right.name))
}
