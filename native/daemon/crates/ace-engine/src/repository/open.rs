// SPDX-License-Identifier: Apache-2.0
//! `Repo::open` (E5.3 step 1). The opener constructs the TypeScript repository, which does the
//! schema setup; Rust's half runs no statement and prepares nothing. Statements are cached on
//! first use by `ace_store::stmt_cache`.

use super::Repo;

impl Repo {
    /// Open the repository over an existing home. Never runs DDL: the TypeScript opener
    /// (`native-engine/open.ts`) owns every open-time statement.
    pub fn open(capacity: usize) -> Repo {
        Repo::new(capacity)
    }
}
