// SPDX-License-Identifier: Apache-2.0
//! The ref binding (G1): values in, bytes or `ace-json` text out, never logic. Each read
//! answers with the bytes its caller decodes, or with the fallback reason that sends the
//! shell to the same Git command.

use napi::bindgen_prelude::{Buffer, Either};
use napi_derive::napi;

use ace_git::refs::{self, Outcome};

use super::caught;

/// A listing: the raw bytes Git would print, or the `ace-json` fallback payload.
fn listing(outcome: Outcome<Vec<u8>>) -> Either<Buffer, String> {
    match outcome {
        Outcome::Data(bytes) => Either::A(Buffer::from(bytes)),
        Outcome::Fallback(reason) => Either::B(reason.payload()),
    }
}

#[napi]
pub fn git_refs_worktrees(root: String) -> napi::Result<Either<Buffer, String>> {
    caught("git refs worktrees", || {
        Ok(listing(ace_git::worktrees_gix::worktrees(&root)))
    })
}

#[napi]
pub fn git_refs_branch_listing(
    root: String,
    patterns: Vec<String>,
    count: u32,
) -> napi::Result<Either<Buffer, String>> {
    caught("git refs branch listing", || {
        Ok(listing(refs::branch_refs(&root, &patterns, count)))
    })
}

#[napi]
pub fn git_refs_branch_names(
    root: String,
    patterns: Vec<String>,
    count: u32,
) -> napi::Result<Either<Buffer, String>> {
    caught("git refs branch names", || {
        Ok(listing(refs::branch_names(&root, &patterns, count)))
    })
}

#[napi]
pub fn git_refs_commit(root: String, reference: String) -> napi::Result<String> {
    caught("git refs commit", || {
        refs::reply(&refs::resolve_commit(&root, &reference))
    })
}

#[napi]
pub fn git_refs_branch_head(root: String, reference: String) -> napi::Result<String> {
    caught("git refs branch head", || {
        refs::reply(&refs::branch_head(&root, &reference))
    })
}
