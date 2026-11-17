// SPDX-License-Identifier: Apache-2.0

//! The caller's `hide` globs: entries that are never listed, whatever git thinks of them.

use std::path::Path;

use ignore::Match;
use ignore::gitignore::{Gitignore, GitignoreBuilder};

use crate::error::Error;

/// A compiled set of hide patterns for one listing.
///
/// The patterns are matched with gitignore rules, which gives the useful parts for free: a
/// pattern without a slash (`.git`) matches at every depth, and `**` works as the caller expects.
pub(crate) struct Hidden {
    matcher: Gitignore,
    fingerprint: String,
}

impl Hidden {
    /// `INVALID_ARGUMENT` for a pattern that is not a usable glob, because silently dropping it
    /// would list files the caller asked to keep out of the panel.
    pub(crate) fn build(root: &Path, patterns: &[String]) -> Result<Hidden, Error> {
        let fingerprint = patterns.join("\u{0}");
        if patterns.is_empty() {
            return Ok(Hidden {
                matcher: Gitignore::empty(),
                fingerprint,
            });
        }
        let mut builder = GitignoreBuilder::new(root);
        for pattern in patterns {
            builder.add_line(None, pattern).map_err(|error| {
                Error::InvalidArgument(format!("hide pattern {pattern:?}: {error}"))
            })?;
        }
        let matcher = builder
            .build()
            .map_err(|error| Error::InvalidArgument(format!("hide patterns: {error}")))?;
        Ok(Hidden {
            matcher,
            fingerprint,
        })
    }

    /// Whether `path`, relative to the root, must not be listed.
    pub(crate) fn hides(&self, path: &str, is_dir: bool) -> bool {
        if self.matcher.is_empty() {
            return false;
        }
        matches!(self.matcher.matched(path, is_dir), Match::Ignore(_))
    }

    /// Identifies the pattern set, so a cached folder listing is rebuilt when it changes.
    pub(crate) fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
}
