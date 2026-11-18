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

use files_io::{Committed, Walks};
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
    match op {
        Op::List {
            root,
            dir,
            limit,
            cursor,
            hide,
        } => list::list(shared, root, &dir, limit, cursor, hide),
        Op::Stat { root, path } => list::stat(shared, root, &path),
        Op::Describe { root, path, full } => {
            let walks = if full {
                // A guard a mutation will compare needs the whole tree, not a lower bound.
                Walks::unlimited(&cancelled)
            } else {
                Walks::with_budget(&cancelled, walk_budget())
            };
            read_write::describe(shared, root, &path, &walks)
        }
        Op::DescribeEntry { root, path } => read_write::describe_entry(shared, root, &path),
        // The trash quota counts every byte it reserves, so its measure has no entry budget.
        Op::Measure { root, path } => {
            read_write::measure(shared, root, &path, &Walks::unlimited(&cancelled))
        }
        Op::IndexQuery { root, query, limit } => index::query(shared, root, &query, limit),
        Op::CreateDir { root, path } => committed(read_write::create_dir(shared, root, &path)?),
        Op::Rename {
            root,
            from,
            to,
            overwrite,
            expected,
            own,
        } => committed(read_write::rename(
            shared,
            root,
            &from,
            &to,
            overwrite,
            expected.as_deref(),
            own.as_deref(),
        )?),
        Op::Remove { root, path } => committed(read_write::remove(shared, root, &path)?),
        Op::Trash {
            root,
            path,
            endpoint,
            expected,
            own,
        } => committed(read_write::trash(
            shared,
            root,
            &path,
            &endpoint,
            &expected,
            own.as_deref(),
        )?),
        Op::Untrash {
            root,
            endpoint,
            path,
        } => committed(read_write::untrash(shared, root, &endpoint, &path)?),
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

/// Answer a mutation that landed, putting its warning on the log the daemon reads.
fn committed(committed: Committed) -> Result<Reply, Error> {
    if let Some(warning) = committed.warning {
        eprintln!("ace-files: {warning}");
    }
    Ok(Reply::Done)
}
