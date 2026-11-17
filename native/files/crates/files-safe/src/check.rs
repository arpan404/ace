// SPDX-License-Identifier: Apache-2.0

//! Syntax of a relative path, decided without touching the filesystem.

use crate::error::Error;

/// Validates the relative form: `/`-separated, no leading or trailing `/`, no empty, `.` or `..`
/// segments, no NUL, and on Windows no segment Windows would read differently.
///
/// The empty string is the root itself and is accepted.
pub(crate) fn check(rel: &str) -> Result<&str, Error> {
    if rel.is_empty() {
        return Ok(rel);
    }
    let malformed = rel.starts_with('/')
        || rel.ends_with('/')
        || rel.contains('\0')
        || rel.split('/').any(|segment| !segment_allowed(segment));
    if malformed {
        Err(Error::InvalidPath(rel.to_owned()))
    } else {
        Ok(rel)
    }
}

/// Whether one `/`-separated segment is a plain name on this platform.
fn segment_allowed(segment: &str) -> bool {
    if segment.is_empty() || segment == "." || segment == ".." {
        return false;
    }
    #[cfg(windows)]
    return crate::windows::segment_is_valid(segment);
    #[cfg(not(windows))]
    true
}

#[cfg(test)]
mod tests {
    use super::check;

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

    #[cfg(not(windows))]
    #[test]
    fn keeps_backslash_as_an_ordinary_character() {
        assert_eq!(
            check(r"a\b").expect("a backslash is a name on Unix"),
            r"a\b"
        );
    }
}
