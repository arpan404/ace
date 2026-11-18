// SPDX-License-Identifier: Apache-2.0

//! Exclude globs, matched against a path and every folder above it.

use globset::{Glob, GlobBuilder, GlobSet, GlobSetBuilder};

use crate::error::Error;

/// Compiled exclude patterns.
///
/// A pattern that ends in `/**` also excludes the folder itself, so a newly created
/// `node_modules` is never watched either.
#[derive(Clone, Debug)]
pub(crate) struct Excluder {
    set: GlobSet,
}

impl Excluder {
    /// Compiles the patterns; a bad glob is `INVALID_ARGUMENT`.
    pub(crate) fn new(patterns: &[String]) -> Result<Excluder, Error> {
        let mut builder = GlobSetBuilder::new();
        for pattern in patterns {
            builder.add(build(pattern)?);
            if let Some(folder) = pattern.strip_suffix("/**") {
                builder.add(build(folder)?);
            }
        }
        let set = builder
            .build()
            .map_err(|error| Error::InvalidArgument(error.to_string()))?;
        Ok(Excluder { set })
    }

    /// True when `rel` or any folder holding it matches an exclude pattern.
    pub(crate) fn is_excluded(&self, rel: &str) -> bool {
        if self.set.is_empty() {
            return false;
        }
        let mut end = rel.len();
        loop {
            if self.set.is_match(&rel[..end]) {
                return true;
            }
            match rel[..end].rfind('/') {
                Some(index) => end = index,
                None => return false,
            }
        }
    }
}

fn build(pattern: &str) -> Result<Glob, Error> {
    GlobBuilder::new(pattern)
        .literal_separator(true)
        .build()
        .map_err(|error| Error::InvalidArgument(format!("{pattern}: {error}")))
}

#[cfg(test)]
mod tests {
    use super::Excluder;

    fn excluder(patterns: &[&str]) -> Excluder {
        let patterns: Vec<String> = patterns
            .iter()
            .map(|pattern| (*pattern).to_owned())
            .collect();
        Excluder::new(&patterns).unwrap()
    }

    #[test]
    fn folder_pattern_also_excludes_the_folder_and_everything_below_it() {
        let excluder = excluder(&["**/.git/objects/**"]);
        assert!(excluder.is_excluded(".git/objects/ab/cdef"));
        assert!(excluder.is_excluded("nested/pkg/.git/objects/ab"));
        assert!(excluder.is_excluded(".git/objects"));
        assert!(!excluder.is_excluded(".git/config"));
        assert!(!excluder.is_excluded("pkg/.git"));
    }

    #[test]
    fn default_node_modules_pattern_keeps_the_folder_but_not_its_children() {
        let excluder = excluder(&["**/node_modules/*/**"]);
        assert!(excluder.is_excluded("node_modules/react/index.js"));
        assert!(!excluder.is_excluded("node_modules"));
    }

    #[test]
    fn a_bare_folder_pattern_excludes_the_children_too() {
        let excluder = excluder(&["**/node_modules"]);
        assert!(excluder.is_excluded("node_modules"));
        assert!(excluder.is_excluded("node_modules/react/index.js"));
        assert!(!excluder.is_excluded("src/index.js"));
    }

    #[test]
    fn an_invalid_glob_is_an_invalid_argument() {
        let error = Excluder::new(&["src/[".to_owned()]).unwrap_err();
        assert_eq!(error.code(), "INVALID_ARGUMENT");
    }
}
