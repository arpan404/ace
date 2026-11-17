// SPDX-License-Identifier: Apache-2.0

//! Names Windows reads differently from Unix.
//!
//! A checkout can hold files whose names Windows would reinterpret: `a\b` becomes two folders,
//! `C:x` becomes a drive-relative path, `CON` or `NUL` becomes a device, and a trailing dot or
//! space is silently dropped so `a.` and `a` are the same file. Refusing them keeps the relative
//! form meaning one thing on every platform the daemon runs on.
//!
//! The rules are plain string checks so they can be tested anywhere; reaching the filesystem is
//! never needed to decide them.

/// Whether one `/`-separated segment is a name Windows opens as a folder member with that
/// spelling.
pub(crate) fn segment_is_valid(segment: &str) -> bool {
    !segment.contains(['\\', ':'])
        && !segment.ends_with(['.', ' '])
        && !is_device_name(segment)
        && !has_invalid_character(segment)
}

/// Device names are reserved in every folder and with any extension: `nul.txt` is the null
/// device, not a file.
fn is_device_name(segment: &str) -> bool {
    let stem = segment
        .split('.')
        .next()
        .unwrap_or(segment)
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$"
    ) || numbered_device(&stem, "COM")
        || numbered_device(&stem, "LPT")
}

/// `COM1`..`COM9` and `LPT1`..`LPT9` name ports. `COM0` is accepted by Windows as well, so the
/// whole digit range is refused.
fn numbered_device(stem: &str, prefix: &str) -> bool {
    match stem.strip_prefix(prefix) {
        Some(rest) => rest.len() == 1 && rest.as_bytes().first().is_some_and(u8::is_ascii_digit),
        None => false,
    }
}

/// Characters Windows cannot store in a name at all. Some of them, like `?` and `*`, are globs.
fn has_invalid_character(segment: &str) -> bool {
    segment
        .chars()
        .any(|character| matches!(character, '<' | '>' | '"' | '|' | '?' | '*') || character < ' ')
}

/// Matches an absolute path against the root the way Windows does: ignoring case, ignoring the
/// `\\?\` marker a canonical path carries, and treating both separators alike. Returns the
/// `/`-separated remainder, or `None` when the path is not inside the root.
/// The verbatim marker a canonical root carries and the case and separator differences between
/// an OS event path and the root are all Windows spellings of the same folder, so compare them
/// that way instead of failing every path.
pub(crate) fn relative(root: &str, absolute: &str) -> Option<String> {
    let root_parts: Vec<&str> = split(root)?;
    let absolute_parts: Vec<&str> = split(absolute)?;
    if root_parts.len() > absolute_parts.len() {
        return None;
    }
    let matches_root = root_parts
        .iter()
        .zip(absolute_parts.iter())
        .all(|(want, got)| want.eq_ignore_ascii_case(got));
    if !matches_root {
        return None;
    }
    let rest = &absolute_parts[root_parts.len()..];
    if rest.iter().any(|part| matches!(*part, "." | "..")) {
        return None;
    }
    Some(rest.join("/"))
}

/// Splits a native path into its segments, dropping the verbatim marker, `.` for the current
/// folder and any duplicate separators.
fn split(path: &str) -> Option<Vec<&str>> {
    let path = path
        .strip_prefix(r"\\?\UNC\")
        .or_else(|| path.strip_prefix(r"\\?\"))
        .unwrap_or(path);
    let parts: Vec<&str> = path
        .split(['\\', '/'])
        .filter(|part| !part.is_empty() && *part != ".")
        .collect();
    if parts.is_empty() { None } else { Some(parts) }
}

#[cfg(test)]
mod tests {
    use super::{relative, segment_is_valid};

    #[test]
    fn accepts_ordinary_names() {
        for segment in [
            ".gitignore",
            "a.b",
            "console",
            "come1",
            "file name",
            "COM10",
            "a-b_c",
        ] {
            assert!(segment_is_valid(segment), "{segment} should be allowed");
        }
    }

    #[test]
    fn rejects_backslash_and_colon() {
        for segment in [r"a\b", r"\", "C:", "c:", "file:stream"] {
            assert!(!segment_is_valid(segment), "{segment} should be refused");
        }
    }

    #[test]
    fn rejects_reserved_device_names() {
        for segment in [
            "CON",
            "con",
            "Con.txt",
            "prn",
            "AUX",
            "NUL",
            "nul.tar.gz",
            "CLOCK$",
            "CONIN$",
            "CONOUT$",
            "COM1",
            "com9",
            "LPT1",
            "lpt9",
            "COM0",
        ] {
            assert!(!segment_is_valid(segment), "{segment} should be refused");
        }
    }

    #[test]
    fn rejects_trailing_dots_and_spaces() {
        for segment in ["a.", "a ", "a..", "a. ", "..", "..."] {
            assert!(!segment_is_valid(segment), "{segment} should be refused");
        }
    }

    #[test]
    fn rejects_characters_windows_cannot_store() {
        for segment in ["a<b", "a>b", "a\"b", "a|b", "a?b", "a*b", "a\tb"] {
            assert!(!segment_is_valid(segment), "{segment} should be refused");
        }
    }

    #[test]
    fn matches_a_canonical_path_case_insensitively() {
        assert_eq!(
            relative(r"\\?\C:\work\repo", r"C:\work\repo\src\main.rs").as_deref(),
            Some("src/main.rs")
        );
        assert_eq!(
            relative(r"C:\work\repo", r"\\?\c:\WORK\REPO\src").as_deref(),
            Some("src")
        );
        assert_eq!(
            relative(r"C:\work\repo", r"C:\work\repo").as_deref(),
            Some("")
        );
    }

    #[test]
    fn refuses_paths_outside_or_above_the_root() {
        assert_eq!(relative(r"C:\work\repo", r"C:\work\repository\a"), None);
        assert_eq!(relative(r"C:\work\repo", r"D:\work\repo\a"), None);
        assert_eq!(relative(r"C:\work\repo", r"C:\work\repo\..\other"), None);
    }

    #[test]
    fn matches_a_network_root() {
        let root = r"\\?\UNC\server\share\repo";
        assert_eq!(
            relative(root, r"\\server\share\repo\a").as_deref(),
            Some("a")
        );
        assert_eq!(relative(root, r"\\server\share\other\a"), None);
    }
}
