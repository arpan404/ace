// SPDX-License-Identifier: Apache-2.0

//! `list` and `stat`: what one folder holds, and what one path is.

use files_list::ListOptions;
use files_wire::Reply;

use crate::convert;
use crate::dispatch::Shared;
use crate::error::Error;

/// One page of one folder.
pub fn list(
    shared: &Shared,
    root: u64,
    dir: &str,
    limit: u64,
    cursor: Option<String>,
    hide: Vec<String>,
) -> Result<Reply, Error> {
    let entry = shared.roots.get(root)?;
    let limit = usize::try_from(limit)
        .map_err(|_| Error::InvalidArgument(format!("limit {limit} is out of range")))?;
    let options = ListOptions {
        limit,
        cursor,
        hide,
    };
    let page = entry.lister().list(dir, &options)?;
    Ok(Reply::Page(convert::page(page)))
}

/// The description of one path.
pub fn stat(shared: &Shared, root: u64, path: &str) -> Result<Reply, Error> {
    let entry = shared.roots.get(root)?;
    let stat = entry.lister().stat(path)?;
    Ok(Reply::Entry(convert::entry(stat)))
}
