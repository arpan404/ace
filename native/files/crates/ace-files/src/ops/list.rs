// SPDX-License-Identifier: Apache-2.0

//! `list` and `stat`: what one folder holds, and what one path is.

use files_list::ListOptions;
use files_wire::Reply;

use crate::convert;
use crate::dispatch::Shared;
use crate::error::Error;
use crate::hidden;

/// The largest page the contract allows.
const MAX_LIMIT: usize = 5_000;

/// One page of one folder.
///
/// The contract allows at most 5,000 entries per page, which `files-list` also enforces; checking
/// it here refuses an impossible page before any folder is read.
pub fn list(
    shared: &Shared,
    root: u64,
    dir: &str,
    limit: u64,
    cursor: Option<String>,
    hide: Vec<String>,
    snapshot: bool,
) -> Result<Reply, Error> {
    if !(1..=MAX_LIMIT as u64).contains(&limit) {
        return Err(Error::InvalidArgument(format!(
            "limit {limit} is outside 1..={MAX_LIMIT}"
        )));
    }
    let entry = shared.roots.get(root)?;
    let limit = usize::try_from(limit)
        .map_err(|_| Error::InvalidArgument(format!("limit {limit} is out of range")))?;
    let options = ListOptions {
        limit,
        cursor,
        hide: hidden::listing_hide(hide),
    };
    // A pinned traversal's later page is served from the handle its first page was authorized
    // through, so a folder renamed or deleted since still answers its remaining pages.
    if snapshot && options.cursor.as_deref().is_some_and(files_list::is_pinned) {
        let page = entry.lister().list_pinned_page(dir, &options)?;
        return Ok(Reply::Page(convert::page(page)));
    }
    // Git's store and the daemon's transfer temporaries are never served, and neither is anything
    // a link leads into: the walk that proves the names hands back the handle the page is read
    // through, so the folder that answered is the folder the policy read.
    let (handle, _stored) = files_io::authorized_dir(entry.root(), dir)?;
    let page = if snapshot {
        entry.lister().list_pinned_in(dir, &handle, &options)?
    } else {
        entry.lister().list_in(dir, &handle, &options)?
    };
    Ok(Reply::Page(convert::page(page)))
}

/// The description of one path.
pub fn stat(shared: &Shared, root: u64, path: &str) -> Result<Reply, Error> {
    let entry = shared.roots.get(root)?;
    let parent = files_io::authorized_parent(entry.root(), path)?;
    let stat = entry.lister().stat_in(path, &parent.dir, &parent.name)?;
    Ok(Reply::Entry(convert::entry(stat)))
}
