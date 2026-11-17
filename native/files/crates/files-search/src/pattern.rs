// SPDX-License-Identifier: Apache-2.0

//! Turns a query into the compiled pattern, the include set and the exclude overrides.

use files_safe::Root;
use globset::{Glob, GlobSet, GlobSetBuilder};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use ignore::overrides::{Override, OverrideBuilder};

use crate::error::Error;
use crate::query::{Case, Query};

/// The compiled pattern, the include set and the caps, built once and shared by every walker.
pub(crate) struct Plan {
    pub(crate) matcher: RegexMatcher,
    pub(crate) includes: Option<GlobSet>,
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
        // Promising the matcher that it cannot see a line terminator lets the searcher take its
        // fast path; a pattern that tries to match one is refused instead of scanning buffers.
        builder.line_terminator(Some(b'\n'));
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
            includes: includes(&query.include)?,
            limit: if query.max_matches == 0 {
                u64::MAX
            } else {
                query.max_matches as u64
            },
            max_file_bytes: query.max_file_bytes,
        })
    }
}

/// Compiles the include globs into one set; a file must match one of them when the list is not
/// empty. Matching happens outside the ignore rules, so an include never re-includes a file that
/// git ignores.
fn includes(globs: &[String]) -> Result<Option<GlobSet>, Error> {
    if globs.is_empty() {
        return Ok(None);
    }
    let mut builder = GlobSetBuilder::new();
    for glob in globs {
        let compiled =
            Glob::new(glob).map_err(|error| Error::InvalidArgument(error.to_string()))?;
        builder.add(compiled);
    }
    builder
        .build()
        .map(Some)
        .map_err(|error| Error::InvalidArgument(error.to_string()))
}

/// Builds the gitignore-style overrides for the exclude globs.
///
/// Excludes are negated patterns, which the walker also prunes whole folders with. Includes stay
/// out of here: a whitelist override would beat `.gitignore` and expose files git ignores.
pub(crate) fn overrides(root: &Root, query: &Query) -> Result<Override, Error> {
    let mut builder = OverrideBuilder::new(root.path());
    for glob in &query.exclude {
        let pattern = glob.strip_prefix('!').unwrap_or(glob);
        builder.add(&format!("!{pattern}")).map_err(glob_error)?;
    }
    builder.build().map_err(glob_error)
}

fn glob_error(error: ignore::Error) -> Error {
    Error::InvalidArgument(error.to_string())
}
