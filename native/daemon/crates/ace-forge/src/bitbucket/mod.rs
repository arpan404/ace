// SPDX-License-Identifier: Apache-2.0
//! Bitbucket (F5): `BitbucketReader`, `BitbucketReviews`, `bitbucketReviewWrites` and `bkt`
//! readiness and identity, through `bkt`. F0 declares the module only; every probe defers to
//! TypeScript.

use crate::error::Error;

/// The part name the shell and the deferral payload use.
pub const PART: &str = "bitbucket";

/// `op`'s native entry point; F0's answer is the deferral.
pub fn probe(op: &str) -> Result<String, Error> {
    Err(Error::unimplemented(PART, op))
}
