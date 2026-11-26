// SPDX-License-Identifier: Apache-2.0
//! Gitea and Forgejo (F4): `TeaReader`, `TeaReviews`, `TeaWriter`, `TeaIssueWriter`, their
//! write lists and `isTeaHost`, through `tea`. F0 declares the module only; every probe
//! defers to TypeScript.

use crate::error::Error;

/// The part name the shell and the deferral payload use.
pub const PART: &str = "tea";

/// `op`'s native entry point; F0's answer is the deferral.
pub fn probe(op: &str) -> Result<String, Error> {
    Err(Error::unimplemented(PART, op))
}
