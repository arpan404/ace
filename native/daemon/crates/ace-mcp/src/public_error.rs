// SPDX-License-Identifier: Apache-2.0
//! The public failure vocabulary, ported from `packages/mcp-server/src/public-error.ts` and
//! `tool-failure.ts`.
//!
//! Every agent-facing failure is authored by ace: a fixed code, the catalog's message and next
//! step, and optionally where the schema was wrong (never the value that was sent). Anything else
//! is private: the agent gets only the record id a person can look up.

use ace_json::{JsString, Map, Value};

use crate::catalog::catalog;
use crate::result::CallToolResult;

/// A log correlation id (`ErrorId`): opaque, short, never the failure's text.
const MAX_ERROR_ID_CHARS: usize = 64;
/// `detail`'s bound, counted in UTF-16 units as `.slice(0, 256)` does (rule 17).
const MAX_DETAIL_UNITS: usize = 256;
/// One issue's path and expectation.
const MAX_ISSUE_PATH_CHARS: usize = 160;
const MAX_ISSUE_EXPECTED_CHARS: usize = 240;
const MAX_ISSUES: usize = 16;
const MAX_CANDIDATES: usize = 128;
/// A dispatch outcome, when part of the work may have run.
pub const PHASES: [&str; 3] = ["rejected-before-dispatch", "dispatched", "partial"];

/// A field-level problem: where, and what the schema expects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicIssue {
    pub path: String,
    pub expected: String,
}

/// One window an ambiguous target could have meant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub window_id: u32,
}

/// A device permission a failure names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    ScreenRecording,
    Accessibility,
}

/// An origin that blocked the work, as the provider reported it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Blocked {
    pub origin: String,
    pub reason: BlockedReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockedReason {
    ApprovalRequired,
    Timeout,
    InvalidOrigin,
}

/// An authored failure: its code's words, plus what the call site knows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicToolError {
    pub code: String,
    pub message: String,
    pub hint: String,
    pub detail: Option<String>,
    pub phase: Option<String>,
    pub candidates: Option<Vec<Candidate>>,
    pub issues: Option<Vec<PublicIssue>>,
    pub permission: Option<Permission>,
    pub error_id: Option<String>,
    pub blocked: Option<Blocked>,
}

impl PublicToolError {
    /// `new PublicToolError(code)`: `None` for a code the catalog doesn't have.
    pub fn new(code: &str) -> Option<PublicToolError> {
        let entry = catalog().ok()?.errors.get(code)?;
        Some(PublicToolError {
            code: code.to_owned(),
            message: entry.message.clone(),
            hint: entry.hint.clone(),
            detail: None,
            phase: None,
            candidates: None,
            issues: None,
            permission: None,
            error_id: None,
            blocked: None,
        })
    }

    /// `detail`: control characters become spaces, a bearer-shaped hex run is redacted, and the
    /// text is cut to 256 UTF-16 units.
    pub fn with_detail(mut self, detail: &str) -> Self {
        let flattened: String = detail
            .chars()
            .map(|character| {
                if (character as u32) < 32 || (character as u32) == 127 {
                    ' '
                } else {
                    character
                }
            })
            .collect();
        let redacted = redact_hex(&flattened);
        self.detail = Some(truncate_utf16(&redacted, MAX_DETAIL_UNITS));
        self
    }

    /// `phase`: only a dispatch phase the schema names is kept.
    pub fn with_phase(mut self, phase: &str) -> Self {
        if PHASES.contains(&phase) {
            self.phase = Some(phase.to_owned());
        }
        self
    }

    /// `candidates`: only an ambiguous window failure carries them, at most 128.
    pub fn with_candidates(mut self, candidates: Vec<Candidate>) -> Self {
        if self.code == "window_ambiguous" && candidates.len() <= MAX_CANDIDATES {
            self.candidates = Some(candidates);
        }
        self
    }

    /// `issues`: bounded, valid paths and expectations only; an empty list is no list.
    pub fn with_issues(mut self, issues: Vec<PublicIssue>) -> Self {
        let bounded: Vec<PublicIssue> = issues
            .into_iter()
            .filter(|issue| {
                let path = issue.path.chars().count();
                let expected = issue.expected.chars().count();
                (1..=MAX_ISSUE_PATH_CHARS).contains(&path)
                    && (1..=MAX_ISSUE_EXPECTED_CHARS).contains(&expected)
            })
            .take(MAX_ISSUES)
            .collect();
        if !bounded.is_empty() {
            self.issues = Some(bounded);
        }
        self
    }

    /// `permission`: only a permission failure carries one, and it picks the hint.
    pub fn with_permission(mut self, permission: Permission) -> Self {
        if self.code == "permission_denied" {
            self.permission = Some(permission);
            self.hint = match permission {
                Permission::ScreenRecording => "Open System Settings > Privacy & Security > Screen Recording and enable Ace Screen Helper.",
                Permission::Accessibility => "Open System Settings > Privacy & Security > Accessibility and enable Ace Screen Helper.",
            }
            .to_owned();
        }
        self
    }

    /// `errorId`: only an opaque short id is kept.
    pub fn with_error_id(mut self, error_id: &str) -> Self {
        let valid = !error_id.is_empty()
            && error_id.chars().count() <= MAX_ERROR_ID_CHARS
            && error_id
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "_-".contains(character));
        if valid {
            self.error_id = Some(error_id.to_owned());
        }
        self
    }

    /// A blocked origin from a provider's own failure, when it named one.
    pub fn with_blocked(mut self, origin: &str, reason: BlockedReason) -> Self {
        self.blocked = Some(Blocked {
            origin: public_origin(origin),
            reason,
        });
        self
    }
}

/// Why a call failed, as the registry sees it. Boxed so a refusal and a string cost the same.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolFailure {
    /// An authored failure: its words are shown as written.
    Public(Box<PublicToolError>),
    /// Data a tool produced or read broke a schema; the detail says where, never the value.
    InvalidData(String),
    /// Anything else: private, logged by the host, represented by its record id.
    Private(String),
}

/// `toolFailure`: the agent-facing result for a failure.
pub fn tool_failure(failure: ToolFailure) -> CallToolResult {
    let public = match failure {
        ToolFailure::Public(public) => *public,
        ToolFailure::InvalidData(detail) => match PublicToolError::new("invalid_data") {
            Some(public) => public.with_detail(&detail),
            None => return CallToolResult::failure("{\"code\":\"execution_failed\"}"),
        },
        ToolFailure::Private(_) => match PublicToolError::new("execution_failed") {
            Some(public) => public,
            None => return CallToolResult::failure("{\"code\":\"execution_failed\"}"),
        },
    };
    let mut map = Map::with_capacity(9);
    map.insert("code", Value::String(JsString::from(public.code.as_str())));
    map.insert(
        "message",
        Value::String(JsString::from(public.message.as_str())),
    );
    map.insert("hint", Value::String(JsString::from(public.hint.as_str())));
    if let Some(issues) = &public.issues {
        map.insert(
            "issues",
            Value::Array(
                issues
                    .iter()
                    .map(|issue| {
                        let mut entry = Map::with_capacity(2);
                        entry.insert("path", Value::String(JsString::from(issue.path.as_str())));
                        entry.insert(
                            "expected",
                            Value::String(JsString::from(issue.expected.as_str())),
                        );
                        Value::Object(entry)
                    })
                    .collect::<Vec<_>>()
                    .into(),
            ),
        );
    }
    if let Some(detail) = &public.detail {
        map.insert("detail", Value::String(JsString::from(detail.as_str())));
    }
    if let Some(phase) = &public.phase {
        map.insert("phase", Value::String(JsString::from(phase.as_str())));
    }
    if let Some(candidates) = &public.candidates {
        map.insert(
            "candidates",
            Value::Array(
                candidates
                    .iter()
                    .map(|candidate| {
                        let mut entry = Map::with_capacity(1);
                        entry.insert("windowId", Value::from(f64::from(candidate.window_id)));
                        Value::Object(entry)
                    })
                    .collect::<Vec<_>>()
                    .into(),
            ),
        );
    }
    if let Some(permission) = public.permission {
        let text = match permission {
            Permission::ScreenRecording => "screenRecording",
            Permission::Accessibility => "accessibility",
        };
        map.insert("permission", Value::from(text));
    }
    if let Some(error_id) = &public.error_id {
        map.insert("errorId", Value::String(JsString::from(error_id.as_str())));
    }
    if let Some(blocked) = &public.blocked {
        let mut entry = Map::with_capacity(2);
        entry.insert(
            "origin",
            Value::String(JsString::from(blocked.origin.as_str())),
        );
        let reason = match blocked.reason {
            BlockedReason::ApprovalRequired => "approval_required",
            BlockedReason::Timeout => "timeout",
            BlockedReason::InvalidOrigin => "invalid_origin",
        };
        entry.insert("reason", Value::from(reason));
        map.insert("blocked", Value::Object(entry));
    }
    CallToolResult::failure(ace_json::to_string(&Value::Object(map)))
}

/// The fixed failure for a code the catalog has: registry decisions use this.
pub fn fixed_failure(code: &str) -> CallToolResult {
    match PublicToolError::new(code) {
        Some(public) => tool_failure(ToolFailure::Public(Box::new(public))),
        None => CallToolResult::failure("{\"code\":\"execution_failed\"}"),
    }
}

/// Arguments too large to read: the agent can send less, so the reason is public.
pub fn input_too_large(max_bytes: usize) -> PublicToolError {
    let public = PublicToolError::new("limit").unwrap_or_else(|| PublicToolError {
        code: "limit".to_owned(),
        message: "The request exceeds a limit".to_owned(),
        hint: String::new(),
        detail: None,
        phase: None,
        candidates: None,
        issues: None,
        permission: None,
        error_id: None,
        blocked: None,
    });
    public.with_detail(&format!(
        "The arguments exceed {} KiB as JSON. Send less in one call.",
        max_bytes / 1024
    ))
}

/// A URL reduced to its origin, with bearer-shaped runs redacted; anything unusable says so.
fn public_origin(raw: &str) -> String {
    let Some((scheme, rest)) = raw.split_once("://") else {
        return "invalid origin".to_owned();
    };
    if scheme != "http" && scheme != "https" {
        return "invalid origin".to_owned();
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') {
        return "invalid origin".to_owned();
    }
    redact_hex(&format!("{scheme}://{authority}"))
}

/// `replace(/[a-f0-9]{64}/gi, "[redacted]")`.
fn redact_hex(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < bytes.len() {
        let are_hex = at + 64 <= bytes.len()
            && bytes[at..at + 64]
                .iter()
                .all(|byte| byte.is_ascii_hexdigit());
        if are_hex {
            out.push_str("[redacted]");
            at += 64;
            continue;
        }
        let character = text[at..].chars().next().unwrap_or('\u{fffd}');
        out.push(character);
        at += character.len_utf8();
    }
    out
}

/// `.slice(0, units)` over UTF-16 units: a cut surrogate pair becomes U+FFFD, as JS text does.
fn truncate_utf16(text: &str, units: usize) -> String {
    let encoded: Vec<u16> = text.encode_utf16().collect();
    if encoded.len() <= units {
        return text.to_owned();
    }
    String::from_utf16_lossy(&encoded[..units])
}

#[cfg(test)]
mod tests {
    // Ported from `public-error.ts`'s contract and the cases `actionable-errors` and
    // `agent-errors` rely on: the class, its detail sanitizing and the JSON bytes of a failure.
    use super::*;

    #[test]
    fn a_public_failure_carries_the_catalogs_words_in_order() {
        let failure = fixed_failure("tool_unavailable");
        assert!(failure.is_error);
        let text = &failure.content[0].text;
        let value = ace_json::parse(text).expect("json");
        assert_eq!(
            value.get("code").and_then(Value::as_str),
            Some("tool_unavailable")
        );
        let words = catalog()
            .expect("catalog")
            .errors
            .get("tool_unavailable")
            .expect("words");
        assert_eq!(
            value.get("message").and_then(Value::as_str),
            Some(words.message.as_str())
        );
        assert!(value.get("hint").and_then(Value::as_str).is_some());
    }

    #[test]
    fn a_detail_is_flattened_redacted_and_cut_to_256_utf16_units() {
        let detail = format!("line\n\u{7}{} {}", "a".repeat(64), "z".repeat(300));
        let public = PublicToolError::new("execution_failed")
            .expect("code")
            .with_detail(&detail);
        let kept = public.detail.expect("detail");
        assert!(!kept.contains('\n'));
        assert!(!kept.contains('\u{7}'));
        assert!(kept.contains("[redacted]"));
        assert_eq!(kept.encode_utf16().count(), 256);
        // A cut surrogate pair becomes U+FFFD rather than invalid text.
        let emoji = PublicToolError::new("execution_failed")
            .expect("code")
            .with_detail(&"😀".repeat(200));
        assert!(emoji.detail.expect("detail").encode_utf16().count() == 256);
    }

    #[test]
    fn only_an_ambiguous_window_failure_keeps_candidates_and_only_a_denial_keeps_permission() {
        let candidates = vec![Candidate { window_id: 7 }];
        assert!(
            PublicToolError::new("window_ambiguous")
                .expect("code")
                .with_candidates(candidates.clone())
                .candidates
                .is_some()
        );
        assert!(
            PublicToolError::new("not_found")
                .expect("code")
                .with_candidates(candidates)
                .candidates
                .is_none()
        );
        let denied = PublicToolError::new("permission_denied")
            .expect("code")
            .with_permission(Permission::Accessibility);
        assert_eq!(denied.permission, Some(Permission::Accessibility));
        assert!(denied.hint.contains("Accessibility"));
        assert!(
            PublicToolError::new("not_found")
                .expect("code")
                .with_permission(Permission::Accessibility)
                .permission
                .is_none()
        );
    }

    #[test]
    fn an_issue_list_is_bounded_and_dropped_when_empty() {
        let issues = vec![
            PublicIssue {
                path: "value".to_owned(),
                expected: "string".to_owned(),
            },
            PublicIssue {
                path: String::new(),
                expected: "string".to_owned(),
            },
        ];
        let public = PublicToolError::new("invalid_arguments")
            .expect("code")
            .with_issues(issues);
        assert_eq!(public.issues.expect("issues").len(), 1);
        assert!(
            PublicToolError::new("invalid_arguments")
                .expect("code")
                .with_issues(vec![])
                .issues
                .is_none()
        );
    }

    #[test]
    fn a_private_failure_is_execution_failed_and_carries_only_its_record_id() {
        let failure = tool_failure(ToolFailure::Private("secret text".to_owned()));
        let text = &failure.content[0].text;
        assert!(!text.contains("secret"));
        assert!(text.contains("\"execution_failed\""));
        let reported = tool_failure(ToolFailure::Public(Box::new(
            PublicToolError::new("execution_failed")
                .expect("code")
                .with_error_id("rec_1"),
        )));
        assert!(reported.content[0].text.contains("\"errorId\":\"rec_1\""));
        // A malformed record id is dropped.
        let bad = PublicToolError::new("execution_failed")
            .expect("code")
            .with_error_id("has space");
        assert!(bad.error_id.is_none());
    }

    #[test]
    fn a_blocked_origin_is_reduced_to_its_scheme_and_host() {
        let public = PublicToolError::new("invalid_origin")
            .expect("code")
            .with_blocked("https://example.test/path", BlockedReason::Timeout);
        let blocked = public.blocked.expect("blocked");
        assert_eq!(blocked.origin, "https://example.test");
        assert_eq!(
            public_origin("https://user:pass@example.test"),
            "invalid origin"
        );
        assert_eq!(public_origin("file:///tmp/x"), "invalid origin");
        assert_eq!(
            public_origin(&format!("https://{}/x", "a".repeat(64))),
            "https://[redacted]"
        );
    }

    #[test]
    fn an_unknown_code_has_no_words() {
        assert!(PublicToolError::new("not_a_code").is_none());
    }
}
