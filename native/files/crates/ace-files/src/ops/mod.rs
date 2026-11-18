// SPDX-License-Identifier: Apache-2.0

//! What each request does, one module per family of ops.
//!
//! The dispatcher handles the ops that stream (watch, search) or carry a body frame (read, write,
//! createFile) itself, because those own a subscription or a channel. Everything else is a
//! blocking call into a `files-*` crate and arrives here.

mod index;
mod list;
pub mod read_write;
pub mod search;
pub mod watch;

use files_io::Walks;
use files_wire::{Op, Reply};

use crate::dispatch::Shared;
use crate::error::Error;
use crate::requests::Cancel;

/// How many entries a request's walk reads before it reports a shallow answer.
///
/// The default is the contract's; with the `test-hooks` feature a test can shrink it, because a
/// tree of 200,000 entries is too slow to build in a test that only needs to see the fallback.
fn walk_budget() -> usize {
    #[cfg(feature = "test-hooks")]
    if let Ok(text) = std::env::var("ACE_FILES_WALK_BUDGET")
        && let Ok(entries) = text.parse::<usize>()
    {
        return entries;
    }
    Walks::DEFAULT_ENTRIES
}

/// Run one request that has no body frame and no subscription.
pub fn perform(shared: &Shared, cancel: &Cancel, op: Op) -> Result<Reply, Error> {
    let cancelled = || cancel.cancelled();
    let walks = Walks::with_budget(&cancelled, walk_budget());
    match op {
        Op::List {
            root,
            dir,
            limit,
            cursor,
            hide,
            snapshot,
        } => list::list(shared, root, &dir, limit, cursor, hide, snapshot),
        Op::Stat { root, path } => list::stat(shared, root, &path),
        Op::Describe { root, path } => read_write::describe(shared, root, &path, &walks),
        Op::DescribeEntry { root, path } => read_write::describe_entry(shared, root, &path),
        Op::CheckMutation { root, path } => read_write::check_mutation(shared, root, &path),
        Op::Measure { root, path } => read_write::measure(shared, root, &path, &walks),
        Op::IndexQuery { root, query, limit } => index::query(shared, root, &query, limit),
        Op::CreateDir { root, path } => read_write::create_dir(shared, root, &path),
        Op::Rename {
            root,
            from,
            to,
            overwrite,
        } => read_write::rename(shared, root, &from, &to, overwrite),
        Op::Remove { root, path } => read_write::remove(shared, root, &path),
        Op::OpenRoot { .. }
        | Op::CloseRoot { .. }
        | Op::Read { .. }
        | Op::Write { .. }
        | Op::CreateFile { .. }
        | Op::Watch { .. }
        | Op::Unwatch { .. }
        | Op::Search { .. } => Err(Error::InvalidArgument(
            "this request is handled by the dispatcher".to_owned(),
        )),
    }
}
