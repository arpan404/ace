// SPDX-License-Identifier: Apache-2.0
//! Bounded, redacted stderr tail and plain failure messages.
//! Ported from `packages/git/src/failure-text.ts` (G2a, ADR 0224 §8a rule 3).

use std::collections::VecDeque;
use std::sync::OnceLock;

use ace_json::JsString;
use regex::Regex;

use crate::core::error::GitErrorCode;

/// Bytes of stderr retained per call.
const KEPT_BYTES: usize = 16_384;
/// UTF-16 code units of stderr reported.
const REPORTED_CHARACTERS: usize = 4_000;
const MAX_INPUT_CHARS: usize = 65_536;
const MAX_OUTPUT_CHARS: usize = 262_144;

/// The last bytes a failing Git process wrote to stderr, bounded however much it writes.
#[derive(Default)]
pub struct StderrTail {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    /// Older bytes were dropped mid-line: the window's first line is the end of a longer one.
    partial: bool,
}

impl StderrTail {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn accept(&mut self, chunk: &[u8]) {
        if chunk.len() > KEPT_BYTES {
            let cut = chunk.len() - KEPT_BYTES;
            self.chunks.clear();
            self.chunks.push_back(chunk[cut..].to_vec());
            self.bytes = KEPT_BYTES;
            self.dropped(chunk.get(cut - 1).copied());
            return;
        }
        self.chunks.push_back(chunk.to_vec());
        self.bytes += chunk.len();
        while self.chunks.len() > 1 {
            let first_len = self.chunks.front().map_or(0, Vec::len);
            if self.bytes - first_len < KEPT_BYTES {
                break;
            }
            if let Some(first) = self.chunks.pop_front() {
                self.bytes -= first.len();
                self.dropped(first.last().copied());
            }
        }
    }

    fn dropped(&mut self, byte: Option<u8>) {
        self.partial = !matches!(byte, Some(b'\n' | b'\r'));
    }

    /// What Git said, minus Trace2 records, with credentials redacted.
    /// Redacts the whole window BEFORE dropping the partial first line and clipping.
    pub fn text(&self) -> JsString {
        let mut raw = Vec::with_capacity(self.bytes);
        for chunk in &self.chunks {
            raw.extend_from_slice(chunk);
        }
        let decoded = String::from_utf8_lossy(&raw).replace('\r', "\n");
        let redacted = redact_stderr(&decoded);
        let mut lines = redacted.split('\n');
        if self.partial {
            let _ = lines.next();
        }
        let said: Vec<&str> = lines
            .filter(|line| !line.trim().is_empty() && !line.contains("{\"event\""))
            .collect();
        let joined = said.join("\n");
        // `String.prototype.slice(-REPORTED_CHARACTERS)` counts UTF-16 units and
        // may split a surrogate pair, so the tail keeps its units, not its chars.
        let text = JsString::from(joined.as_str());
        let end = text.len_utf16();
        text.slice_units(end.saturating_sub(REPORTED_CHARACTERS), end)
    }
}

/// One plain sentence for a failed command's cause (`failureMessage` in `failure-text.ts`).
pub const fn failure_message(code: GitErrorCode) -> &'static str {
    match code {
        GitErrorCode::ObjectsNotAvailable => "Objects not available locally",
        GitErrorCode::BranchCheckedOut => "The branch is already checked out in another worktree",
        GitErrorCode::PathExists => "The worktree path already exists",
        GitErrorCode::RefConflict => "The branch name conflicts with an existing branch",
        GitErrorCode::UnbornHead => "The repository has no commits yet",
        GitErrorCode::IdentityMissing => "Git has no author name or email configured",
        GitErrorCode::NothingToCommit => "There is nothing to commit",
        GitErrorCode::PushRejected => {
            "The remote has commits this branch does not; pull or rebase first"
        }
        GitErrorCode::ProtectedBranch => "The remote refused the push: the branch is protected",
        GitErrorCode::PushLeaseStale => {
            "The remote branch moved past the leased revision; fetch and review first"
        }
        GitErrorCode::PathOutsideRepo => "Path is outside the repository",
        GitErrorCode::NoUpstream => "This repository has no remote to fetch from",
        GitErrorCode::StagedMeanwhile => "Something was staged meanwhile. Review and commit again.",
        GitErrorCode::PrivatePathStaged => {
            "ace's own Recently deleted files are staged; unstage them before committing"
        }
        _ => "Git command failed",
    }
}

struct RedactPatterns {
    credentials: Vec<(Regex, bool)>,
    file_home: Regex,
    unix_home: Regex,
    mac_temp: Regex,
    identifying_keys: Regex,
    email: Regex,
    secret_key: Regex,
}

fn compile(pat: &str) -> Option<Regex> {
    Regex::new(pat).ok()
}

fn redact_patterns() -> Option<&'static RedactPatterns> {
    static PATS: OnceLock<Option<RedactPatterns>> = OnceLock::new();
    PATS.get_or_init(|| {
        let credentials = vec![
            (compile(r"(?-u:\b)AIza[A-Za-z0-9_-]{35}")?, false),
            (compile(r"(?-u:\b)xox[baprs]-[A-Za-z0-9-]{10,}")?, false),
            (compile(r"(?-u:\b)npm_[A-Za-z0-9]{20,}")?, false),
            (compile(r"(?-u:\b)(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}")?, false),
            (compile(r"(?-u:\b)github_pat_[A-Za-z0-9_]{16,}")?, false),
            (compile(r"(?-u:\b)AKIA[A-Z0-9]{16}(?-u:\b)")?, false),
            (compile(r"(?-u:\b)sk-[A-Za-z0-9_-]{16,}")?, false),
            (compile(r"(?-u:\b)gh[opsur]_[A-Za-z0-9]{20,}")?, false),
            (
                compile(r"(?-u:\b)eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")?,
                false,
            ),
            (compile(r"(?-u:\b)eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{43,}")?, false),
            (compile(r"(?-u:\b)ace\.grant\.[A-Za-z0-9_.-]+")?, false),
            (compile(r"(?i)(?-u:\b)(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]+")?, false),
            (
                compile(
                    r#"(?is)(?-u:\b)(?:token|secret|password|api[_-]?key|authorization|cookie|credential|ticket|pairing[_-]?code)\s*[=:]\s*(?:"(?:[^"\\]|\\.?)*(?:"|$)|'(?:[^'\\]|\\.?)*(?:'|$))"#,
                )?,
                false,
            ),
            (
                compile(r"(?i)(?-u:\b)(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+")?,
                false,
            ),
            (compile(r"(?i)([#&](?:code|ticket|token)=)[^&#\s]+")?, true),
        ];
        Some(RedactPatterns {
            credentials,
            file_home: compile(r#"(?i)((?-u:\b)file://[^/\s"'<>]*)/(?:Users|home)/[^/\s"'<>?#]+"#)?,
            unix_home: compile(r#"/(?:Users|home)/[^/\s"'<>]+"#)?,
            mac_temp: compile(r#"/(?:private/)?var/folders/[^/\s"'<>]+/[^/\s"'<>]+/[TC]/"#)?,
            identifying_keys: compile(
                r#""(installationId|deviceId|accountId|account_uuid|userId|user_id|organizationId|organization_uuid|orgId)":"[^"]*""#,
            )?,
            email: compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")?,
            secret_key: compile(
                r"(?i)token|secret|password|api[_-]?key|authorization|cookie|credential|ticket|pairing[_-]?code|encryptedContent|grant$|^standing$|proof$",
            )?,
        })
    })
    .as_ref()
}

#[derive(Debug, Clone)]
struct Span {
    start: usize,
    end: usize,
    replacement: &'static str,
}

/// Redact credentials, paths, emails, and IDs from literal stderr text,
/// matching `@ace/redaction`'s `createTextRedactor({})`.
pub fn redact_stderr(text: &str) -> String {
    if text.encode_utf16().count() > MAX_INPUT_CHARS {
        return "<OVERSIZED REDACTED>".to_owned();
    }
    let Some(pats) = redact_patterns() else {
        return "<REDACTION FAILED: TEXT OMITTED>".to_owned();
    };
    let mut out = apply_credential_spans(text, pats);
    out = pats.file_home.replace_all(&out, "${1}<HOME>").into_owned();
    out = replace_unix_home(&out, &pats.unix_home);
    out = pats.mac_temp.replace_all(&out, "<TEMP>/").into_owned();
    out = pats
        .identifying_keys
        .replace_all(&out, r#""${1}":"<ID>""#)
        .into_owned();
    out = replace_emails(&out, &pats.email);
    if out.encode_utf16().count() > MAX_OUTPUT_CHARS {
        return "<OVERSIZED REDACTED>".to_owned();
    }
    out
}

fn apply_credential_spans(text: &str, pats: &RedactPatterns) -> String {
    let mut spans: Vec<Span> = Vec::new();
    for (regex, keep_group1) in &pats.credentials {
        if *keep_group1 {
            for caps in regex.captures_iter(text) {
                if let (Some(full), Some(prefix)) = (caps.get(0), caps.get(1)) {
                    let start = prefix.end();
                    if start < full.end() {
                        spans.push(Span {
                            start,
                            end: full.end(),
                            replacement: "<SECRET>",
                        });
                    }
                }
            }
        } else {
            for m in regex.find_iter(text) {
                spans.push(Span {
                    start: m.start(),
                    end: m.end(),
                    replacement: "<SECRET>",
                });
            }
        }
    }
    collect_json_credential_spans(text, &pats.secret_key, &mut spans);
    if spans.is_empty() {
        return text.to_owned();
    }
    spans.sort_by_key(|s| (s.start, std::cmp::Reverse(s.end)));
    let mut merged: Vec<Span> = Vec::with_capacity(spans.len());
    for span in spans {
        if let Some(last) = merged.last_mut()
            && span.start < last.end
        {
            if span.end > last.end {
                last.end = span.end;
                last.replacement = "<SECRET>";
            }
            continue;
        }
        merged.push(span);
    }
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    for span in merged {
        out.push_str(&text[cursor..span.start]);
        out.push_str(span.replacement);
        cursor = span.end;
    }
    out.push_str(&text[cursor..]);
    out
}

fn collect_json_credential_spans(text: &str, secret_key: &Regex, out: &mut Vec<Span>) {
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'"' {
            i += 1;
            continue;
        }
        let key_start = i + 1;
        let mut j = key_start;
        let mut escaped = false;
        while j < bytes.len() {
            if escaped {
                escaped = false;
                j += 1;
                continue;
            }
            if bytes[j] == b'\\' {
                escaped = true;
                j += 1;
                continue;
            }
            if bytes[j] == b'"' {
                break;
            }
            j += 1;
        }
        if j >= bytes.len() {
            break;
        }
        let key = &text[key_start..j];
        let mut colon = j + 1;
        while colon < bytes.len() && bytes[colon].is_ascii_whitespace() {
            colon += 1;
        }
        if colon < bytes.len() && bytes[colon] == b':' && secret_key.is_match(key) {
            let mut val = colon + 1;
            while val < bytes.len() && bytes[val].is_ascii_whitespace() {
                val += 1;
            }
            if val < bytes.len() && bytes[val] == b'"' {
                let mut end = val + 1;
                let mut esc = false;
                while end < bytes.len() {
                    if esc {
                        esc = false;
                        end += 1;
                        continue;
                    }
                    if bytes[end] == b'\\' {
                        esc = true;
                        end += 1;
                        continue;
                    }
                    if bytes[end] == b'"' {
                        break;
                    }
                    end += 1;
                }
                if end > val + 1 {
                    out.push(Span {
                        start: val + 1,
                        end,
                        replacement: "<SECRET>",
                    });
                }
                i = end.saturating_add(1);
                continue;
            }
        }
        i = j + 1;
    }
}

fn replace_unix_home(text: &str, regex: &Regex) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut last = 0usize;
    for m in regex.find_iter(text) {
        let blocked = m.start() > 0 && {
            let prev = bytes[m.start() - 1];
            prev.is_ascii_alphanumeric() || matches!(prev, b'_' | b'.' | b'/' | b'\\' | b'-')
        };
        if blocked {
            continue;
        }
        out.push_str(&text[last..m.start()]);
        out.push_str("<HOME>");
        last = m.end();
    }
    out.push_str(&text[last..]);
    out
}

fn replace_emails(text: &str, regex: &Regex) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut last = 0usize;
    for m in regex.find_iter(text) {
        let blocked = m.start() > 0 && {
            let prev = bytes[m.start() - 1];
            prev.is_ascii_alphanumeric() || matches!(prev, b'.' | b'_' | b'%' | b'+' | b'-')
        };
        if blocked {
            continue;
        }
        let matched = m.as_str();
        if matched == "recorder@ace.invalid" || matched == "noreply@anthropic.com" {
            continue;
        }
        out.push_str(&text[last..m.start()]);
        out.push_str("<EMAIL>");
        last = m.end();
    }
    out.push_str(&text[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_before_dropping_partial_first_line_and_filters_trace2() {
        let mut tail = StderrTail::new();
        let padding = "x".repeat(KEPT_BYTES + 100);
        tail.accept(padding.as_bytes());
        tail.accept(
            b"secret=supersecret\n{\"event\":\"start\"}\nfatal: /Users/alice/repo token=ghp_1234567890123456789012\n",
        );
        let text = tail.text();
        assert!(!text.contains("supersecret"));
        assert!(!text.contains("{\"event\""));
        assert!(!text.contains("/Users/alice"));
        assert!(!text.contains("ghp_1234567890123456789012"));
        assert!(text.contains("<HOME>/repo"));
        assert!(text.contains("<SECRET>"));
    }

    #[test]
    fn a_secret_after_a_non_ascii_letter_is_redacted_like_javascript_boundaries() {
        // JavaScript's \b is ASCII-only: the accented letter ends the word before
        // `token=`. A Unicode-aware boundary sees one word and leaks the value.
        for text in [
            "\u{e9}token=s3cret",
            "\u{e9}secret: s3cret",
            "\u{e9}github_pat_abcdefghijklmnopqrst",
        ] {
            let redacted = redact_stderr(text);
            assert!(!redacted.contains("s3cret"), "{text} -> {redacted}");
            assert!(
                !redacted.contains("abcdefghijklmnopqrst"),
                "{text} -> {redacted}"
            );
        }
    }

    #[test]
    fn the_reported_tail_counts_utf16_units_and_may_split_a_pair() {
        let mut tail = StderrTail::new();
        // A two-unit character first, then ASCII: 4,001 units, so `slice(-4000)`
        // starts on the pair's low surrogate, exactly as JavaScript's does.
        let mut text = String::from('\u{1F600}');
        text.push_str(&"x".repeat(REPORTED_CHARACTERS - 1));
        tail.accept(text.as_bytes());
        let reported = tail.text();
        assert_eq!(reported.len_utf16(), REPORTED_CHARACTERS);
        // Slice(-4000) starts on the pair's high surrogate: the same units as TS.
        assert!(!reported.is_well_formed());
        assert!(reported.as_str().ends_with('x'));
    }

    #[test]
    fn failure_messages_match_typescript() {
        assert_eq!(
            failure_message(GitErrorCode::ProtectedBranch),
            "The remote refused the push: the branch is protected"
        );
        assert_eq!(
            failure_message(GitErrorCode::GitFailed),
            "Git command failed"
        );
    }
}
