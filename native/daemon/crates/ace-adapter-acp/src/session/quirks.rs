// SPDX-License-Identifier: Apache-2.0
//! ACP session quirks and CLI version comparison
//! (`packages/adapter-acp/src/quirks/{types,generic,antigravity}.ts`,
//! `packages/provider-kit/src/{cli-versions,cli-requirements}.ts`).

use std::cmp::Ordering;

use ace_json::{Map, Value};
use serde::{Deserialize, Serialize};

use crate::translate::quirks::QuirksKind;

/// Antigravity minimum supported CLI version (`cli-requirements.ts:63`).
pub const ANTIGRAVITY_MIN_VERSION: &str = "1.2.1";

/// A parsed CLI version (`cli-versions.ts:9`–`:15`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliVersion {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub prerelease: Vec<String>,
}

fn is_word_or_dot(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'.'
}

fn is_prerelease_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-'
}

fn is_build_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-'
}

fn scan_digits_1_to_9(bytes: &[u8], start: usize) -> Option<(u64, usize)> {
    let mut end = start;
    while end < bytes.len() && end - start < 9 && bytes[end].is_ascii_digit() {
        end += 1;
    }
    if end == start {
        return None;
    }
    let text = std::str::from_utf8(&bytes[start..end]).ok()?;
    let value = text.parse::<u64>().ok()?;
    Some((value, end))
}

/// First `major.minor[.patch][-prerelease]` in a CLI's version output (`cli-versions.ts:23`–`:36`).
pub fn parse_cli_version(text: &str) -> Option<CliVersion> {
    if text.is_empty() {
        return None;
    }
    // Mirror `text.slice(0, 4096)` (UTF-16 code units; for ASCII this equals bytes).
    let bounded: String = text.chars().take(4096).collect();
    let bytes = bounded.as_bytes();

    for i in 0..bytes.len() {
        if i > 0 && is_word_or_dot(bytes[i - 1]) {
            continue;
        }
        let mut pos = i;
        if bytes.get(pos) == Some(&b'v') {
            pos += 1;
        }
        let Some((major, after_major)) = scan_digits_1_to_9(bytes, pos) else {
            continue;
        };
        if bytes.get(after_major) != Some(&b'.') {
            continue;
        }
        let Some((minor, after_minor)) = scan_digits_1_to_9(bytes, after_major + 1) else {
            continue;
        };
        let (patch, mut end) = if bytes.get(after_minor) == Some(&b'.') {
            if let Some((patch, after_patch)) = scan_digits_1_to_9(bytes, after_minor + 1) {
                (patch, after_patch)
            } else {
                (0, after_minor)
            }
        } else {
            (0, after_minor)
        };

        let mut prerelease = Vec::new();
        if bytes.get(end) == Some(&b'-') {
            let mut p = end + 1;
            let mut segs = Vec::new();
            let mut seg_start = p;
            while p < bytes.len() && is_prerelease_char(bytes[p]) {
                p += 1;
            }
            if p > seg_start {
                if let Ok(seg) = std::str::from_utf8(&bytes[seg_start..p]) {
                    segs.push(seg.to_owned());
                }
                while bytes.get(p) == Some(&b'.') {
                    let next_start = p + 1;
                    let mut next_end = next_start;
                    while next_end < bytes.len() && is_prerelease_char(bytes[next_end]) {
                        next_end += 1;
                    }
                    if next_end == next_start {
                        break;
                    }
                    seg_start = next_start;
                    if let Ok(seg) = std::str::from_utf8(&bytes[seg_start..next_end]) {
                        segs.push(seg.to_owned());
                    }
                    p = next_end;
                }
                prerelease = segs;
                end = p;
            }
        }

        if bytes.get(end) == Some(&b'+') {
            let mut b = end + 1;
            while b < bytes.len() && is_build_char(bytes[b]) {
                b += 1;
            }
            if b > end + 1 {
                end = b;
            }
        }

        // Negative lookahead `(?![\w.]*\d)`.
        let mut look = end;
        let mut has_trailing_digit = false;
        while look < bytes.len() && is_word_or_dot(bytes[look]) {
            if bytes[look].is_ascii_digit() {
                has_trailing_digit = true;
                break;
            }
            look += 1;
        }
        if has_trailing_digit {
            continue;
        }

        return Some(CliVersion {
            major,
            minor,
            patch,
            prerelease,
        });
    }
    None
}

fn compare_identifiers(a: &str, b: &str) -> Ordering {
    let a_num = !a.is_empty() && a.bytes().all(|b| b.is_ascii_digit());
    let b_num = !b.is_empty() && b.bytes().all(|b| b.is_ascii_digit());
    match (a_num, b_num) {
        (true, true) => {
            let av = a.parse::<u128>().unwrap_or(0);
            let bv = b.parse::<u128>().unwrap_or(0);
            av.cmp(&bv)
        }
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => a.cmp(b),
    }
}

/// Semantic-version order (`cli-versions.ts:53`–`:67`).
pub fn compare_cli_versions(a: &CliVersion, b: &CliVersion) -> Ordering {
    let core = a
        .major
        .cmp(&b.major)
        .then_with(|| a.minor.cmp(&b.minor))
        .then_with(|| a.patch.cmp(&b.patch));
    if core != Ordering::Equal {
        return core;
    }
    match (a.prerelease.is_empty(), b.prerelease.is_empty()) {
        (true, true) => Ordering::Equal,
        (false, true) => Ordering::Less,
        (true, false) => Ordering::Greater,
        (false, false) => {
            let max_len = a.prerelease.len().max(b.prerelease.len());
            for i in 0..max_len {
                match (a.prerelease.get(i), b.prerelease.get(i)) {
                    (None, Some(_)) => return Ordering::Less,
                    (Some(_), None) => return Ordering::Greater,
                    (Some(left), Some(right)) => {
                        let ord = compare_identifiers(left, right);
                        if ord != Ordering::Equal {
                            return ord;
                        }
                    }
                    (None, None) => break,
                }
            }
            Ordering::Equal
        }
    }
}

/// Whether `version` is readable and at least Antigravity's minimum (`1.2.1`).
pub fn admits_antigravity_version(version: Option<&str>) -> bool {
    let Some(min) = parse_cli_version(ANTIGRAVITY_MIN_VERSION) else {
        return false;
    };
    let Some(installed) = version.and_then(parse_cli_version) else {
        return false;
    };
    compare_cli_versions(&installed, &min) != Ordering::Less
}

/// Base ACP capabilities (`quirks/types.ts:19`–`:34`).
pub fn base_capabilities() -> Map {
    let mut permissions = Map::with_capacity(4);
    permissions.insert("modes", Value::Array(Vec::new().into()));
    permissions.insert("permissionModes", Value::Array(Vec::new().into()));
    permissions.insert("nativeAutoReview", Value::Bool(false));
    permissions.insert("toolGate", Value::Bool(true));

    let mut caps = Map::with_capacity(16);
    caps.insert("permissionModes", Value::Array(Vec::new().into()));
    caps.insert("permissions", Value::Object(permissions));
    caps.insert("steer", Value::Bool(true));
    caps.insert("steeringMode", Value::from("interrupt-restart"));
    caps.insert("interruptCascades", Value::Bool(false));
    caps.insert("resume", Value::Bool(false));
    caps.insert("fork", Value::Bool(false));
    caps.insert("subagentTranscripts", Value::Bool(false));
    caps.insert("backgroundTaskControl", Value::Bool(false));
    caps.insert("backgroundVisibility", Value::from("partial"));
    caps.insert("planMode", Value::Bool(false));
    caps.insert("tokenUsage", Value::Bool(false));
    caps.insert("imageInput", Value::Bool(false));
    caps.insert("rewindFiles", Value::Bool(false));
    caps
}

/// Session-level quirks descriptor (`quirks/types.ts`, `quirks/generic.ts`, `quirks/antigravity.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AcpSessionQuirks {
    pub kind: SessionQuirksKind,
    pub command: String,
    pub args: Vec<String>,
    pub experimental: bool,
    pub client_meta: Map,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionQuirksKind {
    Generic,
    Antigravity,
    Extension,
}

impl SessionQuirksKind {
    pub fn to_translate(self) -> QuirksKind {
        match self {
            SessionQuirksKind::Generic => QuirksKind::Generic,
            SessionQuirksKind::Antigravity => QuirksKind::Antigravity,
            SessionQuirksKind::Extension => QuirksKind::Extension,
        }
    }

    pub fn provider(self) -> &'static str {
        self.to_translate().provider()
    }
}

impl AcpSessionQuirks {
    /// Generic ACP quirks (`quirks/generic.ts`).
    pub fn generic() -> Self {
        Self {
            kind: SessionQuirksKind::Generic,
            command: String::new(),
            args: Vec::new(),
            experimental: false,
            client_meta: Map::new(),
        }
    }

    /// Antigravity ACP quirks (`quirks/antigravity.ts`).
    pub fn antigravity() -> Self {
        Self {
            kind: SessionQuirksKind::Antigravity,
            command: "agy_acp_server".to_owned(),
            args: Vec::new(),
            experimental: true,
            client_meta: Map::new(),
        }
    }

    pub fn provider(&self) -> &'static str {
        self.kind.provider()
    }

    pub fn translate_kind(&self) -> QuirksKind {
        self.kind.to_translate()
    }

    /// Baseline capabilities before `initialize` negotiation (`quirks/{generic,antigravity}.ts`).
    pub fn capabilities(&self, version: Option<&str>) -> Map {
        let mut caps = base_capabilities();
        match self.kind {
            SessionQuirksKind::Generic | SessionQuirksKind::Extension => {
                caps.insert(
                    "launchOptions",
                    Value::Array(vec![Value::from("effort")].into()),
                );
            }
            SessionQuirksKind::Antigravity => {
                let supported = admits_antigravity_version(version);
                caps.insert("resume", Value::Bool(supported));
                caps.insert("imageInput", Value::Bool(supported));
                let launch = if supported {
                    vec![Value::from("effort")]
                } else {
                    Vec::new()
                };
                caps.insert("launchOptions", Value::Array(launch.into()));
            }
        }
        caps
    }
}

#[cfg(test)]
mod tests {
    use std::cmp::Ordering;

    use super::{
        AcpSessionQuirks, CliVersion, admits_antigravity_version, compare_cli_versions,
        parse_cli_version,
    };
    use ace_json::Value;

    #[test]
    fn parse_cli_version_matches_ts_version_grammar() {
        type ParseCase<'a> = (&'a str, Option<(u64, u64, u64, &'a [&'a str])>);
        let cases: &[ParseCase<'_>] = &[
            ("2.1.286 (Claude Code)", Some((2, 1, 286, &[]))),
            ("codex-cli 0.159.1", Some((0, 159, 1, &[]))),
            ("opencode v2.0.22", Some((2, 0, 22, &[]))),
            ("agy 1.2.1", Some((1, 2, 1, &[]))),
            ("1.2", Some((1, 2, 0, &[]))),
            ("0.85.1-beta.1+build.9", Some((0, 85, 1, &["beta", "1"]))),
            ("not a version", None),
            ("1.2.3.4", None),
            ("foo1.2.3", None),
            ("", None),
        ];
        for &(input, expected) in cases {
            let actual = parse_cli_version(input);
            let expected = expected.map(|(major, minor, patch, pre)| CliVersion {
                major,
                minor,
                patch,
                prerelease: pre.iter().map(|s| (*s).to_owned()).collect(),
            });
            assert_eq!(actual, expected, "input={input:?}");
        }
    }

    #[test]
    fn compare_cli_versions_orders_prereleases_before_release() {
        let cases: &[(&str, &str, Ordering)] = &[
            ("0.85.1-beta.1", "0.85.1", Ordering::Less),
            ("0.85.1-beta.1", "0.85.1-beta.2", Ordering::Less),
            ("0.85.1-2", "0.85.1-10", Ordering::Less),
            ("0.85.1-1", "0.85.1-alpha", Ordering::Less),
            ("1.2.1", "1.2.1", Ordering::Equal),
            ("1.2.2", "1.2.1", Ordering::Greater),
        ];
        for &(left, right, expected) in cases {
            let Some(a) = parse_cli_version(left) else {
                panic!("failed to parse {left}");
            };
            let Some(b) = parse_cli_version(right) else {
                panic!("failed to parse {right}");
            };
            assert_eq!(compare_cli_versions(&a, &b), expected, "{left} vs {right}");
        }
    }

    #[test]
    fn antigravity_quirks_gate_resume_image_and_effort_on_min_version() {
        let quirks = AcpSessionQuirks::antigravity();
        let cases: &[(Option<&str>, bool)] = &[
            (None, false),
            (Some("not-a-version"), false),
            (Some("1.2.0"), false),
            (Some("1.2.1-beta.1"), false),
            (Some("1.2.1"), true),
            (Some("agy 1.3.0"), true),
        ];
        for &(version, supported) in cases {
            assert_eq!(admits_antigravity_version(version), supported);
            let caps = quirks.capabilities(version);
            assert_eq!(caps.get("resume"), Some(&Value::Bool(supported)));
            assert_eq!(caps.get("imageInput"), Some(&Value::Bool(supported)));
            let expected_launch = if supported { 1 } else { 0 };
            assert_eq!(
                caps.get("launchOptions")
                    .and_then(Value::as_array)
                    .map(|a| a.len()),
                Some(expected_launch)
            );
        }
    }
}
