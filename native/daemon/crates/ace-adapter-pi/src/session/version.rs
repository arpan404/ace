// SPDX-License-Identifier: Apache-2.0
//! Pi's version floor, ported from `packages/provider-kit/src/cli-versions.ts` and
//! `cli-requirements.ts` (`requireReadableMinimum("pi", cli.version)`, `session.ts:83`).
//!
//! Discovery owns the person's install; this gate is the session's own refusal, before any
//! process is spawned, with today's typed facts and sentence.

/// The oldest release ace supports (`cli-requirements.ts:41`–`:47`).
pub const PI_MINIMUM: &str = "0.85.1";

/// A parsed `major.minor[.patch][-prerelease]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliVersion {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    /// Dot-separated prerelease identifiers; empty for a release.
    pub prerelease: Vec<String>,
}

impl CliVersion {
    /// The version as ace writes it (`formatCliVersion`).
    pub fn text(&self) -> String {
        let base = format!("{}.{}.{}", self.major, self.minor, self.patch);
        if self.prerelease.is_empty() {
            base
        } else {
            format!("{base}-{}", self.prerelease.join("."))
        }
    }
}

/// Refusals `requireReadableMinimum` raises for Pi, with the TypeScript's text and codes.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PiCliError {
    /// `CliTooOldError`: readable and below the minimum.
    #[error(
        "Pi {installed} is older than {required}, the oldest version ace supports. Update Pi, then refresh."
    )]
    TooOld { installed: String, required: String },
    /// `cli_unsupported`: the version output held no version.
    #[error("Pi's version couldn't be read. ace supports Pi {required} or newer.")]
    Unreadable { required: String },
}

impl PiCliError {
    /// Today's `code` on the error object.
    pub fn code(&self) -> &'static str {
        match self {
            PiCliError::TooOld { .. } => "cli_too_old",
            PiCliError::Unreadable { .. } => "cli_unsupported",
        }
    }

    /// The heading a failed session opening shows (`title`).
    pub fn title(&self) -> &'static str {
        match self {
            PiCliError::TooOld { .. } => "Update Pi",
            PiCliError::Unreadable { .. } => "",
        }
    }
}

/// `requireReadableMinimum("pi", version)`: refuse an older or unreadable release.
pub fn require_readable_pi(version: Option<&str>) -> Result<CliVersion, PiCliError> {
    let required = parse_cli_version(PI_MINIMUM).unwrap_or(CliVersion {
        major: 0,
        minor: 85,
        patch: 1,
        prerelease: Vec::new(),
    });
    let Some(installed) = version.and_then(parse_cli_version) else {
        return Err(PiCliError::Unreadable {
            required: required.text(),
        });
    };
    if compare_cli_versions(&installed, &required) == std::cmp::Ordering::Less {
        return Err(PiCliError::TooOld {
            installed: installed.text(),
            required: required.text(),
        });
    }
    Ok(installed)
}

/// `parseCliVersion`: the first `major.minor[.patch][-prerelease]` in the output, wherever it
/// sits, preceded by a non-word character and not followed by a run holding a digit.
pub fn parse_cli_version(text: &str) -> Option<CliVersion> {
    let text = truncate_utf8(text, 4096);
    for (at, _) in text.char_indices() {
        if at > 0 {
            let previous = text[..at].chars().next_back()?;
            // The regex's `[^\w.]` is ASCII: a non-ASCII letter before the version is allowed.
            if previous.is_ascii_alphanumeric() || previous == '_' || previous == '.' {
                continue;
            }
        }
        if let Some(version) = parse_at(text, at) {
            return Some(version);
        }
    }
    None
}

/// Semver order: a prerelease sorts before its own release, after the one before it.
pub fn compare_cli_versions(a: &CliVersion, b: &CliVersion) -> std::cmp::Ordering {
    let core = a
        .major
        .cmp(&b.major)
        .then(a.minor.cmp(&b.minor))
        .then(a.patch.cmp(&b.patch));
    if core != std::cmp::Ordering::Equal {
        return core;
    }
    match (a.prerelease.is_empty(), b.prerelease.is_empty()) {
        (true, true) => std::cmp::Ordering::Equal,
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
        (false, false) => {
            for index in 0..a.prerelease.len().max(b.prerelease.len()) {
                let left = a.prerelease.get(index);
                let right = b.prerelease.get(index);
                match (left, right) {
                    (None, _) => return std::cmp::Ordering::Less,
                    (_, None) => return std::cmp::Ordering::Greater,
                    (Some(left), Some(right)) => {
                        let order = compare_identifiers(left, right);
                        if order != std::cmp::Ordering::Equal {
                            return order;
                        }
                    }
                }
            }
            std::cmp::Ordering::Equal
        }
    }
}

fn compare_identifiers(a: &str, b: &str) -> std::cmp::Ordering {
    let numeric = |value: &str| {
        !value.is_empty() && value.chars().all(|character| character.is_ascii_digit())
    };
    match (numeric(a), numeric(b)) {
        (true, true) => a
            .parse::<u64>()
            .unwrap_or(0)
            .cmp(&b.parse::<u64>().unwrap_or(0)),
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        (false, false) => a.cmp(b),
    }
}

/// One attempt from `at`: `v?digits.digits(.digits)?(-prerelease)?(+build)?`, then the
/// negative lookahead `(?![\w.]*\d)`.
fn parse_at(text: &str, at: usize) -> Option<CliVersion> {
    let rest = &text[at..];
    let rest = rest.strip_prefix('v').unwrap_or(rest);
    let (major, used) = digits(rest)?;
    let rest = &rest[used..];
    let rest = rest.strip_prefix('.')?;
    let (minor, used) = digits(rest)?;
    let mut rest = &rest[used..];
    let mut patch = 0;
    if let Some(after_dot) = rest.strip_prefix('.')
        && let Some((value, used)) = digits(after_dot)
    {
        patch = value;
        rest = &after_dot[used..];
    }
    let mut prerelease = Vec::new();
    if let Some(tail) = rest.strip_prefix('-') {
        let (value, used) = identifiers(tail);
        if !value.is_empty() {
            prerelease = value.split('.').map(str::to_owned).collect();
            rest = &tail[used..];
        }
    }
    if let Some(tail) = rest.strip_prefix('+') {
        let used = tail
            .chars()
            .take_while(|character| {
                character.is_ascii_alphanumeric() || *character == '.' || *character == '-'
            })
            .map(char::len_utf8)
            .sum();
        rest = &tail[used..];
    }
    // `(?![\w.]*\d)`: a following word/dot run with a digit in it fails this start.
    let mut following = rest.chars().peekable();
    while let Some(character) = following.peek() {
        if character.is_ascii_alphanumeric() || *character == '_' || *character == '.' {
            if character.is_ascii_digit() {
                return None;
            }
            following.next();
        } else {
            break;
        }
    }
    Some(CliVersion {
        major,
        minor,
        patch,
        prerelease,
    })
}

fn digits(text: &str) -> Option<(u64, usize)> {
    let used = text
        .chars()
        .take_while(char::is_ascii_digit)
        .map(char::len_utf8)
        .sum::<usize>();
    if used == 0 || used > 9 {
        return None;
    }
    text[..used].parse().ok().map(|value| (value, used))
}

/// `[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*`, returning the text and the bytes consumed.
fn identifiers(text: &str) -> (&str, usize) {
    let allowed = |character: char| character.is_ascii_alphanumeric() || character == '-';
    let mut used = 0;
    let mut last_was_dot = true;
    for (at, character) in text.char_indices() {
        if allowed(character) {
            used = at + character.len_utf8();
            last_was_dot = false;
        } else if character == '.' && !last_was_dot {
            used = at + 1;
            last_was_dot = true;
        } else {
            break;
        }
    }
    if last_was_dot && used > 0 {
        used -= 1;
    }
    (&text[..used], used)
}

fn truncate_utf8(text: &str, bytes: usize) -> &str {
    if text.len() <= bytes {
        return text;
    }
    let mut end = bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_release_is_read_wherever_it_sits_and_an_unreadable_output_is_refused() {
        for (text, expected) in [
            ("0.85.1", "0.85.1"),
            ("pi 0.85.1", "0.85.1"),
            ("v0.86.0-beta.1 (build)", "0.86.0-beta.1"),
            ("1.2 (x)", "1.2.0"),
        ] {
            assert_eq!(
                parse_cli_version(text)
                    .map(|version| version.text())
                    .as_deref(),
                Some(expected),
                "{text}"
            );
        }
        for text in ["", "no version", "1.2.3.4"] {
            assert_eq!(parse_cli_version(text), None, "{text}");
        }
    }

    #[test]
    fn semver_order_puts_a_prerelease_before_its_release() {
        let order = |a: &str, b: &str| {
            compare_cli_versions(
                &parse_cli_version(a).expect("a"),
                &parse_cli_version(b).expect("b"),
            )
        };
        assert_eq!(order("0.85.1-beta.1", "0.85.1"), std::cmp::Ordering::Less);
        assert_eq!(order("0.85.1", "0.85.1"), std::cmp::Ordering::Equal);
        assert_eq!(order("0.86.0", "0.85.9"), std::cmp::Ordering::Greater);
        assert_eq!(
            order("0.85.1-beta.2", "0.85.1-beta.10"),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn pi_older_than_the_floor_names_the_supported_range_and_newer_releases_pass() {
        let error = require_readable_pi(Some("0.84.4")).expect_err("too old");
        assert_eq!(error.code(), "cli_too_old");
        assert_eq!(error.title(), "Update Pi");
        assert_eq!(
            error.to_string(),
            "Pi 0.84.4 is older than 0.85.1, the oldest version ace supports. Update Pi, then refresh."
        );
        assert!(require_readable_pi(Some("0.85.1")).is_ok());
        assert!(require_readable_pi(Some("1.0.0")).is_ok());
        let unreadable = require_readable_pi(None).expect_err("unreadable");
        assert_eq!(unreadable.code(), "cli_unsupported");
        assert_eq!(
            unreadable.to_string(),
            "Pi's version couldn't be read. ace supports Pi 0.85.1 or newer."
        );
    }
}
