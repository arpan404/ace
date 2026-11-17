// SPDX-License-Identifier: Apache-2.0

//! Turns a query into the compiled pattern and ignore overrides the walker uses.

use files_safe::Root;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use ignore::overrides::{Override, OverrideBuilder};

use crate::error::Error;
use crate::query::{Case, Query};

/// The compiled pattern and the caps, built once and shared by every walker thread.
pub(crate) struct Plan {
    pub(crate) matcher: RegexMatcher,
    pub(crate) limit: u64,
    pub(crate) max_file_bytes: u64,
}

impl Plan {
    /// Compiles `query.pattern`. Literal patterns are escaped, so a file name full of regex
    /// metacharacters searches for itself.
    pub(crate) fn build(query: &Query) -> Result<Plan, Error> {
        if query.pattern.is_empty() {
            return Err(Error::InvalidArgument("pattern is empty".to_owned()));
        }
        let source = if query.regex {
            query.pattern.clone()
        } else {
            regex::escape(&query.pattern)
        };
        let mut builder = RegexMatcherBuilder::new();
        match query.case {
            Case::Sensitive => {}
            Case::Insensitive => {
                builder.case_insensitive(true);
            }
            Case::Smart => {
                builder.case_smart(true);
            }
        }
        builder.word(query.whole_word);
        let matcher = builder
            .build(&source)
            .map_err(|error| Error::InvalidArgument(error.to_string()))?;
        Ok(Plan {
            matcher,
            limit: if query.max_matches == 0 {
                u64::MAX
            } else {
                query.max_matches as u64
            },
            max_file_bytes: query.max_file_bytes,
        })
    }
}

/// Builds the gitignore-style overrides for `include` and `exclude`.
///
/// Include globs are whitelists, so a file that matches none of them is left out; exclude globs
/// are added as negated patterns, which the walker also prunes whole folders with.
pub(crate) fn overrides(root: &Root, query: &Query) -> Result<Override, Error> {
    let mut builder = OverrideBuilder::new(root.path());
    for glob in &query.include {
        builder.add(glob).map_err(glob_error)?;
    }
    for glob in &query.exclude {
        let pattern = glob.strip_prefix('!').unwrap_or(glob);
        builder.add(&format!("!{pattern}")).map_err(glob_error)?;
    }
    builder.build().map_err(glob_error)
}

fn glob_error(error: ignore::Error) -> Error {
    Error::InvalidArgument(error.to_string())
}
