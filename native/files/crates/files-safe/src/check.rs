// SPDX-License-Identifier: Apache-2.0

//! Syntax of a relative path, decided without touching the filesystem.

use crate::error::Error;

/// The longest relative path accepted, in bytes. Nothing the protocol carries is longer, and a
/// cap keeps every walk and every error message bounded.
const MAX_REL_BYTES: usize = 4096;

/// The longest single name accepted, in bytes: the limit every platform we run on shares.
const MAX_SEGMENT_BYTES: usize = 255;

/// Validates the relative form: `/`-separated, no leading or trailing `/`, no empty, `.` or `..`
/// segments, no NUL, and on Windows no segment Windows would read differently.
///
/// The empty string is the root itself and is accepted.
pub(crate) fn check(rel: &str) -> Result<&str, Error> {
    if rel.is_empty() {
        return Ok(rel);
    }
    let malformed = rel.len() > MAX_REL_BYTES
        || rel.starts_with('/')
        || rel.ends_with('/')
        || rel.contains('\0')
        || rel.split('/').any(|part| !segment(part));
    if malformed {
        Err(Error::InvalidPath(rel.to_owned()))
    } else {
        Ok(rel)
    }
}

/// Whether one name is one the platform can store, and reads the same way there as it does here.
///
/// A link target is held to these rules too: a relative target spliced into a walk is a path ace
/// does not receive over the wire, but it is still a name the platform would read differently if
/// it were one Windows reinterprets.
pub(crate) fn segment(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." || name.len() > MAX_SEGMENT_BYTES {
        return false;
    }
    #[cfg(windows)]
    return crate::windows::segment_is_valid(name);
    #[cfg(not(windows))]
    true
}

#[cfg(test)]
mod tests {
    use super::{MAX_REL_BYTES, check};

    #[test]
    fn accepts_the_protocol_form() {
        for rel in [
            "",
            "a",
            "a/b",
            ".gitignore",
            "src/main.rs",
            "a b",
            "ü",
            "a..b",
            "...",
        ] {
            assert_eq!(check(rel).expect(rel), rel, "{rel}");
        }
    }

    #[test]
    fn rejects_absolute_trailing_slash_and_empty_segments() {
        for rel in ["/", "/a", "a/", "a//b", "//"] {
            assert_eq!(check(rel).unwrap_err().code(), "INVALID_PATH", "{rel}");
        }
    }

    #[test]
    fn rejects_dot_dot_and_dot_segments() {
        for rel in [".", "..", "./a", "../a", "a/.", "a/..", "a/../b", "a/./b"] {
            assert_eq!(check(rel).unwrap_err().code(), "INVALID_PATH", "{rel}");
        }
        assert_eq!(
            check("a/..b/c").expect("dots inside a name are fine"),
            "a/..b/c"
        );
    }

    #[test]
    fn rejects_nul() {
        assert_eq!(check("a\0b").unwrap_err().code(), "INVALID_PATH");
        assert_eq!(check("\0").unwrap_err().code(), "INVALID_PATH");
    }

    #[test]
    fn rejects_names_past_the_length_limits() {
        let long_segment = "a".repeat(256);
        assert_eq!(
            check(&long_segment).unwrap_err().code(),
            "INVALID_PATH",
            "256-byte segment"
        );
        assert!(check(&"a".repeat(255)).is_ok(), "255-byte segment");

        let deep = "ab/".repeat(MAX_REL_BYTES / 3 + 1);
        assert!(deep.len() > MAX_REL_BYTES);
        assert_eq!(
            check(deep.trim_end_matches('/')).unwrap_err().code(),
            "INVALID_PATH"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn keeps_backslash_as_an_ordinary_character() {
        assert_eq!(
            check(r"a\b").expect("a backslash is a name on Unix"),
            r"a\b"
        );
    }
}
