// SPDX-License-Identifier: Apache-2.0

//! `indexQuery`: quick open over the paths of one checkout.

use files_wire::Reply;

use crate::dispatch::Shared;
use crate::error::Error;

/// Search the root's path index. Before the background build lands the answer is empty and says
/// `ready: false`, which the daemon shows as "still indexing" rather than as "no match".
pub fn query(shared: &Shared, root: u64, query: &str, limit: u64) -> Result<Reply, Error> {
    let entry = shared.roots.get(root)?;
    let limit = usize::try_from(limit).unwrap_or(usize::MAX);
    Ok(Reply::Index(entry.index_query(query, limit)))
}
